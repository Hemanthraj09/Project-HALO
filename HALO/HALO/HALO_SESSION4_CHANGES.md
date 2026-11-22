# HALO: Session 4 change log

Read alongside `HALO_SESSION3_CHANGES.md`. Where the two disagree, this file is newer. Originals of every edited file are in `_backup_before_session4_2026-11-22/` (project root).

## 1. Before you test (required)

**Flash all three boards together.** The radio packet formats changed: arm → chest is now a 60-byte versioned struct, and chest → gateway is a 62-byte binary packet. Mixed old/new firmware drops packets.

- Arduino IDE: ESP32 core **3.3.x or 4.0.0**. Every sketch compiles with 0 errors and 0 sketch warnings on 3.3.11 and 4.0.0 (board "ESP32 Dev Module"). 3.0–3.2 were not tested.
- Libraries: Adafruit MPU6050 2.2.9, Adafruit BME280 2.3.0, Adafruit Unified Sensor 1.1.15, Adafruit BusIO 1.17.4, SparkFun MAX3010x 1.1.2, TinyGPSPlus 1.0.3, LoRa (Sandeep Mistry) 0.8.0. No new libraries.
- Order: `gateway.ino`, then `chest_strap_v2.ino`, then `arm_strap_v2.ino`. Close the Serial Monitor on the gateway before starting `backend.py`.

**Battery sense wiring (new, both straps).** The ESP32s get 5 V from the MT3608, so they cannot see the battery without a sense line:
`TP4056 OUT+ → 100 kΩ → GPIO 33 → 100 kΩ → GND` (ESP32 GND), plus 100 nF from GPIO 33 to GND (recommended).
Without the divider, the battery shows "n/a"; nothing else is affected. To calibrate, compare the logged voltage with a multimeter and set `BATT_CAL` (multimeter V ÷ logged V) in each sketch. The chest also needs `BATT_LOAD_COMP_MV`: its heaters pull about 0.8 A, so the cell reads 80–150 mV low while running. Steps are in the chest sketch header (battery sense section). Until you set it, the chest % reads low.

**Dashboard: no sign-in (your decision).** The dashboard opens straight to the live view. Anyone with the database URL can read responder data. To at least block browser writes (fake alerts, deleted history), publish `database.rules.json` (public read, no client writes) in Firebase console → Realtime Database → Rules. The backend's Admin SDK is not affected. Sign-in can be switched back on later: `components/AuthGate.js` and `SignIn.js` are kept.

## 2. Run

```
cd halo-backend
pip install fastapi uvicorn pyserial firebase-admin
python backend.py                 # http://127.0.0.1:8000, gateway COM port auto-detected (HALO_COM_PORT to force)
python simulator.py               # no hardware: calm demo (same as before, now with batteries etc.)
python simulator.py --mode shift  # 30-min scenario: exertion, heat, smoke/CO, fall + no motion, recovery
cd ../halo-dashboard && npm start # http://127.0.0.1:3000
```
Run the simulator OR the hardware, not both: both report as HALO-01.

## 3. Data flow

Arm strap --ESP-NOW (1 s; at once on a fall)--> chest strap --LoRa 433 MHz (P0 1 s / P1 2 s / P2 5 s)--> gateway --USB serial text line--> `backend.py` --> Firebase --> dashboard.
The dashboard never calls the backend. It reads Firebase. The backend writes:
- `live/<id>`: latest state, plus `active_alerts` (what is happening now)
- `readings/<id>`: every packet
- `alerts/`: event log of raised / changed / ongoing (every 2 min) / cleared
- `hazards/`: CO, smoke, heat, possible fire, fall and no-motion points with GPS position, for the map
- `analytics/<id>/minutes`, `analytics/<id>/sessions`, `profiles/<id>`: performance and fitness analysis

## 4. What changed

**Arm strap**
- Battery % and voltage.
- New heart-rate/SpO₂ pipeline (band-pass filter, beat detection, motion gating, quality score). On synthetic test signals it is within 0–2 bpm; the old Maxim algorithm was off by up to 65 bpm on the same data. It now reports bradycardia below 40 and SpO₂ below 80, which the old range cut-off hid.
- Fall detection now needs an orientation change, a hard impact or a free-fall, so a knock followed by standing still no longer counts. The fall stays latched while the wearer lies still.
- New man-down timer: seconds without movement.
- Activity level (ENMO).
- CPU at 80 MHz and radio sleep between sends. Estimated about 3× longer arm battery life; measure it.
- Sensors that fail at boot are skipped; the rest keep working.

**Chest strap**
- Battery %.
- Binary LoRa packet: about 370 ms on air instead of about 940 ms.
- **LoRa health check every 2 s, with automatic re-initialisation (1 → 30 s backoff, never reboots).**
- GPS keeps the last fix but reports its age. Fixes are filtered (HDOP ≤ 3, ≥ 4 satellites, jump filter).
- CO/AQI: 32-sample trimmed mean and 2 s smoothing. ADC saturation is flagged.
- Arm-strap link status and packet loss.
- Packets are accepted only from a valid arm firmware.

