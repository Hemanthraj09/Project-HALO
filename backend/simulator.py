"""
HALO simulator (Session 4): generates telemetry for one responder and POSTs it as JSON to the
backend's /ingest. The backend writes to Firebase; the dashboard reads Firebase in real time.

Modes:
  nominal (default)  the demo: a healthy responder at Bull Temple Rd, Basavanagudi, Bengaluru
                     (12.94289, 77.56821). No alert fires. Batteries drain at realistic rates and
                     are swapped at 21 %, above the 20 % low-battery alert.
  shift              a 30-minute loop that drives every alert and analytics path:
                       0:00  warm-up walk     HR zones 1-2, light activity. In the first minute of
                                              the run only, mq_warmup_s counts 60 -> 0 (MQ sensors
                                              warming up), so the backend holds off CO/air alerts.
                                              For hardware the backend derives up to 180 s from
                                              the chest uptime instead
                       2:00  hard work        HR 150-178, vigorous bursts (PPG motion flag),
                                              heat index rising to about 42 C, GPS stale indoors
                      12:00  smoke / CO       CO 40 -> 230 ppm (the sensor saturates at the top),
                                              AQI 150 -> 320, SpO2 dips to 88 %, walking ~1 m/s so the
                                              map shows the trail and a chain of hazard points
                      18:00  fall             impact, then 75 s motionless (still_s rising, fall latched)
                      19:15  recovery rest    HR decays (HR recovery), sedentary
                      25:00  normal walk      20 s arm-strap dropout (ARM_LINK), a 20 s arm IMU
                                              fault (ARM_IMU) and a 35 s radio shadow with nothing
                                              sent (LINK)
                     Batteries start at chest 34 % / arm 23 % and keep draining across loops (chest
                     0.65 %/min, arm 0.15 %/min), so both battery alerts fire in the first loop; a pack
                     is swapped when it reaches 5 %. The core-temperature estimate is computed by the
                     backend (Buller 2013 Kalman filter), which starts at 37.1 C with zero variance and
                     rises slowly: CORE TEMP HIGH (> 38.5 C) first fires during the second loop.

Usage:
  python simulator.py [--mode nominal|shift] [--id HALO-01] [--interval 1.0] [--backend http://127.0.0.1:8000]

Run order:
  Terminal 1: python backend.py
  Terminal 2: python simulator.py --mode shift
  Terminal 3: npm start (in the dashboard folder)

Don't run the simulator with the same --id as a powered chest strap: both would write live/<id>.
"""

import argparse
import json
import math
import random
import re
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BACKEND = "http://127.0.0.1:8000"

# Location: Bull Temple Rd, Basavanagudi, Bengaluru, Karnataka 560004
BASE_LAT = 12.94289
BASE_LON = 77.56821
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(BASE_LAT))

SHIFT_LOOP_S = 30 * 60
CHEST_DRAIN_PCT_PER_MIN = 0.65
ARM_DRAIN_PCT_PER_MIN = 0.15
ARM_SENSORS_ALL = 15            # IMU 1 | BME 2 | PPG 4 | BATT 8

# Li-ion SoC table, same as the firmware and backend: voltage → %
SOC_TABLE = ((4.20, 100), (4.15, 95), (4.11, 90), (4.08, 85), (4.02, 80), (3.98, 75), (3.95, 70),
             (3.91, 65), (3.87, 60), (3.85, 55), (3.84, 50), (3.82, 45), (3.80, 40), (3.79, 35),
             (3.77, 30), (3.75, 25), (3.73, 20), (3.71, 15), (3.69, 10), (3.61, 5), (3.27, 0))

