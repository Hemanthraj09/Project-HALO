# HALO

**Live dashboard for first responder teams.** Monitors HR, SpO₂, CO, falls, GPS via ESP32 wearables → Gateway → Firebase → React dashboard. Simulates hardware for development.

## 🎯 Features

- **Real-time vitals**: HR, SpO₂, temperature, PSI (physiological stress index)
- **Environmental hazards**: CO (ppm + 15-min TWA), AQI (MQ135), GPS tracking
- **Fall detection**: Accelerometer-based (2.5g threshold)
- **Smart alerting**: P0 mayday (fall/CO>200/SpO₂<90), P1 warning, P2 nominal
- **Tactical dashboard**: Live map, sparklines, analytics tab, priority feed
- **Firebase Realtime DB**: Zero-config live sync across devices
- **Hardware simulator**: Full 5-min scenario loop (CO spike → fall → recovery)

## 📁 Structure

```
HALO/                          # Current dir (c:/Users/Kush/Downloads/HALO)
├── README.md                 # This file
├── halo-backend/             # Python FastAPI server
│   ├── backend.py            # Serial → Firebase + REST API
│   ├── simulator.py          # Fake ESP32 gateway (POST /ingest)
│   └── serviceAccountKey.json # Download from Firebase Console → Project Settings → Service Accounts
└── halo-dashboard/           # React dashboard (npm start)
    ├── package.json
    ├── public/index.html
    └── src/
        ├── App.js           # Full dashboard (~800 lines)
        └── index.js
```

## 🚀 Quick Start (3 Terminals, No Hardware Needed)

### 1. Backend (Terminal 1)
```bash
cd halo-backend
pip install fastapi uvicorn pyserial firebase-admin websockets
python backend.py
```
- Listens on `http://localhost:8000`
- Expects `serviceAccountKey.json` (see Firebase Setup)
- Serial retry loop for COM_PORT (hardware optional)

### 2. Simulator (Terminal 2)
```bash
cd halo-backend
python simulator.py
```
- Generates realistic data: HR 72→110 bpm, SpO₂ 98→91%, CO 10→230 ppm, fall event
- 5-min scenario loop → POST /ingest → Firebase
- Prints live: `[P0] HALO-01 | HR:105 SpO2:92 CO:230 PSI:5.2 TWA:145`

### 3. Dashboard (Terminal 3)
```bash
cd halo-dashboard
npm install
npm start
```
- Opens `http://localhost:3000`
- Live sync via Firebase (map, charts, alerts)

**Expected:** Dashboard shows "1 ACTIVE", "1 CRITICAL" during CO/fall, map marker at Bangalore (12.9716°N, 77.5946°E), alert feed.


## Firebase Database structure:
```
live/HALO-01                    # Latest reading (overwritten)
readings/HALO-01/-ABC123        # History (appended)
alerts/HALO-01/-XYZ789          # Responder alerts
alerts/-GLOBAL123               # Global feed
```

## 🧪 Simulator Scenario (Loops Every 5 Min)

| 0:00-2:00 | **P2 NOMINAL** | HR~74, SpO₂~98%, CO~10ppm |
| 2:00-3:00 | **P1 WARNING** | CO→90ppm, HR→88 |
| 3:00-3:30 | **P0 MAYDAY**  | CO→230ppm, SpO₂→92% |
| 3:30-4:00 | **P0 FALL**    | Accel 3.8g → 0.1g stillness |
| 4:00-5:00 | **P2 RECOVERY**| All normal |

## 🔌 Hardware Integration (When Ready)

1. **Arm ESP32**: MAX30102 (HR/SpO₂) + battery
2. **Chest ESP32**: MQ7 (CO), MQ135 (AQI), MPU6050 (accel), NEO-6M GPS, LoRa TX
3. **Gateway ESP32**: LoRa RX → USB serial (JSON packets)
4. Update `COM_PORT = "COM5"` in `backend.py` (Device Manager)
5. Stop simulator → Real data flows

**Gateway serial format:**
```json
{"id":"HALO-01","priority":0,"hr":105,"spo2":92,"co":230,"aq":200,"accel":3.8,"fall":true,"lat":12.9716,"lon":77.5946}
```

---
*HALO — Because seconds matter.*

