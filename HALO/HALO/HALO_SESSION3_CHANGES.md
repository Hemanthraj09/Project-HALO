# HALO — Session 3 Change Log

> Every change made in Session 3, across firmware, backend, dashboard and simulator.
> Read it alongside `HALO_PROJECT_CONTEXT_v2.md`. Where the two disagree, this file is newer.

---

## 1. Files changed

| File | Location | Change |
|---|---|---|
| `arm_strap_v2.ino` | `ESP32 files/arm_strap_v2/` | Full rewrite |
| `chest_strap_v2.ino` | `ESP32 files/chest_strap_v2/` | Full rewrite (includes CO ppm + heat index) |
| `gateway.ino` | `ESP32 files/gateway/` | Full rewrite |
| `backend.py` | `HALO/halo-backend/` | Full rewrite |
| `App.js` | `HALO/halo-dashboard/src/` | Many targeted fixes and new cards |
| `simulator.py` | `HALO/halo-backend/` | Humidity, backend check, ambient temps |

Not touched: `index.js`, `index.html`, `package.json`, `serviceAccountKey.json`, `README.md`, and the stale copies `ESP32 files/arm_strap_v2_dup/` and `ESP32 files/HALO/HALO/`.

**Nothing has been uploaded to any ESP32 yet.** All three sketches compile against ESP32 core 3.3.11 and your installed libraries.

---

## 2. Arm strap (`arm_strap_v2.ino`)

The ESP-NOW `arm_data` struct is **unchanged**, so the arm strap can be flashed on its own.

### Heart rate / SpO₂ (MAX30102)
- **Bug fixed, wrong FIFO reads:** the loop used `getRed()`/`getIR()`, which return the *newest* sample and can block up to 250 ms, so the buffer held repeated copies of one sample. It now uses `getFIFORed()`/`getFIFOIR()`.
- **Bug fixed, wrong sample rate:** `setup(0x5F, 2, 2, 400, …)` produced 200 samples/s, but the Maxim algorithm assumes 25 samples/s (`FreqS`), so HR came out about 8× too low. It's now `setup(0x5F, 4, 2, 100, 411, 16384)` = 25 samples/s. A `static_assert` stops compilation if the rate no longer matches `FreqS`.
- **Bug fixed, buffer order:** the circular buffer went to the algorithm with its wrap point in the middle, which looked like a false peak. It's now put in time order first.
- **Sliding window:** 4 s window (100 samples), recalculated every 1 s (25 new samples).
- **Smoothing:** the value sent is the **median of the last 5 valid readings**. Valid range: HR 40–200, SpO₂ 80–100.
- **Finger detection with hysteresis:** the finger counts as placed at IR ≥ 80 000 and as removed at IR < 60 000, so small pressure changes don't restart calibration.
- **Output codes (unchanged meaning):** `0` = no finger / signal lost, `-1` = calibrating (first 10 s, or until the first valid reading), `>0` = value. No valid reading for 5 s → `0`.
- The sensor is read without blocking (`check()` every loop pass). The "Calibrating..." line that printed on every loop pass is gone.

### Fall detection (MPU6050), rewritten
- **Bug fixed:** it was checked only once every 3 s, so impacts (~100 ms) were almost always missed. It's now sampled at **100 Hz**.
- Range changed to **±16 g** (was 8 g) and filter to **44 Hz** (was 21 Hz), so impact peaks aren't clipped.
- **Trigger:** impact > 2.5 g, **or** free-fall < 0.5 g lasting ≥ 80 ms. The free-fall case catches drops onto soft surfaces.
- **Confirm:** the wearer stays still (|a| within 1 g ± 0.25 g and gyro < 0.5 rad/s) for **1.5 s**, within **5 s** of the trigger. If they keep moving, it's cancelled and treated as a bump.
- **Hold:** `fallDetected` stays true for **15 s**, and a confirmed fall is **sent immediately**.

### Other
- **Send rate:** every **1 s** (was 3 s).
- **BME280:** normal mode, oversampling T×2 / P×16 / H×1, IIR filter ×4, standby 125 ms. Altitude is calculated from the pressure reading (`SEA_LEVEL_HPA = 1013.25`, set it to the local sea-level pressure for accuracy).
- **Missing sensors:** a sensor that fails to start is skipped and its fields are sent as 0. The rest keep working (before, the board hung with `while(true)`). If ESP-NOW or peer setup fails, the board restarts.
- I2C set explicitly: `Wire.begin(21, 22)` at 400 kHz.
- One status line per send, including an ESP-NOW failure counter.

---