# Simulated MQ7 on the chest (same Rs/R0 curve as the firmware). R0 = 10.68 kΩ puts the
# 3100 mV ADC ceiling at 230 ppm, so readings above 230 ppm come out as 230 with co_sat.
MQ7_VC, MQ7_RL, MQ7_R0 = 5.0, 10.0, 10.68
ADC_CEILING_MV = 3100
CO_CEILING_PPM = 230.0
# Shift mode: MQ7/MQ135 warm-up countdown after the simulated chest boot (seconds left). On
# hardware the backend derives up to 180 s from the chest uptime; one minute keeps the demo short.
MQ_WARMUP_SIM_S = 60

# Shift phases: (name, start s, end s, console label)
SHIFT_PHASES = (
    ("warmup",   0,    120,  "WARM-UP WALK   z1-z2, light activity"),
    ("work",     120,  720,  "HARD WORK      HR 150-178, vigorous bursts, heat index rising to ~42 C"),
    ("smoke",    720,  1080, "SMOKE / CO     CO 40->230 ppm, AQI 150->320, walking ~1 m/s"),
    ("fall",     1080, 1155, "FALL           impact, then 75 s motionless"),
    ("recovery", 1155, 1500, "RECOVERY REST  HR decays, sedentary"),
    ("walk",     1500, 1800, "NORMAL WALK    arm dropout at 26:00, IMU fault at 27:00, radio shadow at 28:00"),
)
NOMINAL_LABEL = "NOMINAL        routine telemetry, always healthy"

INDOOR_GPS = (360, 540)          # hard work inside a structure: no fresh fix
ARM_DROPOUT = (1560, 1580)       # arm strap silent (arm_ok False)
IMU_FAULT = (1620, 1640)         # arm link up, MPU6050 not answering (arm_sensors without bit 0)
RADIO_SHADOW = (1680, 1715)      # nothing reaches the gateway → backend LINK alert after 20 s
FALL_IMPACT_S = 1080
FALL_CONFIRMED_S = 1082          # the arm confirms after 1.5 s of stillness
FALL_CLEARED_S = 1158            # the arm clears the latch after >= 15 s and 3 s of movement
GET_UP_S = 1155

# Closed walking route around the block south-east of the base point (metres east, north)
PATH_M = ((0.0, 0.0), (140.0, 0.0), (140.0, -100.0), (0.0, -100.0))
SPEED_M_S = {"warmup": 1.2, "work": 0.0, "smoke": 1.0, "fall": 0.0, "recovery": 0.0, "walk": 1.2}


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def voltage_from_soc(pct):
    """Cell voltage for a state of charge, inverting the SoC table (piecewise linear)."""
    pct = clamp(pct, 0.0, 100.0)
    for (v_hi, p_hi), (v_lo, p_lo) in zip(SOC_TABLE, SOC_TABLE[1:]):
        if pct >= p_lo:
            return v_lo + (v_hi - v_lo) * (pct - p_lo) / (p_hi - p_lo)
    return SOC_TABLE[-1][0]


def co_pin_mv(ppm):
    """MQ7 pin voltage (mV) for a CO level, inverting ppm = 99.042 * (Rs/R0)^-1.518."""
    rs = MQ7_R0 * (max(ppm, 0.5) / 99.042) ** (-1.0 / 1.518)
    return int(round(min(MQ7_VC * MQ7_RL / (rs + MQ7_RL) * 1000.0, ADC_CEILING_MV)))


def aq_pin_mv(aqi):
    """MQ135 pin voltage (mV) for an AQI value (AQI = mV * 500 / 3100)."""
    return int(round(aqi * 3100.0 / 500.0))


def _path_point(dist_m):
    """Point (east, north) in metres at distance dist_m along the closed PATH_M route."""
    legs = list(zip(PATH_M, PATH_M[1:] + PATH_M[:1]))
    lengths = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in legs]
    d = dist_m % sum(lengths)
    for (a, b), length in zip(legs, lengths):
        if d <= length:
            f = d / length
            return a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
        d -= length
    return PATH_M[0]


def _in(t, window):
    return window[0] <= t < window[1]


