"""
HALO Simulator — Firebase Edition
Generates realistic sensor data and POSTs to backend /ingest endpoint,
which writes to Firebase. Dashboard reads from Firebase in real time.

Run order:
    Terminal 1: python backend.py
    Terminal 2: python simulator.py
    Terminal 3: npm start (in dashboard folder)
"""

import time, math, random, json, urllib.request

BACKEND = "http://localhost:8000/ingest"

def noise(base, spread): return base + random.gauss(0, spread)
def clamp(v, lo, hi):    return max(lo, min(hi, v))

def send(data):
    try:
        body = json.dumps(data).encode()
        req  = urllib.request.Request(BACKEND, data=body, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=2)
    except Exception as e:
        print(f"  [!] {e} — is backend.py running?")

class Scenario:
    def __init__(self):
        self.elapsed = 0.0
        self.hr = 72.0; self.spo2 = 98.5; self.temp = 36.8
        self.co = 8.0;  self.aq   = 45.0
        self.lat = 12.97160; self.lon = 77.59460
        self.step = 0

    def phase(self):
        t = self.elapsed
        if   t < 120: return "nominal"
        elif t < 180: return "co_rising"
        elif t < 210: return "mayday_co"
        elif t < 240: return "fall"
        else:         return "recovery"

    def targets(self):
        p = self.phase()
        return {
            "nominal":   dict(hr=74,  spo2=98.5, temp=36.9, co=10,  aq=48),
            "co_rising": dict(hr=88,  spo2=97.0, temp=37.2, co=90,  aq=120),
            "mayday_co": dict(hr=105, spo2=92.0, temp=37.6, co=230, aq=200),
            "fall":      dict(hr=110, spo2=91.0, temp=37.7, co=220, aq=195),
            "recovery":  dict(hr=80,  spo2=96.0, temp=37.0, co=30,  aq=70),
        }[p]

    def tick(self, dt=1.0):
        self.elapsed += dt
        if self.elapsed >= 300:
            self.elapsed = 0.0
            print("\n[SIM] Loop restarted.\n")
        t = self.targets()
        def lerp(c, tgt, r=0.07): return c + (tgt - c) * r

        self.hr   = clamp(lerp(self.hr,   t["hr"])   + noise(0, 1.2), 50,  200)
        self.spo2 = clamp(lerp(self.spo2, t["spo2"]) + noise(0, 0.3), 80,  100)
        self.temp = clamp(lerp(self.temp, t["temp"]) + noise(0, 0.05), 35,  42)
        self.co   = clamp(lerp(self.co,   t["co"],  0.10) + noise(0, 3), 0,  400)
        self.aq   = clamp(lerp(self.aq,   t["aq"],  0.08) + noise(0, 5), 0,  500)
        self.lat  += noise(0, 0.000005)
        self.lon  += noise(0, 0.000005)
        self.step += 1

        p = self.phase()
        if p == "fall":
            pe = self.elapsed - 210
            if 2 < pe < 3:    accel, fall = noise(3.8, 0.4), True
            elif 3 <= pe < 6: accel, fall = noise(0.1, 0.05), True
            else:              accel, fall = noise(1.0, 0.15), False
        else:
            accel = 1.0 + 0.3 * math.sin(self.step * 0.4) + noise(0, 0.05)
            fall  = False

        pr = 0 if (fall or self.co > 200 or self.spo2 < 90) else 1 if (self.co > 50 or self.spo2 < 94 or self.hr > 150) else 2

        return {
            "id": "HALO-01", "priority": pr,
            "hr": round(self.hr, 1), "spo2": round(self.spo2, 1),
            "temp": round(self.temp, 2), "co": round(self.co, 1),
            "aq": round(self.aq, 1), "accel": round(accel, 3),
            "fall": fall, "lat": round(self.lat, 6), "lon": round(self.lon, 6),
            "gps_ok": True, "batt": round(clamp(95 - self.elapsed / 300 * 10, 0, 100), 1),
            "rssi": round(noise(-65, 5), 1),
        }

PHASE_LABELS = {
    "nominal":   "NOMINAL   — routine telemetry",
    "co_rising": "WARNING   — CO rising",
    "mayday_co": "MAYDAY    — CO critical",
    "fall":      "MAYDAY    — fall detected",
    "recovery":  "RECOVERY  — returning to normal",
}

if __name__ == "__main__":
    print("=" * 55)
    print("  HALO Simulator — writing to Firebase via backend")
    print("=" * 55)
    print()

    # Wait for backend
    print("Waiting for backend", end="", flush=True)
    for _ in range(15):
        try:
            urllib.request.urlopen("http://localhost:8000/health", timeout=1)
            break
        except:
            print(".", end="", flush=True)
            time.sleep(1)
    print(" OK\n")

    s = Scenario(); last_phase = None

    while True:
        r = s.tick()
        p = s.phase()
        if p != last_phase:
            print(f"\n[{int(s.elapsed):>3}s] {PHASE_LABELS[p]}")
            last_phase = p
        send(r)
        pl = ["[P0 MAYDAY ]", "[P1 WARNING]", "[P2 NOMINAL]"][r["priority"]]
        print(f"  {pl}  HR:{r['hr']:>5.1f}  SpO2:{r['spo2']:>5.1f}%  CO:{r['co']:>6.1f}ppm  PSI:computing  Fall:{str(r['fall']):<5}")
        time.sleep(1.0)
