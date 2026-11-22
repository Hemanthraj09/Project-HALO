"""
HALO Project — Python Backend (Firebase Edition)
Reads JSON from Gateway ESP32 over USB serial,
computes PSI + TWA CO, writes to Firebase Realtime DB,
and serves a REST API for the dashboard.

Install:
    pip install fastapi uvicorn pyserial firebase-admin websockets

Run:
    python backend.py

Change COM_PORT to your Gateway ESP32 port (check Device Manager).
Put serviceAccountKey.json in the same folder as this file.
"""

import serial
import json
import time
import math
import threading
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
import firebase_admin
from firebase_admin import credentials, db as firebase_db

# ─── CONFIG ────────────────────────────────────────────────────────────────
COM_PORT        = "COM3"      # Gateway ESP32 COM port
BAUD_RATE       = 115200
SERVICE_KEY     = "serviceAccountKey.json"
DATABASE_URL    = "https://halo-223051-default-rtdb.asia-southeast1.firebasedatabase.app"

# ─── FIREBASE INIT ─────────────────────────────────────────────────────────
cred = credentials.Certificate(SERVICE_KEY)
if not firebase_admin._apps:
    firebase_admin.initialize_app(cred, {"databaseURL": DATABASE_URL})

# Firebase refs
live_ref     = firebase_db.reference("live")
readings_ref = firebase_db.reference("readings")
alerts_ref   = firebase_db.reference("alerts")