class Scenario:
    """Payload generator. tick(dt) advances the clock by dt seconds and returns the JSON dict
    to send, or None when nothing reaches the backend (radio shadow). No network access."""

    def __init__(self, mode="nominal", responder_id="HALO-01", seed=None):
        if mode not in ("nominal", "shift"):
            raise ValueError(f"unknown mode {mode!r}")
        self.mode = mode
        self.id = responder_id
        self.rng = random.Random(seed)
        self.t = 0.0                  # seconds into the current loop (shift) or since start
        self.elapsed = 0.0            # seconds since start
        self.loop = 1
        self.step = 0
        self.seq = 0
        self.notes = []               # console notes for the last tick (loop restarts, battery swaps)
        if mode == "shift":
            self.chest_pct, self.arm_pct, self.swap_below = 34.0, 23.0, 5.0
        else:
            self.chest_pct, self.arm_pct, self.swap_below = 95.0, 98.0, 21.0
        self.hum = 55.0               # nominal humidity random walk
        self.dist = 0.0               # metres walked along PATH_M (shift)
        self.last_fix = (BASE_LAT, BASE_LON)
        # MQ warm-up seconds left (shift only; None once the final 0 has been sent)
        self.mq_left = float(MQ_WARMUP_SIM_S) if mode == "shift" else None
        self._new_loop()

    def _new_loop(self):
        self.held = (122, 98)         # last published HR/SpO2 (the arm holds them during motion)
        self.still = 0.0
        self.impact_sent = False

    # ── phase info ──
    def phase(self):
        if self.mode == "nominal":
            return "nominal"
        for name, start, end, _ in SHIFT_PHASES:
            if start <= self.t < end:
                return name
        return SHIFT_PHASES[-1][0]

    def phase_label(self):
        if self.mode == "nominal":
            return NOMINAL_LABEL
        name = self.phase()
        return next(label for n, _, _, label in SHIFT_PHASES if n == name)

    # ── clock ──
    def tick(self, dt=1.0):
        self.notes = []
        self.step += 1
        self.elapsed += dt
        self.t += dt
        if self.mode == "shift" and self.t >= SHIFT_LOOP_S:
            self.t -= SHIFT_LOOP_S
            self.loop += 1
            self._new_loop()
            self.notes.append(f"shift loop {self.loop} started")
        self._drain(dt)
        self.seq = (self.seq + 1) % 65536
        if self.mode == "nominal":
            return self._nominal()
        p = self._shift(dt)
        self._mq_countdown(p, dt)
        return p

    def _mq_countdown(self, p, dt):
        """MQ sensor warm-up at the start of the run: mq_warmup_s = 60, 59, ... 1, 0 (one value per
        tick at 1 s), then the key is left out (0 and absent both mean the sensors are ready)."""
        if self.mq_left is None:
            return
        if p is not None:
            p["mq_warmup_s"] = int(math.ceil(self.mq_left))
        self.mq_left = max(0.0, self.mq_left - dt) if self.mq_left > 0 else None

    def _drain(self, dt):
        self.chest_pct -= CHEST_DRAIN_PCT_PER_MIN * dt / 60.0
        self.arm_pct -= ARM_DRAIN_PCT_PER_MIN * dt / 60.0
        if self.chest_pct < self.swap_below:
            self.chest_pct = 100.0
            self.notes.append("chest battery pack swapped (100 %)")
        if self.arm_pct < self.swap_below:
            self.arm_pct = 100.0
            self.notes.append("arm battery pack swapped (100 %)")

    def _noise(self, spread):
        return self.rng.gauss(0.0, spread)

    def _batteries(self, payload, arm=True):
        payload["batt_chest"] = int(round(self.chest_pct))
        payload["vbat_chest"] = round(voltage_from_soc(self.chest_pct) + self._noise(0.002), 3)
        if arm:
            payload["batt_arm"] = int(round(self.arm_pct))
            payload["vbat_arm"] = round(voltage_from_soc(self.arm_pct) + self._noise(0.002), 3)

    # ── nominal: today's demo plus the Session 4 fields ──
    def _nominal(self):
        s, n = self.step, self._noise
        hr = clamp(79.0 + 11.0 * math.sin(s * 0.07) + n(0.4), 68.0, 90.0)
        spo2 = clamp(98.9 + 0.9 * math.sin(s * 0.05) + n(0.04), 98.0, 99.8)
        co = clamp(5.5 + 4.5 * math.sin(s * 0.1) + n(0.1), 1.0, 10.0)
        temp = clamp(25.0 + n(0.05), 24.5, 25.5)
        aq = clamp(52.0 + n(0.8), 49.0, 55.0)
        self.hum = clamp(self.hum + n(0.15), 50.0, 60.0)
        accel = 1.0 + 0.3 * math.sin(s * 0.4) + n(0.05)
        p = {
            "id": self.id, "seq": self.seq,
            "hr": round(hr, 1), "spo2": round(spo2, 1), "ppg_q": int(clamp(92 + n(2), 80, 99)),
            "skin": True, "ppg_motion": False,
            "activity_mg": int(clamp(75 + 15 * math.sin(s * 0.3) + n(5), 50, 99)), "still_s": 0,
            "temp": round(temp, 2), "hum": round(self.hum, 1),
            "pressure": round(913.2 + n(0.05), 1), "bme_alt": round(905.0 + n(0.4), 1),
            "accel": round(clamp(accel, 0.5, 2.0), 3), "fall": False,
            "lat": round(BASE_LAT + n(0.000010), 7), "lon": round(BASE_LON + n(0.000010), 7),
            "alt": round(905.0 + n(1.5), 1),
            "gps_fresh": True, "gps_uart": True, "gps_sats": 8 + (s % 3 == 0),
            "gps_hdop": round(clamp(1.0 + n(0.08), 0.8, 1.4), 1), "gps_age_s": s % 2,
            "co": round(co, 1), "co_raw_mv": co_pin_mv(co), "co_sat": False,
            "aq": round(aq, 1), "aq_raw_mv": aq_pin_mv(aq),
            "arm_ok": True, "arm_loss_pct": int(clamp(1 + n(1), 0, 3)),
            "rssi": round(clamp(-65 + n(3), -90, -45), 1), "snr": round(clamp(9.5 + n(0.8), 5, 12), 1),
            "arm_sensors": ARM_SENSORS_ALL,
        }
        self._batteries(p)
        return p

    # ── shift: 30-minute scenario ──
    def _shift(self, dt):
        t, n, ph = self.t, self._noise, self.phase()
        self.dist += SPEED_M_S[ph] * dt
        east, north = _path_point(self.dist)
        if _in(t, RADIO_SHADOW):
            return None                         # the chest transmits, nothing arrives

        p = {"id": self.id, "seq": self.seq}

        # GPS (chest)
        if _in(t, INDOOR_GPS):
            p.update(lat=self.last_fix[0], lon=self.last_fix[1], gps_fresh=False, gps_uart=True,
                     gps_age_s=int(t - INDOOR_GPS[0]), alt=round(905.0 + n(0.5), 1))
        else:
            lat = round(BASE_LAT + (north + n(0.8)) / M_PER_DEG_LAT, 7)
            lon = round(BASE_LON + (east + n(0.8)) / M_PER_DEG_LON, 7)
            self.last_fix = (lat, lon)
            p.update(lat=lat, lon=lon, gps_fresh=True, gps_uart=True, gps_age_s=int(self.step % 2),
                     gps_sats=7 + self.step % 3, gps_hdop=round(clamp(1.1 + n(0.12), 0.8, 1.6), 1),
                     alt=round(905.0 + n(1.5), 1))

        # Gas sensors (chest)
        co_true, aqi = self._gas(t)
        co = min(co_true, CO_CEILING_PPM)
        p.update(co=round(co, 1), co_raw_mv=co_pin_mv(co), co_sat=co_true >= CO_CEILING_PPM,
                 aq=round(clamp(aqi, 0, 500), 1), aq_raw_mv=aq_pin_mv(clamp(aqi, 0, 500)))

        # Radio
        if _in(t, INDOOR_GPS) or ph == "work":
            rssi, snr = -88 + n(3), 2.0 + n(1.5)
        elif ph == "smoke":
            rssi, snr = -80 + n(4), 5.0 + n(1.5)
        else:
            rssi, snr = -63 + n(3), 9.5 + n(1.0)
        p.update(rssi=round(clamp(rssi, -120, -40), 1), snr=round(clamp(snr, -10, 12), 1))

        # Arm strap
        if _in(t, ARM_DROPOUT):
            p.update(arm_ok=False, arm_sensors=0, fall=False)
            self._batteries(p, arm=False)
            return p
        p.update(arm_ok=True, arm_sensors=ARM_SENSORS_ALL,
                 arm_loss_pct=int(clamp((5 if ph == "work" else 1) + n(1.5), 0, 12)))
        self._arm(p, t, ph, dt)
        if _in(t, IMU_FAULT):                   # as the hardware sends it: ACT/STILL 0, no AX/AY/AZ
            p.update(arm_sensors=ARM_SENSORS_ALL & ~1, activity_mg=0, still_s=0)
            del p["accel"]
        self._batteries(p)
        return p

    def _gas(self, t):
        """(true CO ppm, AQI) for loop time t."""
        n = self._noise
        if t < 120:
            return clamp(4 + n(0.8), 0.5, 10), 55 + n(2)
        if t < 720:
            return clamp(6 + n(1.2), 0.5, 12), 75 + n(3)
        if t < 1080:
            u = t - 720
            if u < 240:
                co, aqi = 40 + 220 * u / 240, 150 + 170 * u / 240
            elif u < 300:
                co, aqi = 260.0, 322 + 4 * math.sin(u / 6)
            else:
                co, aqi = 260 - 200 * (u - 300) / 60, 322 - 192 * (u - 300) / 60
            return co + n(1.5), aqi + n(3)
        if t < 1155:
            k = math.exp(-(t - 1080) / 20.0)
            return 15 + 45 * k + n(0.8), 90 + 40 * k + n(2)
        if t < 1500:
            return clamp(6 + n(0.8), 0.5, 12), 65 + n(2)
        return clamp(4 + n(0.8), 0.5, 10), 55 + n(2)

    def _arm(self, p, t, ph, dt):
        n = self._noise
        burst = False
        if ph == "warmup":
            hr, spo2 = 112 + 16 * t / 120, 98
            act, q = 75 + n(8), 90
            temp, hum = 30.0, 50.0
        elif ph == "work":
            u = t - 120
            hr = 128 + 22 * u / 30 if u < 30 else min(178, 150 + 28 * (u - 30) / 150) - abs(n(0.8))
            spo2 = 97
            burst = (u % 15) < 9                # 9 s of vigorous movement, 6 s of static effort
            act = 650 + n(60) if burst else 130 + n(6)
            q = 62 if burst else 78
            f = min(1.0, u / 480.0)
            temp, hum = 30.0 + 6.5 * f, 50.0 - 5.0 * f
        elif ph == "smoke":
            u = t - 720
            hr = 174 + 2 * math.sin(u / 25)
            if u < 120:
                spo2 = 97 - 4 * u / 120
            elif u < 220:
                spo2 = 93 - 5 * (u - 120) / 100
            elif u < 280:
                spo2 = 88
            else:
                spo2 = 88 + 7 * (u - 280) / 80
            act, q = 130 + n(8), 75
            temp, hum = 36.5, 45.0
        elif ph == "fall":
            u = t - 1080
            hr, spo2 = 160 - 10 * u / 75, 95
            act, q = 4 + abs(n(1.5)), 82
            temp, hum = 36.5 - 3.5 * u / 75, 45.0 + 2.0 * u / 75
        elif ph == "recovery":
            u = t - 1155
            hr, spo2 = 95 + 55 * math.exp(-u / 70.0), 97
            act = 190 + n(15) if t < GET_UP_S + 5 else 25 + n(6)
            q = 92
            f = min(1.0, u / 345.0)
            temp, hum = 33.0 - 3.0 * f, 47.0 + 3.0 * f
        else:                                   # walk
            hr, spo2 = 115 + 3 * math.sin(t / 40), 98
            act, q = 80 + n(8), 90
            temp, hum = 30.0, 50.0

        # Stillness and the fall latch, as the arm reports them
        accel = 1.0 + 0.3 * math.sin(self.step * 0.4) + n(0.05)
        fall = FALL_CONFIRMED_S <= t < FALL_CLEARED_S
        if ph == "fall":
            if not self.impact_sent:
                self.impact_sent = True
                accel, act = 3.6, 900
            else:
                accel = 1.0 + n(0.01)
            self.still = max(0.0, t - FALL_IMPACT_S)
        elif ph == "recovery" and t >= GET_UP_S + 5:
            self.still += dt                    # sitting; small movements every ~18 s
            if self.still >= 18:
                self.still = 0.0
            accel = 1.0 + n(0.03)
        else:
            self.still = 0.0
            if ph == "work":
                accel = (1.0 + 1.1 * abs(math.sin(self.step * 0.9)) + n(0.1)) if burst else 1.0 + n(0.08)

        # The arm holds the last HR/SpO2 during motion bursts (PPG motion gate)
        if burst:
            hr_out, spo2_out = self.held
        else:
            hr_out, spo2_out = int(round(hr + n(1.0))), int(round(clamp(spo2 + n(0.3), 70, 100)))
            self.held = (hr_out, spo2_out)

        p.update(hr=hr_out, spo2=spo2_out, ppg_q=int(clamp(q + n(3), 40, 99)), skin=True,
                 ppg_motion=burst, activity_mg=int(clamp(act, 0, 2000)), still_s=int(self.still),
                 temp=round(temp + n(0.05), 2), hum=round(clamp(hum + n(0.3), 0, 100), 1),
                 pressure=round(913.2 + n(0.05), 1), bme_alt=round(905.0 + n(0.4), 1),
                 accel=round(clamp(accel, 0.0, 16.0), 3), fall=fall)