## 3. Chest strap (`chest_strap_v2.ino`)

### Bugs fixed
1. **False MAYDAY:** with no finger (SpO₂ = 0) or during calibration (-1), `spO2 < 90` was true, so it flagged P0 most of the time. HR had the same problem for P1. Values of 0 and -1 are now ignored.
2. **Silent when the arm strap died:** it only transmitted when arm data arrived. It now transmits on its own timer. If the arm strap is silent for more than **5 s**, all arm fields are sent as 0 (read as "disconnected").
3. **GPS:** the 500 ms blocking read is replaced by a non-blocking feed. With no fix it sent `0,0`; now the **last good fix is kept**.
4. **No GPS filter:** fixes are accepted only if **HDOP ≤ 3.0 and satellites ≥ 4**. This is looser than the doc's 2.0, so fixes near a window still work.
5. **Data race:** the ESP-NOW callback and the loop now share arm data under a lock (`portMUX` critical section). Removed `Serial.println` from the callback.
6. **MAC printed as zeros:** it's now read via `esp_wifi_get_mac()`.
7. **AQI scaling was missing:** MQ135 is now averaged over 16 samples and scaled with `map(…, 0, 4095, 0, 500)`.

### CO in ppm (MQ7), new
- `readCOppm()`: averages 16 × `analogReadMilliVolts()` readings, calculates sensor resistance Rs = RL·(Vc − Vout)/Vout, then **ppm = 99.042 · (Rs/R0)^−1.518** (datasheet curve), clamped to 0–2000.
- Constants: `MQ7_VC 5.0`, `MQ7_RL 10.0` (cancels out), `MQ7_DIVIDER 1.0`, `MQ7_R0 10.0` (**placeholder: calibrate**), `MQ7_CLEAN_AIR_RATIO 27.5`, `MQ7_ADC_MAX_MV 3100`.
- The packet sends `CO` in ppm and `COR` = raw pin mV.
- The serial status shows `Rs`, **R0(clean)** for calibration, and `SATURATED` when the ADC maxes out.

### Transmission
- **Transmit rate depends on priority:** P0 every **2 s**, P1 every **3 s**, P2 every **5 s**, plus **immediately when priority gets worse**. Sensors and priority are checked every 250 ms.
- Each ~190-byte packet is about **0.95 s on air** at SF9/125 kHz, so faster rates would not help.
- **Non-blocking send** (`endPacket(true)`). If the radio is still busy, it retries on the next tick.
- **LoRa CRC enabled**, so corrupted packets are dropped at the gateway.
- LoRa init: **5 retries**, then restart with a wiring checklist (was `while(true)`). SPI pins set explicitly.
- Packet is built with `snprintf` into a fixed buffer (was `String` concatenation, which fragments memory). HR and SpO₂ are sent as whole numbers.
- ESP-NOW channel set explicitly to 1, and radio power save disabled (`WIFI_PS_NONE`) so arm packets aren't missed.
- GPS receive buffer raised to 1024 bytes. "GPS NO DATA (check wiring)" is shown if no NMEA arrives.

### Priority (mirrors backend)
- **P0:** fall, CO > 200, 0 < SpO₂ < 90, HR > 170, **heat index ≥ 51.7 °C**
- **P1:** CO > 35, 0 < SpO₂ < 94, HR > 150 or 0 < HR < 40, **heat index ≥ 39.4 °C**
- Previously HR < 50 / > 120 and temperature 38.5 / 39.5.
- `heatIndexC()` is the same NWS formula as the backend.
- Core-temperature rules exist only in the backend, because they need the HR history.

### Other
- If ESP-NOW fails to start, the board restarts.
- Header wiring comment corrected: DIO0 → GPIO 4.
- **LoRa "init failed" finding:** `LoRa.begin()` only reads the chip version over SPI and never uses DIO0, so moving DIO0 could not fix it. Check 3.3 V, GND, NSS 5, RST 14, SCK 18, MISO 19, MOSI 23, and the RA-02 solder joints.

---

## 4. Gateway (`gateway.ino`)

- **RSSI bug fixed:** the gateway printed `[RSSI: -57 dBm]` on a separate line the backend couldn't parse. RSSI and SNR are now **added to the end of the packet line**: `…,FALL:0,RSSI:-57,SNR:9.5`.
- **Packet validation:** only packets that start with `ID:` and are printable ASCII are forwarded. Others are dropped and counted. CRC-failed packets are dropped by `parsePacket()`.
- **Diagnostics start with `#`** (startup messages, and a status line every 30 s with received/dropped counts and time since the last packet). The backend ignores these lines.
- LoRa init: 5 retries, then restart (was `while(true)`). SPI pins explicit. `enableCrc()`.
- `LORA_DIO0` set to 4. It isn't used in polling mode, but GPIO 2 is a boot strapping pin, so moving the wire is recommended.
- Packets are read into a fixed buffer (was a `String`).