**Gateway**
- Same LoRa health check and reconnect, plus a re-init after 60 s with no packets.
- Decodes the binary packet into the text line the backend reads.
- Still accepts old text packets.

**Backend**
- Binds 127.0.0.1, not 0.0.0.0. Host/Origin/Content-Type checks. Strict input validation.
- Alert state machine with per-alert severity, replacing the 20 s flood.
- New alerts: arm strap offline, link lost (watchdog), no motion, battery low, possible fire/smoke, CO sensor saturated, air quality.
- Hazards for the map. Battery runtime estimates. Per-minute and per-session analytics.
- Timestamps carry the time zone.
- Serial reader never dies.

**Dashboard**
- Light theme (all text WCAG AA contrast).
- Chest and arm battery on every card and in a new DEVICE tab.
- Link-lost responders keep their last MAYDAY visible.
- Map:
  - hazard zones (CO, smoke, heat, possible fire, fall, no motion)
  - trail coloured by CO, GPS accuracy ring, live sensing halo
  - follow mode, draggable command post with distance
  - legend and layer toggles
- ANALYTICS tab:
  - training load (TRIMP) and HR zones
  - strain (PSI) and core temperature (est.)
  - heat and CO exposure, activity intensity, SpO₂
  - HR recovery, session comparison, device health
  - plain-language insights

## 5. Proof-check pass (later on 2026-11-22)

Five reviewers audited every file and five fixers confirmed and fixed each finding. That came to 38 defects (3 high) and 41 text clean-ups. Afterwards, all three sketches compile with 0 warnings on cores 3.3.11 and 4.0.0, the arm harness (255 checks), the chest/gateway harness (543 checks) and the backend tests (222 + 267) pass, the dashboard builds with zero warnings, and fixture screenshots at 1280/1440/1920 show no clipped text.

- **High:**
  - The arm no longer reports false MAX30102 stalls.
  - When the arm strap goes silent, the backend no longer drops alerts that still apply.
  - With the arm's motion sensor down, the dashboard shows "IMU OFFLINE" and the backend raises an ARM IMU alert, so a dead fall detector can't look healthy.
- **MQ warm-up lockout (new):**
  - For the first 3 minutes after the chest boots, the chest doesn't raise its TX rate on CO/AQI.
  - The backend suppresses CO, air-quality and fire alerts, keeping those readings out of TWA, hazards and analytics. It works out the warm-up from the chest uptime, so the packet is unchanged.
  - The dashboard shows "WARMING UP ~N min".
- **Other fixes:**
  - a fake fall when the MPU6050 power-cycles
  - no-motion counts and CO saturation (shown as "≥") in analytics and on the map
  - battery-use maths across pack swaps
  - gateway RSSI below the noise floor
  - GPS "data arriving" now needs valid NMEA
  - port auto-detect with two ESP32s plugged in
  - hazard labels no longer cover the responder
  - map resize on header changes
  - link-lost responders sort to the top
  - follow mode re-arms when you click the selected responder
- **Dashboard text:** definitions, citations, how-to sentences, the NIOSH/OSHA table and long captions are removed. Estimates are marked "(est.)", and empty states are one line.
- **Map labels:** labels of markers at the very edge of the map are cut by the map border, as on any web map. Pan the map, or turn labels off under "Layers and legend".

## 6. Not included (planned next)

- Accelerometer: 200 Hz hardware FIFO and the 6-position calibration command.
- MAX30102: LED auto-gain and direct FIFO reads.
- BME280 high-precision profile.
- GPS: u-blox pedestrian mode.
- Arm and chest battery code made byte-identical. It is functionally the same today and tested in both.

## 7. Battery life (estimates from datasheet currents; measure with a USB meter)

- **Arm (800 mAh):** about 3–4 h before → about 12–15 h with the new firmware. Powering the ESP32 from the battery through a 3.3 V LDO (ME6211/HT7333) instead of boost + onboard regulator would add more.
- **Chest (2000 mAh):** about 2.5 h. The MQ7 and MQ135 heaters draw about 1.5 W, roughly 60 % of the total, so firmware savings are small (about 8 %). Feeding the ESP32, GPS and LoRa from a 3.3 V regulator on the battery adds about 10 %. A second 2000 mAh cell in parallel doubles runtime.

## 8. Notes

- `ESP32 files/HALO/HALO/halo-backend/backend.py` (old demo copy) still listens on 0.0.0.0 with CORS `*`. Don't run it.
- `serviceAccountKey.json` exists in two folders and is a full-admin key. Never share or commit it (`.gitignore` added). Rotate it in the Firebase console if the folder was ever shared.
- The MQ7 `R0` is still a placeholder. Calibrate per the Session 3 procedure, and fit the 10k/20k divider on the MQ outputs.