# ─── NETWORK ───────────────────────────────────────────────────────────────
def _make_opener():
    """urllib opener that ignores HTTP(S)_PROXY: the backend is on loopback, and readings must
    not be sent through a proxy."""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


_OPENER = _make_opener()


def send(ingest_url, payload, timeout=2.0):
    """POST one reading. Returns (response dict, None) or (None, error text)."""
    try:
        body = json.dumps(payload, allow_nan=False).encode()
    except ValueError as e:
        return None, f"not sent: {e}"
    req = urllib.request.Request(ingest_url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}"), None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        return None, f"HTTP {e.code}: {detail}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return None, f"{e} (is backend.py running?)"


def wait_for_backend(base_url, attempts=15):
    print(f"Waiting for backend at {base_url}", end="", flush=True)
    for _ in range(attempts):
        try:
            with _OPENER.open(base_url + "/health", timeout=1) as resp:
                if resp.status == 200:
                    print(" OK\n")
                    return True
        except Exception:
            pass
        print(".", end="", flush=True)
        time.sleep(1)
    print(f"\n[!] Backend not reachable at {base_url}. Start it with: python backend.py")
    return False


def status_line(sc, payload, result, error):
    mm, ss = divmod(int(sc.t), 60)
    head = f"[L{sc.loop} {mm:02d}:{ss:02d}]" if sc.mode == "shift" else f"[{int(sc.elapsed):>5}s]"
    if payload is None:
        return f"{head} radio shadow: chest transmitting, nothing reaches the gateway"
    pri = f"P{result['priority']}" if result and "priority" in result else "P?"
    if payload.get("arm_ok") is False:
        vitals = "ARM OFFLINE"
    else:
        vitals = (f"HR {payload['hr']:>5} SpO2 {payload['spo2']:>4} act {payload['activity_mg']:>4}mg "
                  f"still {payload['still_s']:>2}s" + (" FALL" if payload["fall"] else ""))
    warm = payload.get("mq_warmup_s", 0)
    if warm > 0:                                # same width as the CO/AQI column below
        gas = f"CO/AQI warm-up {warm // 60}:{warm % 60:02d}"
    else:
        gas = f"CO {payload['co']:>5.1f}{'*' if payload['co_sat'] else ' '} AQI {payload['aq']:>5.1f}"
    amb = f"AMB {payload['temp']:>4.1f}C" if "temp" in payload else "AMB  --"
    bat = f"chest {payload['batt_chest']:>3}% arm {payload.get('batt_arm', '--'):>3}%"
    alerts = ""
    if result and result.get("active_alerts"):
        alerts = " | " + ",".join(result["active_alerts"])
    tail = f" | {error}" if error else alerts
    return f"{head} {pri} | {vitals} | {gas} | {amb} | {bat}{tail}"