---

## 5. Backend (`backend.py`)

### Serial
- **Auto-detects the gateway port** by USB chip (CP210x `0x10C4`, CH340 `0x1A86`, FTDI `0x0403`). Override with the environment variable `HALO_COM_PORT` (for example `$env:HALO_COM_PORT="COM3"`).
- **Bug fixed, no reconnect:** a dropped port looped on "Read error" forever. It now reconnects. Serial errors and processing errors (Firebase) are handled separately.
- **Bug fixed, drop right after connecting:** the port opens with **DTR/RTS off** (no ESP32 reset), then waits 2 s and clears the input buffer.
- "Not found" and "can't open" messages print once (no log spam). The "can't open" message suggests closing the Arduino Serial Monitor.
- Lines starting with `#` are ignored.

### Parsing
- **Bug fixed:** `PRES` → `pressure` (the backend looked for `PRESSURE`). `BALT` → `bme_alt` is now stored.
- New stored fields: `snr`, `co_raw_mv` (from `COR`), `device_pri` (from `PRI`: the chest strap's own priority, useful as evidence for the hardware flow-control results).
- `accel` is `None` when there's no IMU data (it used to default to 1.0 g).
- Priority is no longer calculated in the parser. Removed the obsolete RSSI-only line branch.

### Priority and alerts
- **`compute_priority()` is the single source of truth** for both the CSV (hardware) and JSON (simulator) paths. The simulator's own `priority` is ignored.
- One set of named thresholds (see §9).
- **Bug fixed, alert flood:** debounce (20 s) was keyed on the full alert text, which includes the value, so a changing CO value alerted on almost every packet. It's now keyed on the **alert type**.
- Alert reasons added: `HR CRITICAL`, `CO 15-MIN TWA HIGH`, `CORE TEMP (EST) HIGH/CRITICAL`, `HEAT DANGER`, `EXTREME HEAT`. Removed `TEMP ELEVATED/CRITICAL`.

### Live node (no stale values)
- **Bug fixed:** zero HR/SpO₂ used to be dropped, so old values stayed on screen forever. HR/SpO₂ are now written as-is (`0` = no signal, `-1` = calibrating).
- Fields cleared (deleted) from `live/` when 0 or missing: `temp, hum, heat_index, pressure, bme_alt, accel, lat, lon, alt, batt, rssi, snr`. The full reading, zeros included, still goes to `readings/` for diagnostics.

### New metrics
- **Heat Index** (`heat_index`, °C): NWS formula (Rothfusz regression with adjustments) from BME280 **ambient** temperature and humidity. Never below air temperature. Checked against the NWS reference table.
- **Estimated core temperature** (`core_temp_est`, °C): Kalman filter from heart rate, **Buller et al. 2013, Physiol. Meas. 34:781** (±0.3 °C). Starts at 37.1 °C and updates once per minute with that minute's mean HR, holding the value if there's no valid HR. One estimator per responder, in memory.
- **PSI:** now **Moran et al. 1998**, using estimated core temperature: `5·(Tcore−37.1)/(39.5−37.1) + 5·(HR−70)/(180−70)`, clamped 0–10. It previously used ambient temperature and HR max 200.
- The console line shows ambient temperature, heat index, estimated core temperature, PSI, TWA and RSSI.
- Removed the unused `WebSocket` imports and the `websockets` install requirement.

---

## 6. Dashboard (`App.js`)

### Status and safety
- **Link-loss detection:** no packet for **20 s** → responder shows **OFFLINE**, with "No data for Xs — values below are last known". Before, a dead link kept showing its last status.
- Header counters are based on live status. New **NO SIGNAL** counter; ACTIVE excludes offline responders.
- **1 s re-render tick:** the header clock now runs (it only updated on new data before), and link loss is detected on time.

### Vitals
- HR/SpO₂ show `CAL` while calibrating. Sub-labels: `CALIBRATING...` / `NO SIGNAL` / `NO SENSOR`.
- HR colours and labels match the backend: > 170 red "CRITICAL HIGH", > 150 "TACHYCARDIA", < 40 "BRADYCARDIA".
- The "Body Temperature" card and chart are replaced by **Core Temp (est.)**, with the Buller 2013 note. Humidity moved to the Environment tab.
- Battery shows **NOT REPORTED** when not sent (the hardware has no battery sensing).
- PSI uses Moran bands: < 3 none/little, 3–4 low, 5–6 moderate (yellow), 7–8 high (orange), ≥ 9 very high (red).

### Environment
- **CO:** SAFE < 35 (green), ELEVATED 35–50 (yellow), DANGER 50–200 (orange), CRITICAL > 200 (red). Gauge warns at 35. TWA text says "NIOSH limit 35". Reference table: added "CO PEL (8hr) 50 ppm OSHA", renamed "STEL" to "Ceiling".
- **AQI (MQ135):** Good 0–100, Moderate 100–200, Poor 200–300, Hazardous 300+, with colours, a legend, and a "relative index, not calibrated AQI" note. Gauge 100/300.
- **New Heat Index card:** feels-like °C with NWS level (Safe / Caution / Extreme Caution / Danger / Extreme Danger), ambient temperature, humidity, and small charts.
- **New Atmosphere card:** pressure, barometric altitude, GPS altitude.

### Responder card
- Temperature is labelled **AMB** and coloured by heat index. AQ is coloured by AQI band.
- The duplicate "AQ" in the second row is replaced by **TWA**. BATT shows `--` when not reported.

### Map
- **Bug fixed:** the map flew back to zoom 17 on every data update. It now flies only when a responder is selected, then follows with `panTo`, keeping your zoom.

### Text and analytics
- Fall text updated to the new algorithm. Legend intervals are now 2 s / 3 s / 5 s, and P0/P1 descriptions include HR 170 / TWA 35.
- The Data Export example uses the selected responder ID.
- **Bug fixed:** "Min SpO₂" showed `Infinity%` when there were no valid readings.
- Summary adds **Peak Heat Index**. Charts: HR, SpO₂, CO, PSI, Core Temp (est.), Heat Index, Ambient Temperature, Humidity.

---

## 7. Simulator (`simulator.py`)

- Sends **humidity** (`hum`). The dashboard tile was always `--` before.
- **Backend check fixed:** it printed "OK" even when the backend was down. It now exits with a clear message after 15 s.
- `temp` is now **ambient** (28 → 33 → 35 → 35.5 → 29 °C) with humidity rising alongside, so the heat index goes Safe → Danger → Extreme Danger (during the fall) → Caution.
- Its local P1 rule was changed to CO > 35. The backend now recalculates priority anyway.

---

## 8. Data formats

**Chest → Gateway (LoRa):**
```
ID:HALO-01,PRI:2,LAT:12.961252,LNG:77.497520,ALT:852.0,HR:72,SPO2:98,TEMP:29.8,HUM:54.5,PRES:915.0,BALT:851.9,AX:9.86,AY:-0.05,AZ:-1.21,CO:12.4,COR:410,AQI:112,FALL:0
```
Changes: `CO` is now **ppm** (was raw ADC), new `COR` (MQ7 mV), `AQI` is scaled 0–500, `HR`/`SPO2` are whole numbers, `TEMP` is **ambient**.

**Gateway → Backend (serial):** the same line plus `,RSSI:-57,SNR:9.5`. Diagnostics start with `#`.

**Firebase `live/HALO-01` fields:** `id, ts, priority, device_pri, hr, spo2, co, co_raw_mv, twa_co, aq, temp, hum, heat_index, core_temp_est, psi, pressure, bme_alt, accel, fall, lat, lon, alt, gps_ok, rssi, snr` (+ `batt` from the simulator only).

---

## 9. Unified thresholds (firmware = backend = dashboard)

| Parameter | P1 WARNING | P0 MAYDAY | Source |
|---|---|---|---|
| CO | > 35 ppm | > 200 ppm | NIOSH 8-hr REL / ceiling |
| CO 15-min TWA | > 35 ppm | — | NIOSH REL (backend only) |
| SpO₂ | < 94 % | < 90 % | 0 / -1 ignored |
| HR | > 150 or < 40 bpm | > 170 bpm | 0 / -1 ignored |
| Core temp (estimated) | > 38.5 °C | > 39.5 °C | backend only |
| Heat index (ambient) | ≥ 39.4 °C | ≥ 51.7 °C | NWS Danger / Extreme Danger |
| Fall | — | confirmed fall | arm strap |

Timing: arm → chest every 1 s (a fall is sent immediately). Chest → gateway: P0 2 s, P1 3 s, P2 5 s, immediately on escalation. Dashboard marks a responder offline after 20 s without data.

---

## 10. Hardware actions required

1. **Voltage dividers:** the MQ7 (GPIO 34) and MQ135 (GPIO 35) run at 5 V and are wired straight in, so they can exceed the ESP32's 3.3 V limit (readings max out at about 3.1 V; damage risk above 3.6 V). Add **10 k (AO→GPIO) + 20 k (GPIO→GND)** on each, then set `MQ7_DIVIDER` to `1.5`.
2. **MQ7 R0 calibration:** flash the chest strap, warm the sensor for 5+ min in clean outdoor air, read **R0(clean)** from the Serial Monitor, put it into `MQ7_R0`, and flash again.
3. **Gateway DIO0:** move the wire from GPIO 2 to GPIO 4 (recommended, not required).
4. **LoRa init failure:** go through the §3 checklist (power, ground, SPI pins, solder joints).

## 11. Flash and run order

1. Upload `gateway.ino`, then **close the Serial Monitor**.
2. Upload `chest_strap_v2.ino` (keep the Serial Monitor open for the first run to check LoRa and read R0).
3. Upload `arm_strap_v2.ino`.
4. Plug in the gateway, wait 2–3 s, then run `python backend.py` (the port is auto-detected).
5. `npm start` in `halo-dashboard` (it reloads automatically if already running).
6. Without hardware: `python simulator.py`.

## 12. Tuning parameters

| Parameter | File | Default | Adjust if… |
|---|---|---|---|
| `FINGER_ON_LEVEL` / `FINGER_OFF_LEVEL` | arm | 80000 / 60000 | HR flips between no finger and calibrating |
| `IMPACT_THRESHOLD` | arm | 2.5 g | arm swings cause false falls (try 3.0 g) |
| `STILL_MS`, `FALL_HOLD_MS` | arm | 1.5 s, 15 s | fall confirmation too slow or too sensitive |
| `SEA_LEVEL_HPA` | arm | 1013.25 | barometric altitude is off |
| `MAX_HDOP`, `MIN_SATS` | chest | 3.0, 4 | GPS too strict or too loose |
| `TX_INTERVAL_MS` | chest | 2000/3000/5000 | airtime vs. update rate |
| `MQ7_R0`, `MQ7_DIVIDER` | chest | 10.0, 1.0 | after calibration or adding a divider |
| `STALE_MS` | App.js | 20000 | offline detection too quick or too slow |

---

## 13. Known limitations

- **MQ7 accuracy:** the heater isn't cycled (the datasheet specifies 60 s at 5 V / 90 s at 1.4 V), so ppm is approximate and not CO-specific. The sensor can't detect below ~20 ppm.
- **MQ135:** a relative index, not a calibrated AQI.
- **Core temperature is estimated from HR, not measured.** Say so in the report and cite Buller 2013. The estimate and the TWA reset when `backend.py` restarts, and the core estimate needs several minutes of HR data.
- **Heat index** is defined for warm conditions (≥ ~27 °C). Below that it simply equals the air temperature.
- **MAX30102** is sensitive to motion.
- **Old Firebase data:** `readings/` from before this session has CO in raw ADC units, so charts will show a drop. Clear `readings/HALO-01` for a clean demo. If a legacy `alerts/HALO-01` node exists, delete it in the Firebase console, because the dashboard downloads all of it whenever alerts change.

## 14. Status of the external review items

| Item | Status |
|---|---|
| COM port auto-detect | Fixed this session |
| Alerts written twice to `alerts/HALO-01` | Already fixed before this session (legacy data may remain) |
| No alert debounce | Already present; its debounce key fixed this session |
| Global `co_history` | Already per-responder |
| Bradycardia / SpO₂ 0 handling inconsistent | Already fixed in backend; firmware fixed this session |
| Relative service-key path | Already fixed |
| History hardcoded to HALO-01 | Already fixed (Data Export text fixed this session) |
| CartoDB watermark tiles | Already replaced with OpenStreetMap |
| False offline status | Already uses `.info/connected` |
| Map always flies to first responder | Already fixed; zoom-reset bug fixed this session |
| Simulator missing humidity | Fixed this session |
| Simulator startup check | Fixed this session |

## 15. Verification

- All three sketches compiled with `arduino-cli` (esp32:esp32:esp32, core 3.3.11). **Not yet tested on hardware.**
- Backend tested with Firebase replaced by fakes: parsing, priorities, zero/-1 handling, clearing of stale fields, alert debounce, `#` lines, JSON path, heat index vs. NWS table, core-temperature behaviour. **Not run against the real Firebase database.**
- Dashboard production build compiles with no errors or lint warnings.