# ─── APP ───────────────────────────────────────────────────────────────────
app = FastAPI(title="HALO Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ─── ANALYTICS ─────────────────────────────────────────────────────────────
HR_REST  = 70.0;  HR_MAX  = 200.0
T_REST   = 36.5;  T_MAX   = 39.5

def compute_psi(hr, temp):
    if not hr or hr < 0 or not temp or temp < 0:
        return -1.0
    hr_c   = 5.0 * (hr   - HR_REST) / (HR_MAX - HR_REST)
    temp_c = 5.0 * (temp - T_REST)  / (T_MAX  - T_REST)
    return round(min(max(hr_c + temp_c, 0), 10.0), 2)

co_history = []
TWA_WINDOW = 900  # 15 minutes

def compute_twa_co(co_ppm):
    now = time.time()
    co_history.append((now, co_ppm))
    cutoff = now - TWA_WINDOW
    while co_history and co_history[0][0] < cutoff:
        co_history.pop(0)
    if len(co_history) < 2:
        return round(co_ppm, 2)
    total_w = 0.0; total_t = 0.0
    for i in range(1, len(co_history)):
        dt      = co_history[i][0] - co_history[i-1][0]
        avg_c   = (co_history[i-1][1] + co_history[i][1]) / 2.0
        total_w += avg_c * dt
        total_t += dt
    return round(total_w / total_t, 2) if total_t > 0 else round(co_ppm, 2)

def get_alert_reasons(data):
    reasons = []
    if data.get("fall"):                                 reasons.append("FALL DETECTED")
    co = data.get("co", 0)
    if co > 200:                                         reasons.append(f"CO CRITICAL: {round(co)} ppm")
    elif co > 50:                                        reasons.append(f"CO ELEVATED: {round(co)} ppm")
    spo2 = data.get("spo2", -1)
    if 0 < spo2 < 90:                                   reasons.append(f"SpO2 CRITICAL: {round(spo2)}%")
    elif 0 < spo2 < 94:                                 reasons.append(f"SpO2 LOW: {round(spo2)}%")
    hr = data.get("hr", -1)
    if hr > 150:                                         reasons.append(f"HR HIGH: {round(hr)} bpm")
    return reasons

# ─── PROCESS + WRITE TO FIREBASE ───────────────────────────────────────────
def process_and_store(data: dict):
    ts           = datetime.now().isoformat()
    responder_id = data.get("id", "HALO-01")
    priority     = data.get("priority", 2)
    psi          = compute_psi(data.get("hr"), data.get("temp"))
    twa_co       = compute_twa_co(data.get("co", 0))

    enriched = {
        **data,
        "ts":     ts,
        "psi":    psi,
        "twa_co": twa_co,
        # Clean None values — Firebase doesn't accept None
        **{k: (v if v is not None else -1) for k, v in data.items()},
    }
    # Remove None values entirely
    enriched = {k: v for k, v in enriched.items() if v is not None}

    # 1. Update live node (overwrites, always current value)
    live_ref.child(responder_id).set(enriched)

    # 2. Push to readings history (append)
    readings_ref.child(responder_id).push(enriched)

    # 3. Log alerts if P0 or P1
    if priority <= 1:
        reasons = get_alert_reasons(data)
        for reason in reasons:
            alerts_ref.child(responder_id).push({
                "ts":           ts,
                "responder_id": responder_id,
                "priority":     priority,
                "reason":       reason,
            })
            # Also push to flat alerts node (dashboard reads this)
            alerts_ref.push({
                "ts":           ts,
                "responder_id": responder_id,
                "priority":     priority,
                "reason":       reason,
            })

    print(f"[P{priority}] {responder_id} | HR:{data.get('hr','--')} SpO2:{data.get('spo2','--')} CO:{data.get('co','--')} PSI:{psi} TWA:{twa_co}")

# ─── CSV PARSER ────────────────────────────────────────────────────────────
def parse_lora_csv(line: str):
    """
    Parses ESP32 LoRa CSV format:
    ID:HALO-01,PRI:0,LAT:12.97,LNG:77.59,ALT:10.0,HR:72.0,SPO2:98.0,
    TEMP:33.1,HUM:58.0,PRES:915.0,BALT:852.0,AX:10.02,AY:0.01,AZ:0.88,
    CO:786,AQI:398,FALL:0
    """
    try:
        pairs = line.strip().split(",")
        raw = {}
        for pair in pairs:
            if ":" not in pair:
                continue
            k, v = pair.split(":", 1)
            raw[k.strip()] = v.strip()

        # Compute accel magnitude from AX/AY/AZ
        ax = float(raw.get("AX", 0))
        ay = float(raw.get("AY", 0))
        az = float(raw.get("AZ", 0))
        accel = round(math.sqrt(ax**2 + ay**2 + az**2), 3)

        data = {
            "id":       raw.get("ID", "HALO-01"),
            "priority": int(raw.get("PRI", 2)),
            "lat":      float(raw.get("LAT", 0)),
            "lon":      float(raw.get("LNG", 0)),
            "alt":      float(raw.get("ALT", 0)),
            "hr":       float(raw.get("HR", 0)),
            "spo2":     float(raw.get("SPO2", 0)),
            "temp":     float(raw.get("TEMP", 0)),
            "hum":      float(raw.get("HUM", 0)),
            "pressure": float(raw.get("PRES", 0)),
            "bme_alt":  float(raw.get("BALT", 0)),
            "co":       float(raw.get("CO", 0)),
            "aq":       float(raw.get("AQI", 0)),
            "accel":    accel,
            "fall":     bool(int(raw.get("FALL", 0))),
        }
        return data
    except Exception as e:
        print(f"[CSV] Parse error: {e} | Line: {line}")
        return None

# ─── SERIAL READER THREAD ──────────────────────────────────────────────────
def serial_reader():
    while True:
        try:
            ser = serial.Serial(COM_PORT, BAUD_RATE, timeout=2)
            print(f"[SERIAL] Connected to {COM_PORT}")
            while True:
                try:
                    line = ser.readline().decode("utf-8", errors="ignore").strip()
                    if not line:
                        continue
                    # Skip RSSI lines from gateway
                    if line.startswith("[RSSI"):
                        continue
                    # JSON format (simulator)
                    if line.startswith("{"):
                        data = json.loads(line)
                        process_and_store(data)
                    # CSV format (LoRa gateway)
                    elif "ID:" in line and "HR:" in line:
                        data = parse_lora_csv(line)
                        if data:
                            process_and_store(data)
                except json.JSONDecodeError:
                    pass
                except Exception as e:
                    print(f"[SERIAL] Read error: {e}")
        except serial.SerialException:
            print(f"[SERIAL] {COM_PORT} not available. Retrying in 3s...")
            time.sleep(3)

threading.Thread(target=serial_reader, daemon=True).start()

# ─── REST ENDPOINTS ────────────────────────────────────────────────────────
@app.post("/ingest")
async def ingest(request: Request):
    """Accepts both JSON and plain text CSV."""
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        data = await request.json()
    else:
        body = await request.body()
        line = body.decode("utf-8", errors="ignore").strip()
        if line.startswith("{"):
            data = json.loads(line)
        else:
            data = parse_lora_csv(line)
            if not data:
                return {"ok": False, "error": "Could not parse CSV"}
    process_and_store(data)
    return {"ok": True}

@app.get("/summary")
def get_summary():
    """Session stats from Firebase live nodes."""
    snap = live_ref.get()
    if not snap:
        return {}
    return {
        rid: {
            "latest_hr":   r.get("hr"),
            "latest_spo2": r.get("spo2"),
            "latest_co":   r.get("co"),
            "latest_psi":  r.get("psi"),
            "priority":    r.get("priority"),
            "fall":        r.get("fall"),
            "batt":        r.get("batt"),
        }
        for rid, r in snap.items()
    }

@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.now().isoformat()}

# ─── ENTRY POINT ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    print("HALO Backend — Firebase Edition")
    print(f"Database: {DATABASE_URL}")
    print(f"Serial port: {COM_PORT}")
    print()
    uvicorn.run("backend:app", host="0.0.0.0", port=8000, reload=False)