def main(argv=None):
    ap = argparse.ArgumentParser(description="HALO telemetry simulator (posts JSON to the backend)")
    ap.add_argument("--mode", choices=("nominal", "shift"), default="nominal")
    ap.add_argument("--id", default="HALO-01", help="responder id, HALO-NN (default HALO-01)")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between readings (default 1.0)")
    ap.add_argument("--backend", default=DEFAULT_BACKEND, help=f"backend base URL (default {DEFAULT_BACKEND})")
    args = ap.parse_args(argv)
    rid = args.id.strip().upper()
    if not re.match(r"^HALO-\d{2,3}$", rid):
        ap.error("--id must look like HALO-01")
    if not 0.2 <= args.interval <= 60:
        ap.error("--interval must be between 0.2 and 60 seconds")
    base = args.backend.rstrip("/")
    if not re.match(r"^https?://", base):
        ap.error("--backend must start with http:// or https://")

    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    print("=" * 66)
    print(f"  HALO Simulator - {args.mode} mode, {rid}, every {args.interval:g} s -> {base}/ingest")
    print("=" * 66)
    print("  Location : Bull Temple Rd, Basavanagudi, Bengaluru")
    print(f"  Lat/Lon  : {BASE_LAT}, {BASE_LON}")
    if args.mode == "shift":
        print("  Scenario : 30-minute loop exercising every alert (CORE TEMP from the second loop)")
    print()
    if not wait_for_backend(base):
        return 1

    sc = Scenario(args.mode, rid)
    last_phase = None
    last = time.monotonic()
    next_due = last
    try:
        while True:
            now = time.monotonic()
            dt = clamp(now - last, 0.0, 5 * args.interval) if sc.step else args.interval
            last = now
            payload = sc.tick(dt)
            for note in sc.notes:
                print(f"\n[SIM] {note}\n")
            if sc.phase() != last_phase:
                last_phase = sc.phase()
                print(f"\n=== {sc.phase_label()} ===")
            result, error = (None, None)
            if payload is not None:
                result, error = send(base + "/ingest", payload)
            print(status_line(sc, payload, result, error))
            next_due += args.interval
            delay = next_due - time.monotonic()
            if delay < -args.interval:          # fell behind (slow backend, laptop sleep): resync
                next_due, delay = time.monotonic(), 0.0
            time.sleep(max(0.0, delay))
    except KeyboardInterrupt:
        print("\n[SIM] Stopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
