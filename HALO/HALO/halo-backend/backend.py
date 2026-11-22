"""
HALO backend (Firebase edition), Session 4.

Reads chest-strap telemetry from the gateway ESP32 over USB serial (one text line per LoRa
packet: v2 "FMT:2" lines decoded from the binary packet, or legacy v1 text lines), and accepts
POST /ingest from the simulator (JSON) or a CSV bridge (one gateway line). For every reading it
derives the 15-min TWA CO, heat index, estimated core temperature, PSI, battery ETAs and LoRa
link loss, runs the alert state machine, and writes to the Firebase Realtime Database:

    live/<id>                     latest state per responder (fields unknown now are deleted)
    readings/<id>/<pushId>        every reading, for charts, the map trail and diagnostics
    alerts/<pushId>               alert events: raised / changed / ongoing / cleared
    hazards/<pushId>              map hazard points (CO, AIR, HEAT, FIRE_SUSPECTED, FALL, NO_MOTION)
    analytics/<id>/minutes/<min>  per-minute aggregates (key = epoch minute, 8 digits)
    analytics/<id>/sessions/<ms>  per-session performance summary (key = start epoch ms, 13 digits)
    profiles/<id>                 age and HRmax used for the HR zones
    operators/<uid>               written from HALO_OPERATOR_UIDS (unused while the rules are public)

MQ warm-up: the MQ7/MQ135 heaters read high for the first 1-3 minutes after the chest powers up.
The 62-byte LoRa packet has no warm-up field, so for hardware lines (FMT:2) the backend derives
the seconds left from the chest uptime UP (whole minutes since boot): UP 0, 1, 2 give
mq_warmup_s 180, 120, 60, an upper bound on a 3-minute warm-up. An MQWARM key on the line, or
mq_warmup_s in JSON (the simulator), is used as sent. While mq_warmup_s > 0, live/<id>/mq_warmup_s
is set, the CO and air-quality values are stored in readings/ next to mq_warmup_s, and they raise
no CO, CO_TWA, AIR, FIRE_SUSPECTED or CO_SENSOR alert (active ones are cleared with the reason
"sensor warming up"). They are not added to the CO TWA and are left out of hazards and analytics.
UP restarts on every chest reset, so after an ESP32-only reset (watchdog, panic) with the heaters
still warm, CO and air-quality alerts are held off for up to 3 minutes as well.

Install:
    pip install fastapi uvicorn pyserial firebase-admin

Run:
    python backend.py

Put serviceAccountKey.json in the same folder as this file and keep it out of git.

Environment variables:
    HALO_HOST           bind address (default 127.0.0.1, loopback only; see Security)
    HALO_PORT           TCP port (default 8000)
    HALO_COM_PORT       force the gateway's serial port, e.g. COM3 (default: auto-detect
                        CP210x / CH340 / FTDI). PowerShell: $env:HALO_COM_PORT="COM3"
    HALO_PROFILE_AGE    responder age in years for HRmax and the HR zones; when set it
                        replaces the ages in PROFILES and DEFAULT_PROFILE below (default 30)
    HALO_BENCH          1 = bench/demo mode: no-motion (man-down) alerts off, for a strap lying
                        on a table. The dashboard shows BENCH MODE. Never use on a worn strap
    HALO_OPERATOR_UIDS  comma-separated Firebase Auth UIDs; each gets operators/<uid> = true
                        at startup. Only needed if the database rules are changed to an
                        operator allowlist; the dashboard has no sign-in and the rules allow reads

Security:
    POST /ingest has no authentication. Any program that can reach the port can write
    readings and alerts to Firebase with the service account's admin rights (database rules do
    not apply to the Admin SDK). So the server binds to 127.0.0.1 by default and also:
      - accepts only Host: localhost, 127.0.0.1 or [::1] (blocks DNS-rebinding pages),
      - sends CORS headers only to the dashboard dev server (http://localhost:3000 and
        http://127.0.0.1:3000) and only for GET,
      - on /ingest, requires Content-Type application/json or text/csv (both need a CORS
        preflight, which is refused, so a web page cannot post), rejects any other Origin
        with 403, caps the body at 8 KB, and validates every field and the responder ID,
      - serves no /docs, /redoc or /openapi.json.
    Setting HALO_HOST to a LAN address or 0.0.0.0 exposes that unauthenticated write endpoint
    to everyone on the network. Don't. To reach the API from another machine, keep the
    loopback bind and use an SSH tunnel instead:
        ssh -N -L 8000:127.0.0.1:8000 <user>@<backend-host>
    and then use http://localhost:8000 on the other machine.
"""

import ipaddress
import json
import math
import os
import re
import sys
import threading
import time
import traceback
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import serial
from serial.tools import list_ports
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware
import firebase_admin
from firebase_admin import credentials, db as firebase_db

# ─── CONFIG ────────────────────────────────────────────────────────────────
COM_PORT        = os.environ.get("HALO_COM_PORT")   # None → auto-detect the gateway
BAUD_RATE       = 115200
USB_SERIAL_VIDS = {0x10C4: "CP210x", 0x1A86: "CH340", 0x0403: "FTDI"}   # ESP32 dev board USB chips
BASE_DIR        = os.path.dirname(os.path.abspath(__file__))
SERVICE_KEY     = os.path.join(BASE_DIR, "serviceAccountKey.json")
DATABASE_URL    = "https://halo-223051-default-rtdb.asia-southeast1.firebasedatabase.app"
DEVICE_ID       = "HALO-01"   # responder ID used when a JSON reading has no "id"

HOST = os.environ.get("HALO_HOST", "127.0.0.1")
# Bench/demo mode: the strap lies on a table, so "worn and motionless" is normal there and the
# man-down (NO_MOTION) alert would fire in every demo. Never enable this on a worn strap.
BENCH_MODE = os.environ.get("HALO_BENCH", "").strip().lower() in ("1", "true", "yes", "on")
PORT = int(os.environ.get("HALO_PORT", "8000"))

ALLOWED_HOSTS     = ["localhost", "127.0.0.1", "[::1]"]
DASHBOARD_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")
MAX_BODY_BYTES    = 8 * 1024
FIREBASE_TIMEOUT_S = 10       # per request; the default (120 s) would stall the serial thread

# Responder profiles for the HR zones (SPEC §8.7). hr_rest None → the session estimate, else 70.
PROFILES        = {"HALO-01": {"age": 30, "hr_rest": None}}
DEFAULT_PROFILE = {"age": 30, "hr_rest": None}
HR_REST_FALLBACK = 70
HR_MAX_METHOD   = "Tanaka 208 - 0.7 × age"


def _env_profile_age():
    raw = os.environ.get("HALO_PROFILE_AGE")
    if raw is None or not raw.strip():
        return None
    try:
        age = int(raw.strip())
    except ValueError:
        age = None
    if age is None or not 10 <= age <= 100:
        print(f"[CONFIG] Ignoring HALO_PROFILE_AGE={raw!r}: expected whole years between 10 and 100")
        return None
    return age


PROFILE_AGE_OVERRIDE = _env_profile_age()

# ─── FIREBASE INIT ─────────────────────────────────────────────────────────
cred = credentials.Certificate(SERVICE_KEY)
if not getattr(firebase_admin, "_apps", None):
    firebase_admin.initialize_app(cred, {"databaseURL": DATABASE_URL, "httpTimeout": FIREBASE_TIMEOUT_S})

live_ref      = firebase_db.reference("live")
readings_ref  = firebase_db.reference("readings")
alerts_ref    = firebase_db.reference("alerts")
hazards_ref   = firebase_db.reference("hazards")
analytics_ref = firebase_db.reference("analytics")
profiles_ref  = firebase_db.reference("profiles")
operators_ref = firebase_db.reference("operators")

# ─── THRESHOLDS (keep in sync with chest_strap_v2.ino and the dashboard) ───
CO_WARNING_PPM  = 35    # NIOSH 8-hr REL
CO_CRITICAL_PPM = 200   # NIOSH ceiling
CO_TWA_LIMIT    = 35    # 15-min TWA above the 8-hr REL → sustained exposure warning
SPO2_CRITICAL   = 90
SPO2_WARNING    = 94
HR_CRITICAL     = 170
HR_HIGH         = 150
HR_LOW          = 40
CORE_CRITICAL   = 39.5  # estimated core temperature (°C)
CORE_WARNING    = 38.5
HEAT_EXTREME    = 51.7  # NWS heat index "Extreme Danger" (°C), ambient from the BME280
HEAT_DANGER     = 39.4  # NWS heat index "Danger"
HEAT_EXTREME_CAUTION = 32.2
HEAT_CAUTION    = 26.7
AQI_HAZARDOUS   = 300   # MQ135 relative index (0-500)
AQI_POOR        = 200
NO_MOTION_P0_S  = 60
NO_MOTION_P1_S  = 30
BATT_LOW_PCT    = 20
BATT_CRITICAL_PCT = 10

# ─── ALERT ENGINE CONFIG (SPEC §8.5) ───────────────────────────────────────
ALERT_REPEAT_SEC = 120     # re-log an active alert as "ongoing" this often
ALERT_CLEAR_SEC  = 10      # a condition must stay false (or weaker) this long before clear/downgrade
LINK_LOST_SEC    = 20      # no packet for this long → LINK alert
LINK_ONGOING_MAX_SEC = 600 # stop re-logging LINK as "ongoing" after this long without data
WATCHDOG_SEC     = 5

ALERT_KIND = {
    "FALL": "health", "NO_MOTION": "health", "CO": "env", "CO_TWA": "env", "AIR": "env",
    "FIRE_SUSPECTED": "env", "SPO2": "health", "HR": "health", "CORE_TEMP": "health",
    "HEAT": "env", "ARM_LINK": "device", "ARM_IMU": "device", "CO_SENSOR": "device",
    "BATT_CHEST": "device", "BATT_ARM": "device", "LINK": "link",
}
ALERT_CLEAR_OVERRIDE = {"FALL": 0, "LINK": 0}
PACKET_ALERT_TYPES = ("FALL", "NO_MOTION", "CO", "CO_TWA", "AIR", "FIRE_SUSPECTED", "SPO2", "HR",
                      "CORE_TEMP", "HEAT", "ARM_LINK", "ARM_IMU", "CO_SENSOR", "BATT_CHEST", "BATT_ARM")
HAZARD_TYPES = ("CO", "AIR", "HEAT", "FIRE_SUSPECTED", "FALL", "NO_MOTION")
HAZARD_UPDATE_MS = 10_000
HAZARD_SPLIT_M   = 30.0
HAZARD_UNKNOWN_ACC_M = 100   # acc_m for a hazard placed at a stale fix with no HDOP
# MQ7/MQ135 warm-up lockout (SPEC §12.5): the alert types computed from co, co_sat or aq. None of
# them is raised while mq_warmup_s > 0 (sent, or derived from the chest uptime in _finalize), and
# active ones are cleared at once (no 10 s hold: the values are not valid, so there is nothing to
# wait for).
MQ_ALERT_TYPES   = ("CO", "CO_TWA", "AIR", "FIRE_SUSPECTED", "CO_SENSOR")
MQ_WARMUP_REASON = "sensor warming up"
MQ_WARMUP_MIN    = 3       # hardware lines with UP (chest uptime, whole minutes) below this are warming
# Arm-strap alert types and the value each one is computed from. The value is unknown while the
# arm is silent (SPEC §8.3) or that arm sensor is down, and for HR/SpO2 also at 0 (no signal) and
# -1 (calibrating). Unknown is not "condition false": the alert keeps its severity and reason (as
# FALL does through fall_active) and clears normally once a valid value shows the condition is over.
ARM_ALERT_INPUTS = {"NO_MOTION": "still_s", "HR": "hr", "SPO2": "spo2", "HEAT": "heat_index",
                    "FIRE_SUSPECTED": "heat_index", "BATT_ARM": "batt_arm", "ARM_IMU": "sensors.imu"}


def arm_input_known(r, typ):
    """False when the value the arm alert type typ is computed from is unknown in reading r."""
    field = ARM_ALERT_INPUTS[typ]
    v = (r.get("sensors") or {}).get("imu") if field == "sensors.imu" else r.get(field)
    return v is not None and (typ not in ("HR", "SPO2") or v > 0)


def mq_warming(r):
    """True while the chest's MQ sensors are warming up (its co/aq/co_sat are not valid yet)."""
    w = r.get("mq_warmup_s")
    return w is not None and w > 0


# ─── ANALYTICS: HEAT INDEX, CORE TEMPERATURE, PSI, TWA ─────────────────────
def compute_heat_index(temp_c, rh):
    """NWS heat index (°C) from ambient temperature and relative humidity.
    Never reported below the air temperature (conservative in hot, dry air)."""
    if not rh or rh <= 0:
        return round(temp_c, 1)
    t = temp_c * 9 / 5 + 32
    hi = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094)
    if (hi + t) / 2 >= 80:
        hi = (-42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
              - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
              + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh)
        if rh < 13 and 80 <= t <= 112:
            hi -= ((13 - rh) / 4) * math.sqrt((17 - abs(t - 95)) / 17)
        elif rh > 85 and 80 <= t <= 87:
            hi += ((rh - 85) / 10) * ((87 - t) / 5)
    return round(max((hi - 32) * 5 / 9, temp_c), 1)


# Core temperature is not measured (the BME280 reads ambient air), so it is estimated
# from the heart-rate sequence with the Kalman filter of Buller et al. 2013,
# "Estimation of human core temperature from sequential heart rate observations",
# Physiol. Meas. 34:781 (validated RMSE ≈ 0.3 °C). Stepped once per minute. The published
# start values (37.1 °C, variance 0) make the estimate rise slowly during the first ~30 min.
CT_INIT  = 37.1
CT_GAMMA = 0.022 ** 2
CT_SIGMA = 18.88 ** 2
CT_B0, CT_B1, CT_B2 = -7887.1, 384.4286, -4.5714
CT_STALE_SEC = 600   # no valid HR for 10 min → estimate withdrawn; restarts from CT_INIT when HR returns


class CoreTempEstimator:
    def __init__(self):
        self._reset()
        self.minute_start = None
        self.hr_sum, self.hr_n = 0.0, 0
        self.last_hr_time = None

    def _reset(self):
        self.ct, self.v = CT_INIT, 0.0
        self.steps = 0                         # filter updates made with real HR data

    def update(self, hr, now):
        """Feed one HR reading (None or <= 0 = no valid HR). Returns the core temperature
        estimate (°C), or None until a full minute with valid HR has been processed, or
        when HR has been missing for longer than CT_STALE_SEC."""
        if hr and hr > 0:
            if self.last_hr_time is not None and now - self.last_hr_time > CT_STALE_SEC:
                self._reset()                  # long gap: the old estimate no longer applies
            self.last_hr_time = now
            self.hr_sum += hr
            self.hr_n += 1
        if self.minute_start is None:
            self.minute_start = now
        if now - self.minute_start >= 60:
            if self.hr_n:                      # no valid HR this minute → hold the estimate
                self._step(self.hr_sum / self.hr_n)
                self.steps += 1
            self.minute_start = now
            self.hr_sum, self.hr_n = 0.0, 0

        if self.steps == 0 or now - self.last_hr_time > CT_STALE_SEC:
            return None
        return round(self.ct, 2)

    def _step(self, hr):
        v_pred   = self.v + CT_GAMMA
        c        = 2 * CT_B2 * self.ct + CT_B1
        k        = v_pred * c / (c * c * v_pred + CT_SIGMA)
        hr_model = CT_B2 * self.ct ** 2 + CT_B1 * self.ct + CT_B0
        self.ct  = self.ct + k * (hr - hr_model)
        self.v   = (1 - k * c) * v_pred


# Physiological Strain Index, Moran et al. 1998 (0-10)
HR_REST = 70.0
PSI_HR_MAX, PSI_CORE_MAX = 180.0, 39.5


def compute_psi(hr, core_temp):
    """PSI from HR and the core estimate; None when either is not available."""
    if hr is None or hr <= 0 or core_temp is None:
        return None
    hr_c   = 5.0 * (hr - HR_REST) / (PSI_HR_MAX - HR_REST)
    core_c = 5.0 * (core_temp - CT_INIT) / (PSI_CORE_MAX - CT_INIT)
    return round(min(max(hr_c + core_c, 0), 10.0), 2)


# 15-min time-weighted average CO. Trapezoids between consecutive samples, divided by the time
# the samples cover (not by 900 s): exposure before monitoring started is unknown, so it is not
# assumed to be zero. Gaps longer than TWA_MAX_GAP_S are not interpolated and reduce coverage.
TWA_WINDOW = 900
TWA_MAX_GAP_S = 60
TWA_ALERT_MIN_COVERAGE_S = 300


def twa_update(history, now, co_ppm=None):
    """Add (now, co_ppm) to history (a deque), drop samples that have left the 15-min window and
    return (twa_ppm, coverage_s). co_ppm None adds no sample (CO unknown in this reading, or the
    MQ7 warming up) but the window still moves on. twa_ppm is None once no sample is left."""
    if co_ppm is not None:
        history.append((now, co_ppm))
    cutoff = now - TWA_WINDOW
    while len(history) >= 2 and history[1][0] <= cutoff:
        history.popleft()                      # keep one sample at or before the cutoff
    total = covered = 0.0
    prev = None
    for t1, c1 in history:
        if prev is not None:
            t0, c0 = prev
            dt = t1 - t0
            if 0 < dt <= TWA_MAX_GAP_S and t1 > cutoff:
                if t0 < cutoff:                # clip the first segment at the window start
                    c0 = c0 + (c1 - c0) * (cutoff - t0) / dt
                    dt = t1 - cutoff
                total += (c0 + c1) / 2.0 * dt
                covered += dt
        prev = (t1, c1)
    if covered > 0:
        return round(total / covered, 2), covered
    if history and history[-1][0] > cutoff:    # one sample in the window (e.g. the first one)
        return round(history[-1][1], 2), 0.0
    return None, 0.0


# ─── BATTERY (same SoC table as the firmware, SPEC §2) ─────────────────────
SOC_TABLE = ((4.20, 100), (4.15, 95), (4.11, 90), (4.08, 85), (4.02, 80), (3.98, 75), (3.95, 70),
             (3.91, 65), (3.87, 60), (3.85, 55), (3.84, 50), (3.82, 45), (3.80, 40), (3.79, 35),
             (3.77, 30), (3.75, 25), (3.73, 20), (3.71, 15), (3.69, 10), (3.61, 5), (3.27, 0))
BATT_WINDOW_S    = 30 * 60
BATT_MIN_SPAN_S  = 10 * 60
BATT_MIN_POINTS  = 10
BATT_SAMPLE_S    = 10           # keep at most one point per 10 s (<= 180 points in the window)
BATT_DISCHARGE_SLOPE = -0.02   # %/min
BATT_CHARGE_SLOPE    = 0.2     # %/min
BATT_ETA_CAP_MIN = 1440
BATT_JUMP_RESET_PCT = 10       # a jump up this big between points = battery swapped: restart the fit


def soc_from_voltage(v):
    """Li-ion state of charge (%) from cell voltage, piecewise linear, clamped 0..100."""
    if v >= SOC_TABLE[0][0]:
        return 100.0
    if v <= SOC_TABLE[-1][0]:
        return 0.0
    for (v_hi, p_hi), (v_lo, p_lo) in zip(SOC_TABLE, SOC_TABLE[1:]):
        if v >= v_lo:
            return p_lo + (p_hi - p_lo) * (v - v_lo) / (v_hi - v_lo)
    return 0.0


def battery_trend(history):
    """Least-squares slope over history [(t_s, pct)] → (eta_min, trend).
    (None, None) until the window spans >= 10 min with >= 10 points."""
    if len(history) < BATT_MIN_POINTS or history[-1][0] - history[0][0] < BATT_MIN_SPAN_S:
        return None, None
    t0 = history[0][0]
    xs = [(t - t0) / 60.0 for t, _ in history]
    ys = [p for _, p in history]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        return None, None
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    if slope <= BATT_DISCHARGE_SLOPE:
        return int(round(min(BATT_ETA_CAP_MIN, ys[-1] / -slope))), "discharging"
    if slope >= BATT_CHARGE_SLOPE:
        return None, "charging"
    return None, "stable"


# ─── ZONES AND BANDS (SPEC §8.7) ───────────────────────────────────────────
ACT_LIGHT_MG, ACT_MODERATE_MG, ACT_VIGOROUS_MG = 45, 100, 430   # ENMO cut-points (Hildebrand)
PSI_BANDS  = ("none", "low", "moderate", "high", "very_high")
HEAT_BANDS = ("caution", "extreme_caution", "danger", "extreme_danger")
ACT_BANDS  = ("sedentary", "light", "moderate", "vigorous")


def hr_max_for_age(age):
    return round(208 - 0.7 * age, 1)


def hr_zone(hr, hr_max):
    """Edwards zone 0-5 from % of HRmax: <50, 50-60, 60-70, 70-80, 80-90, >=90."""
    pct = 100.0 * hr / hr_max
    for zone, upper in enumerate((50, 60, 70, 80, 90)):
        if pct < upper:
            return zone
    return 5


def psi_band(psi):
    """Moran bands 0-2 none/little, 3-4 low, 5-6 moderate, 7-8 high, 9-10 very high
    (continuous values: band starts at 3, 5, 7 and 9)."""
    for band, upper in zip(PSI_BANDS, (3, 5, 7, 9)):
        if psi < upper:
            return band
    return PSI_BANDS[-1]


def heat_band(hi):
    """NWS heat index band, or None below caution (26.7 °C)."""
    if hi is None or hi < HEAT_CAUTION:
        return None
    if hi < HEAT_EXTREME_CAUTION:
        return "caution"
    if hi < HEAT_DANGER:
        return "extreme_caution"
    if hi < HEAT_EXTREME:
        return "danger"
    return "extreme_danger"


def activity_band(mg):
    if mg < ACT_LIGHT_MG:
        return "sedentary"
    if mg < ACT_MODERATE_MG:
        return "light"
    if mg < ACT_VIGOROUS_MG:
        return "moderate"
    return "vigorous"


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000.0 * math.asin(math.sqrt(min(1.0, a)))


def profile_for(rid):
    p = dict(DEFAULT_PROFILE)
    p.update(PROFILES.get(rid, {}))
    age = PROFILE_AGE_OVERRIDE if PROFILE_AGE_OVERRIDE is not None else p["age"]
    return {"id": rid, "age": age, "hr_max": hr_max_for_age(age), "hr_max_method": HR_MAX_METHOD,
            "hr_rest": p.get("hr_rest")}


# ─── INPUT: FIELDS, IDS, VALIDATION (SPEC §8.1, §8.3) ──────────────────────
class InputError(ValueError):
    """Rejected input. fields lists the offending keys (for the 400 response)."""

    def __init__(self, message, fields=None):
        super().__init__(message)
        self.fields = list(fields or [])


# canonical field → (type, min, max, decimals). JSON values outside the range are rejected
# (400); on a CSV line the field is dropped (treated as absent).
FIELDS = {
    "fmt":              ("int",   1, 9, None),
    "device_pri":       ("int",   0, 2, None),
    "seq":              ("int",   0, 65535, None),
    "lat":              ("float", -90.0, 90.0, 7),
    "lon":              ("float", -180.0, 180.0, 7),
    "alt":              ("float", -1000.0, 20000.0, 1),
    "gps_age_s":        ("int",   0, 65535, None),
    "gps_fresh":        ("bool",  None, None, None),
    "gps_uart":         ("bool",  None, None, None),
    "gps_sats":         ("int",   0, 255, None),
    "gps_hdop":         ("float", 0.0, 99.9, 1),
    "arm_ok":           ("bool",  None, None, None),
    "hr":               ("float", -1.0, 250.0, 1),      # -1 calibrating, 0 no signal
    "spo2":             ("float", -1.0, 100.0, 1),
    "ppg_q":            ("int",   0, 100, None),
    "skin":             ("bool",  None, None, None),
    "ppg_motion":       ("bool",  None, None, None),
    "activity_mg":      ("int",   0, 65535, None),
    "still_s":          ("int",   0, 65535, None),
    "temp":             ("float", -40.0, 85.0, 2),
    "hum":              ("float", 0.0, 100.0, 2),
    "pressure":         ("float", 300.0, 1100.0, 1),
    "bme_alt":          ("float", -1000.0, 10000.0, 1),
    "accel":            ("float", 0.0, 50.0, 3),         # g, magnitude
    "fall":             ("bool",  None, None, None),
    "co":               ("float", 0.0, 2000.0, 1),
    "co_raw_mv":        ("int",   0, 5000, None),
    "co_sat":           ("bool",  None, None, None),
    "aq":               ("float", 0.0, 500.0, 1),
    "aq_raw_mv":        ("int",   0, 5000, None),
    "mq_warmup_s":      ("int",   0, 255, None),         # MQ heater warm-up left; > 0 = CO/AQ not valid yet
    "batt_chest":       ("int",   0, 100, None),
    "vbat_chest":       ("float", 0.0, 6.0, 3),
    "batt_arm":         ("int",   0, 100, None),
    "vbat_arm":         ("float", 0.0, 6.0, 3),
    "arm_loss_pct":     ("int",   0, 100, None),
    "arm_sensors":      ("int",   0, 255, None),         # IMU 1, BME 2, PPG 4, BATT 8
    "lora_reinits":     ("int",   0, 255, None),
    "chest_uptime_min": ("int",   0, 65535, None),
    "rssi":             ("float", -200.0, 50.0, 1),
    "snr":              ("float", -50.0, 50.0, 1),
    "batt":             ("float", 0.0, 100.0, 1),        # legacy: becomes batt_chest
}
CSV_ONLY_FIELDS = frozenset(("fmt", "device_pri", "lora_reinits", "chest_uptime_min"))
JSON_FIELDS     = frozenset(FIELDS) - CSV_ONLY_FIELDS
ALL_FIELDS      = frozenset(FIELDS)
JSON_ALIASES    = {"gps_ok": "gps_fresh"}               # legacy simulator key
# A reading needs at least one of these. mq_warmup_s only qualifies co/aq, so on its own it is
# not telemetry (a reading with nothing else would delete every live field).
DATA_FIELDS     = frozenset(FIELDS) - frozenset(("fmt", "device_pri", "seq", "mq_warmup_s"))

# Arm-strap values: unknown while arm_ok is False (SPEC §8.3)
ARM_FIELDS = ("hr", "spo2", "ppg_q", "skin", "ppg_motion", "activity_mg", "still_s", "temp", "hum",
              "pressure", "bme_alt", "accel", "batt_arm", "vbat_arm")
# arm_sensors bit 0 (ARM_SENS_IMU): MPU6050 answering. While it is clear the arm sends 0 for
# activity and stillness and the gateway still prints ACT/STILL, so these are placeholders.
ARM_SENS_IMU = 0x01
IMU_FIELDS   = ("activity_mg", "still_s", "accel")

# CSV key(s) per canonical field, in priority order (v2 line from the gateway, SPEC §7; v1 keys too)
CSV_FIELD_KEYS = (
    ("fmt", ("FMT",)), ("device_pri", ("PRI",)), ("seq", ("SEQ",)),
    ("lat", ("LAT",)), ("lon", ("LNG", "LON")), ("alt", ("ALT",)), ("gps_age_s", ("GPSAGE",)),
    ("gps_fresh", ("GPS",)), ("gps_uart", ("GPSU",)), ("gps_sats", ("SATS",)), ("gps_hdop", ("HDOP",)),
    ("arm_ok", ("ARM",)), ("hr", ("HR",)), ("spo2", ("SPO2",)), ("ppg_q", ("PPGQ",)),
    ("skin", ("SKIN",)), ("ppg_motion", ("MOTION",)), ("activity_mg", ("ACT",)), ("still_s", ("STILL",)),
    ("temp", ("TEMP",)), ("hum", ("HUM",)), ("pressure", ("PRES", "PRESSURE")), ("bme_alt", ("BALT",)),
    ("fall", ("FALL",)), ("co", ("CO",)), ("co_raw_mv", ("COR",)), ("co_sat", ("COSAT",)),
    ("aq", ("AQI", "AQ")), ("aq_raw_mv", ("AQR",)), ("mq_warmup_s", ("MQWARM",)),
    ("batt_chest", ("BATC",)), ("vbat_chest", ("VBC",)), ("batt_arm", ("BATA",)), ("vbat_arm", ("VBA",)),
    ("arm_loss_pct", ("ARMLOSS",)), ("arm_sensors", ("ASENS",)), ("lora_reinits", ("REINIT",)),
    ("chest_uptime_min", ("UP",)), ("rssi", ("RSSI",)), ("snr", ("SNR",)), ("batt", ("BATT", "BAT")),
)
# Legacy v1 lines (no ARM key) send 0 for "arm silent / no sensor"; those zeros mean unknown.
LEGACY_ZERO_UNKNOWN = ("temp", "hum", "pressure", "bme_alt", "batt")
STANDARD_GRAVITY = 9.80665

ID_RE = re.compile(r"^HALO-\d{2,3}$")
_ID_NUM_RE = re.compile(r"^HALO-(\d{1,3})$")


def normalize_id(raw_id):
    """Normalize a responder ID variant to the canonical form: HALO01, halo-01, HALO_01,
    "halo 1", HALO-001 → HALO-01. None → DEVICE_ID. Validate the result with validate_id()."""
    if raw_id is None:
        return DEVICE_ID
    if not isinstance(raw_id, str):
        raise InputError("id must be a string", ["id"])
    cleaned = raw_id.strip().upper().replace("_", "-").replace(" ", "-")
    if cleaned.startswith("HALO") and not cleaned.startswith("HALO-"):
        cleaned = "HALO-" + cleaned[4:]
    m = _ID_NUM_RE.match(cleaned)
    if m:
        cleaned = "HALO-%02d" % int(m.group(1))
    return cleaned


def validate_id(rid):
    if not isinstance(rid, str) or not ID_RE.match(rid):
        raise InputError("bad responder id (expected HALO-NN or HALO-NNN)", ["id"])
    return rid


def _coerce_json(field, value):
    """Strict JSON value check: numbers are int/float (not bool), finite and in range;
    booleans are true/false or 0/1. Raises ValueError."""
    kind, lo, hi, dec = FIELDS[field]
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, int) and value in (0, 1):
            return bool(value)
        raise ValueError(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(field)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(field)
    if not lo <= value <= hi:
        raise ValueError(field)
    if kind == "int":
        return int(round(value))
    return round(float(value), dec)


def _coerce_csv(field, text):
    """CSV value → typed value, or None (dropped) when it is not a finite number in range."""
    try:
        x = float(text)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x):
        return None
    kind, lo, hi, dec = FIELDS[field]
    if kind == "bool":
        return True if x == 1 else False if x == 0 else None
    if not lo <= x <= hi:
        return None
    if kind == "int":
        return int(round(x))
    return round(x, dec)


def _canonicalize(obj, allowed):
    """Allowlist + strict types. Returns (fields, ignored_keys); raises InputError listing
    every bad field. Unknown keys are dropped; null values count as absent."""
    if not isinstance(obj, dict):
        raise InputError("JSON body must be an object")
    out, bad, ignored = {}, [], []
    for key, value in obj.items():
        if key == "id":
            continue
        field = JSON_ALIASES.get(key, key)
        if field != key and field in obj:       # the canonical key wins over its alias
            ignored.append(key)
            continue
        if field not in allowed:
            ignored.append(str(key))
            continue
        if value is None:
            continue
        try:
            out[field] = _coerce_json(field, value)
        except (ValueError, TypeError, OverflowError):
            bad.append(str(key))
    try:
        rid = validate_id(normalize_id(obj.get("id")))
    except InputError:
        bad.append("id")
        rid = None
    if bad:
        raise InputError("invalid fields", sorted(set(bad)))
    if not any(k in out for k in DATA_FIELDS):
        raise InputError("no telemetry fields")
    out["id"] = rid
    return out, sorted(ignored)


def validate_json(obj):
    """Validate a JSON reading (simulator / JSON clients). Returns (fields, ignored_keys)."""
    return _canonicalize(obj, JSON_FIELDS)


def _parse_csv(line):
    """Gateway text line → canonical fields. Raises InputError with the reason."""
    if not isinstance(line, str):
        raise InputError("line must be text")
    line = line.strip()
    if not line.startswith("ID:"):
        raise InputError("not a HALO telemetry line (must start with 'ID:')")
    if not line.isascii() or not line.isprintable():
        raise InputError("line contains non-printable characters (send one line per request)")
    pairs = {}
    for token in line.split(","):
        key, sep, val = token.partition(":")
        if sep:
            pairs[key.strip().upper()] = val.strip()
    rid = validate_id(normalize_id(pairs.get("ID")))
    d = {"id": rid}
    for field, keys in CSV_FIELD_KEYS:
        for k in keys:
            if k in pairs:
                v = _coerce_csv(field, pairs[k])
                if v is not None:
                    d[field] = v
                    break
    legacy = "ARM" not in pairs
    axes = []
    for k in ("AX", "AY", "AZ"):
        try:
            x = float(pairs[k])
        except (KeyError, ValueError):
            break
        if not math.isfinite(x):
            break
        axes.append(x)
    if len(axes) == 3:
        # v1 sends 0,0,0 when the arm is silent; v2 only sends axes when the IMU is up
        if any(axes) or not legacy:
            mag = math.sqrt(sum(a * a for a in axes)) / STANDARD_GRAVITY
            if mag <= FIELDS["accel"][2]:
                d["accel"] = round(mag, 3)
    elif "ACCEL" in pairs:
        v = _coerce_csv("accel", pairs["ACCEL"])
        if v is not None and (v or not legacy):
            d["accel"] = v
    if d.get("fmt") == 2 and ("RSSI" not in pairs or "SNR" not in pairs):
        raise InputError("truncated v2 line (RSSI/SNR missing)")
    if "FMT" not in pairs:
        d["fmt"] = 1                           # pre-v2 gateways forward v1 text unchanged
    if legacy:
        for k in LEGACY_ZERO_UNKNOWN:
            if d.get(k) == 0:
                del d[k]
        if d.get("lat") == 0 or d.get("lon") == 0:   # v1 sends 0,0 before the first fix
            for k in ("lat", "lon", "alt"):
                d.pop(k, None)
    if not any(k in d for k in DATA_FIELDS):
        raise InputError("no telemetry fields")
    return d


def parse_lora_csv(line):
    """Parse one gateway line. Returns the canonical fields, or None if the line is not a
    complete HALO telemetry line (no 'ID:' prefix, bad ID, truncated v2 line)."""
    try:
        return _parse_csv(line)
    except InputError:
        return None


def _finalize(fields):
    """Shared semantics after parsing (SPEC §8.3): legacy batt, unmeasured voltages, arm-strap
    fields unknown while arm_ok is False or the arm's IMU is down, and the MQ warm-up of a
    hardware line derived from the chest uptime."""
    d = dict(fields)
    if "batt" in d:
        b = d.pop("batt")
        if "batt_chest" not in d:
            d["batt_chest"] = int(round(b))
    for k in ("vbat_chest", "vbat_arm"):
        if k in d and d[k] <= 0:               # 0 V = not measured
            del d[k]
    if d.get("arm_ok") is False:
        for k in ARM_FIELDS:
            d.pop(k, None)
        d.pop("arm_sensors", None)             # the chest sends 0 when the arm is silent
    if d.get("arm_sensors") is not None and not d["arm_sensors"] & ARM_SENS_IMU:
        for k in IMU_FIELDS:
            d.pop(k, None)
    up = d.get("chest_uptime_min")
    if d.get("fmt") == 2 and "mq_warmup_s" not in d and up is not None and up < MQ_WARMUP_MIN:
        d["mq_warmup_s"] = (MQ_WARMUP_MIN - up) * 60   # see "MQ warm-up" in the module docstring
    return d


# ─── SANITISING (no NaN/Inf ever reaches Firebase) ─────────────────────────
def _clean(value):
    """Recursively replace non-finite floats with None and drop None entries and empty
    dicts inside dicts."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            cv = _clean(v)
            if cv is None or (isinstance(cv, dict) and not cv):
                continue
            out[k] = cv
        return out
    if isinstance(value, (list, tuple)):
        return [x for x in (_clean(v) for v in value) if x is not None]
    return value


def _clean_update(fields):
    """For update(): keep top-level None (it deletes the key in Firebase)."""
    out = {}
    for k, v in fields.items():
        cv = _clean(v)
        out[k] = None if isinstance(cv, dict) and not cv else cv
    return out


def _fb_update(ref, value, what):
    try:
        ref.update(_clean_update(value))
        return True
    except Exception as e:
        print(f"[FIREBASE] {what} update failed: {e!r}")
        return False


def _fb_set(ref, value, what):
    try:
        ref.set(_clean(value))
        return True
    except Exception as e:
        print(f"[FIREBASE] {what} write failed: {e!r}")
        return False


def _fb_push(ref, value, what):
    """Push a record; returns the new push key ("" if the SDK gave none), or None on failure."""
    try:
        child = ref.push(_clean(value))
    except Exception as e:
        print(f"[FIREBASE] {what} push failed: {e!r}")
        return None
    key = getattr(child, "key", None)
    return key if isinstance(key, str) else ""


def make_timestamps(now=None):
    """(ts, ts_ms) for one instant: ISO 8601 local time with UTC offset and milliseconds,
    e.g. 2026-11-22T18:30:05.123+05:30, and the same instant as epoch milliseconds."""
    now = time.time() if now is None else now
    ts_ms = int(now * 1000)
    dt = datetime.fromtimestamp(ts_ms // 1000, tz=timezone.utc).replace(microsecond=(ts_ms % 1000) * 1000)
    return dt.astimezone().isoformat(timespec="milliseconds"), ts_ms


def _n(v):
    """Number for alert text: one decimal, or none when it is a whole number."""
    r = round(float(v), 1)
    return str(int(r)) if r == int(r) else f"{r:.1f}"


def _fmt_minutes(m):
    m = int(round(m))
    if m < 60:
        return f"{m} min"
    h, mm = divmod(m, 60)
    return f"{h}h{mm:02d}m" if mm else f"{h}h"


def _fmt_age(seconds):
    """Elapsed time, whole units (floored): "45 s", "21 min", "2h05m"."""
    s = int(seconds)
    if s < 120:
        return f"{s} s"
    return _fmt_minutes(s // 60)


# ─── PER-RESPONDER STATE ───────────────────────────────────────────────────
STATE_LOCK = threading.Lock()   # guards everything below; held for whole readings and watchdog ticks
RESPONDERS = {}                 # id → Responder
_PENDING_ALERTS = deque(maxlen=500)   # alert records whose push failed; retried by the watchdog
_PROFILES_WRITTEN = set()


class AlertState:
    __slots__ = ("severity", "reason", "since_ms", "last_logged_ms", "clear_pending_since",
                 "down_pending_since")

    def __init__(self, severity, reason, now_ms):
        self.severity = severity
        self.reason = reason
        self.since_ms = now_ms
        self.last_logged_ms = now_ms
        self.clear_pending_since = None   # condition false since (ms)
        self.down_pending_since = None    # condition weaker than severity since (ms)


class HazardState:
    __slots__ = ("key", "lat", "lon", "peak", "value", "severity", "last_write_ms", "sat")


class LinkLossTracker:
    """LoRa loss from chest seq gaps over the last 100 expected packets (uint16 wrap).
    The window restarts when seq jumps backwards or the chest uptime decreases (chest reboot)."""
    WINDOW = 100

    def __init__(self):
        self.reset()

    def reset(self):
        self.window = deque()
        self.last_seq = None
        self.last_uptime = None

    def add(self, seq, uptime_min=None):
        if self.last_seq is not None:
            rebooted = (uptime_min is not None and self.last_uptime is not None
                        and uptime_min < self.last_uptime)
            diff = (seq - self.last_seq) % 65536
            if rebooted or diff > 32768:
                self.reset()
            elif diff == 0:
                return self.pct()              # duplicate
            else:
                for _ in range(min(diff - 1, self.WINDOW)):
                    self.window.append(0)
        self.window.append(1)
        while len(self.window) > self.WINDOW:
            self.window.popleft()
        self.last_seq = seq
        if uptime_min is not None:
            self.last_uptime = uptime_min
        return self.pct()

    def pct(self):
        if not self.window:
            return None
        return int(round(100.0 * (len(self.window) - sum(self.window)) / len(self.window)))


class Responder:
    def __init__(self, rid):
        self.id = rid
        self.profile = profile_for(rid)
        self.core = CoreTempEstimator()
        self.co_hist = deque()
        self.twa = None
        self.twa_cov = 0.0
        self.fall_active = False
        self.alerts = {}
        self.priority = 2
        self.last_packet = None            # epoch s of the last reading
        self.link_lost = False
        self.link_reason_text = None
        self.pos = None                    # (lat, lon, acc_m) of the last known fix
        self.hazards = {}
        self.batt_hist = {"chest": deque(), "arm": deque()}
        self.batt_eta = {"chest": (None, None), "arm": (None, None)}
        self.loss = LinkLossTracker()
        self.minute = None
        self.minute_flushed_ms = 0
        self.minute_dirty = False
        self.session = None
        self.session_flushed_ms = 0
        self.session_dirty = False
        self.resume_checked = False
        self.last_source = None            # (source, epoch s) of the previous reading
        self.mixed_warned_at = 0.0


def reset_state():
    """Forget all per-responder state (tests and restarts)."""
    with STATE_LOCK:
        RESPONDERS.clear()
        _PENDING_ALERTS.clear()
        _PROFILES_WRITTEN.clear()


def _write_profile(rid, now_ms):
    p = profile_for(rid)
    doc = dict(p)
    if doc.get("hr_rest") is None:
        doc["hr_rest"] = HR_REST_FALLBACK
    doc["updated_ms"] = now_ms
    if _fb_set(profiles_ref.child(rid), doc, f"profiles/{rid}"):
        _PROFILES_WRITTEN.add(rid)


def _responder(rid, now_ms):
    st = RESPONDERS.get(rid)
    if st is None:
        st = Responder(rid)
        RESPONDERS[rid] = st
        if rid not in _PROFILES_WRITTEN:
            _write_profile(rid, now_ms)
    return st


# ─── ALERTS (SPEC §8.5) ────────────────────────────────────────────────────
def evaluate_alerts(r, st):
    """Current condition per alert type: {type: (severity, reason)}. LINK is the watchdog's.
    While the MQ sensors warm up, co/co_sat/aq count as unknown, so no MQ_ALERT_TYPES entry."""
    c = {}
    warming = mq_warming(r)
    fall = st.fall_active
    if fall:
        c["FALL"] = (0, "FALL DETECTED")

    still, skin = r.get("still_s"), r.get("skin")
    if not BENCH_MODE and still is not None and (skin is True or fall):
        if still >= NO_MOTION_P0_S:
            c["NO_MOTION"] = (0, f"NO MOTION {still} s")
        elif still >= NO_MOTION_P1_S:
            c["NO_MOTION"] = (1, f"NO MOTION {still} s")

    co = None if warming else r.get("co")
    sat = not warming and r.get("co_sat") is True
    if sat:
        if co is not None:
            c["CO"] = (0 if co >= CO_CRITICAL_PPM else 1, f"CO ≥ {_n(co)} ppm (sensor saturated)")
        else:
            c["CO"] = (1, "CO above the sensor range (sensor saturated)")
        c["CO_SENSOR"] = (1, "CO SENSOR SATURATED")
    elif co is not None:
        if co > CO_CRITICAL_PPM:
            c["CO"] = (0, f"CO CRITICAL: {_n(co)} ppm")
        elif co > CO_WARNING_PPM:
            c["CO"] = (1, f"CO ELEVATED: {_n(co)} ppm")

    if (not warming and st.twa is not None and st.twa > CO_TWA_LIMIT
            and st.twa_cov >= TWA_ALERT_MIN_COVERAGE_S):
        c["CO_TWA"] = (1, f"CO 15-MIN TWA HIGH: {_n(round(st.twa))} ppm")

    aq = None if warming else r.get("aq")
    if aq is not None and aq > AQI_HAZARDOUS:
        c["AIR"] = (1, f"AIR QUALITY HAZARDOUS: index {aq:.0f}")

    hi = r.get("heat_index")
    if hi is not None and hi >= HEAT_DANGER and (
            (aq is not None and aq > AQI_POOR) or (co is not None and co > CO_WARNING_PPM)):
        parts = [f"heat index {hi:.1f}°C"]
        if co is not None:
            parts.append(f"CO {_n(co)} ppm")
        if aq is not None:
            parts.append(f"AQI {aq:.0f}")
        c["FIRE_SUSPECTED"] = (1, "POSSIBLE FIRE/SMOKE: " + ", ".join(parts))

    spo2 = r.get("spo2")
    if spo2 is not None and 0 < spo2 < SPO2_CRITICAL:
        c["SPO2"] = (0, f"SpO2 CRITICAL: {_n(spo2)}%")
    elif spo2 is not None and 0 < spo2 < SPO2_WARNING:
        c["SPO2"] = (1, f"SpO2 LOW: {_n(spo2)}%")

    hr = r.get("hr")
    if hr is not None and hr > HR_CRITICAL:
        c["HR"] = (0, f"HR CRITICAL: {_n(hr)} bpm")
    elif hr is not None and hr > HR_HIGH:
        c["HR"] = (1, f"HR HIGH: {_n(hr)} bpm")
    elif hr is not None and 0 < hr < HR_LOW:
        c["HR"] = (1, f"HR LOW: {_n(hr)} bpm")

    core = r.get("core_temp_est")
    if core is not None and core > CORE_CRITICAL:
        c["CORE_TEMP"] = (0, f"CORE TEMP (EST) CRITICAL: {core:.1f}°C")
    elif core is not None and core > CORE_WARNING:
        c["CORE_TEMP"] = (1, f"CORE TEMP (EST) HIGH: {core:.1f}°C")

    if hi is not None and hi >= HEAT_EXTREME:
        c["HEAT"] = (0, f"EXTREME HEAT: heat index {hi:.1f}°C")
    elif hi is not None and hi >= HEAT_DANGER:
        c["HEAT"] = (1, f"HEAT DANGER: heat index {hi:.1f}°C")

    if r.get("arm_ok") is False:
        c["ARM_LINK"] = (1, "ARM STRAP OFFLINE")
    if (r.get("sensors") or {}).get("imu") is False:    # arm link up, MPU6050 down: no fall detection
        c["ARM_IMU"] = (1, "ARM IMU OFFLINE")

    for typ, side, label in (("BATT_CHEST", "chest", "CHEST"), ("BATT_ARM", "arm", "ARM")):
        pct = r.get(f"batt_{side}")
        if pct is not None and pct < BATT_LOW_PCT:
            level = "CRITICAL" if pct < BATT_CRITICAL_PCT else "LOW"
            eta = st.batt_eta[side][0]
            text = f"{label} BATTERY {level}: {pct}%"
            if eta is not None:
                text += f" (~{_fmt_minutes(eta)} left)"
            c[typ] = (1, text)
    return c


def _alert_record(rid, typ, severity, reason, event, ts, ts_ms):
    return {"ts": ts, "ts_ms": ts_ms, "responder_id": rid, "type": typ, "kind": ALERT_KIND[typ],
            "priority": severity, "reason": reason, "event": event}


def step_alert(st, typ, target, now_ms, ts, ts_ms, events):
    """Advance one alert type's state. target = (severity, reason) or None (condition false).
    Appends alert records (raised / changed / ongoing / cleared) to events."""
    hold_ms = ALERT_CLEAR_OVERRIDE.get(typ, ALERT_CLEAR_SEC) * 1000
    a = st.alerts.get(typ)
    if a is None:
        if target is not None:
            a = AlertState(target[0], target[1], now_ms)
            st.alerts[typ] = a
            events.append(_alert_record(st.id, typ, a.severity, a.reason, "raised", ts, ts_ms))
        return
    if target is None:
        a.down_pending_since = None
        if a.clear_pending_since is None:
            a.clear_pending_since = now_ms
        if now_ms - a.clear_pending_since >= hold_ms:
            del st.alerts[typ]
            events.append(_alert_record(st.id, typ, a.severity, a.reason, "cleared", ts, ts_ms))
            return
    else:
        severity, reason = target
        a.clear_pending_since = None
        if severity < a.severity:              # escalation: immediate
            a.severity, a.reason = severity, reason
            a.down_pending_since = None
            events.append(_alert_record(st.id, typ, severity, reason, "changed", ts, ts_ms))
            a.last_logged_ms = now_ms
        elif severity == a.severity:
            a.reason = reason
            a.down_pending_since = None
        else:                                  # weaker: downgrade after the same hold as a clear;
            if a.down_pending_since is None:   # until then the reason text stays at the held level
                a.down_pending_since = now_ms
            if now_ms - a.down_pending_since >= hold_ms:
                a.severity, a.reason = severity, reason
                a.down_pending_since = None
                events.append(_alert_record(st.id, typ, severity, reason, "changed", ts, ts_ms))
                a.last_logged_ms = now_ms
    _log_ongoing(st, typ, a, now_ms, ts, ts_ms, events)


def _log_ongoing(st, typ, a, now_ms, ts, ts_ms, events):
    if now_ms - a.last_logged_ms >= ALERT_REPEAT_SEC * 1000:
        events.append(_alert_record(st.id, typ, a.severity, a.reason, "ongoing", ts, ts_ms))
        a.last_logged_ms = now_ms


def hold_alert(st, typ, now_ms, ts, ts_ms, events):
    """The input of typ is unknown in this reading: nothing is raised, and an active alert keeps
    its severity, reason and any pending clear or downgrade (those complete on the next reading
    with a known value). It is still re-logged as "ongoing"."""
    a = st.alerts.get(typ)
    if a is not None:
        _log_ongoing(st, typ, a, now_ms, ts, ts_ms, events)


def clear_alert_now(st, typ, ts, ts_ms, events, reason=None):
    """End an active alert at once (no hold) and log "cleared" with the severity it had.
    reason None keeps the alert's last reason text."""
    a = st.alerts.pop(typ, None)
    if a is not None:
        events.append(_alert_record(st.id, typ, a.severity, a.reason if reason is None else reason,
                                    "cleared", ts, ts_ms))


def responder_priority(st):
    """min severity over active health/env alerts plus ARM_LINK; 2 when there are none."""
    sev = [a.severity for typ, a in st.alerts.items()
           if ALERT_KIND[typ] in ("health", "env") or typ == "ARM_LINK"]
    return min(sev) if sev else 2


def active_alerts_map(st):
    return {typ: {"severity": a.severity, "reason": a.reason, "kind": ALERT_KIND[typ],
                  "since_ms": a.since_ms}
            for typ, a in st.alerts.items()} or None


def _push_alerts(events):
    for rec in events:
        if _fb_push(alerts_ref, rec, "alert") is None:
            _PENDING_ALERTS.append(rec)


def _retry_pending_alerts():
    while _PENDING_ALERTS:
        rec = _PENDING_ALERTS[0]
        if _fb_push(alerts_ref, rec, "alert (retry)") is None:
            return
        _PENDING_ALERTS.popleft()


# ─── HAZARDS (SPEC §8.6) ───────────────────────────────────────────────────
def _hazard_value(typ, r):
    if typ == "CO":
        return r.get("co")
    if typ == "AIR":
        return r.get("aq")
    if typ in ("HEAT", "FIRE_SUSPECTED"):
        return r.get("heat_index")
    if typ == "NO_MOTION":
        return r.get("still_s")
    return 1                                   # FALL


def _hazard_open(st, typ, a, value, pos, pos_stale, now_ms, sat=None):
    """sat (CO only, else None): the MQ7 was saturated, so value and peak are lower bounds."""
    lat, lon, acc = pos
    rec = {"responder_id": st.id, "type": typ, "severity": a.severity, "value": value,
           "peak": value, "lat": lat, "lon": lon,
           "acc_m": acc if acc is not None else HAZARD_UNKNOWN_ACC_M, "pos_stale": pos_stale,
           "start_ms": now_ms, "last_ms": now_ms, "active": True}
    if sat is not None:
        rec["sat"] = sat
    key = _fb_push(hazards_ref, rec, "hazard")
    if key is None:
        return                                 # push failed: retried on the next reading
    h = HazardState()
    h.key, h.lat, h.lon, h.peak, h.value = key, lat, lon, value, value
    h.severity, h.last_write_ms, h.sat = a.severity, now_ms, sat
    st.hazards[typ] = h


def _hazard_fields(h, now_ms):
    upd = {"severity": h.severity, "value": h.value, "peak": h.peak, "last_ms": now_ms}
    if h.sat is not None:
        upd["sat"] = h.sat
    return upd


def _hazard_close(st, typ, now_ms):
    h = st.hazards.pop(typ, None)
    if h is None or not h.key:
        return
    _fb_update(hazards_ref.child(h.key), dict(_hazard_fields(h, now_ms), active=False), "hazard close")


def update_hazards(st, r, now_ms, escalated, gps_ok):
    """Open, refresh, split and close hazard points for the map. A CO hazard's sat turns true
    when a saturated reading arrives and stays true: its peak is then a lower bound."""
    pos = st.pos
    pos_stale = not gps_ok
    for typ in HAZARD_TYPES:
        a = st.alerts.get(typ)
        h = st.hazards.get(typ)
        if a is None:
            if h is not None:
                _hazard_close(st, typ, now_ms)
            continue
        value = _hazard_value(typ, r)
        sat = (r.get("co_sat") is True) if typ == "CO" else None
        if h is None:
            if pos is not None:
                _hazard_open(st, typ, a, value, pos, pos_stale, now_ms, sat)
            continue
        h.severity = a.severity                # kept current; written at most every 10 s
        if value is not None:
            h.value = value
            h.peak = value if h.peak is None else max(h.peak, value)
        if sat and not h.sat:
            h.sat = True
            escalated = escalated | {typ}      # write the flag now, not up to 10 s later
        if pos is not None and gps_ok and haversine_m(h.lat, h.lon, pos[0], pos[1]) > HAZARD_SPLIT_M:
            _hazard_close(st, typ, now_ms)     # moved > 30 m: close here, open at the new point
            _hazard_open(st, typ, a, value, pos, pos_stale, now_ms, sat)
            continue
        if h.key and (typ in escalated or now_ms - h.last_write_ms >= HAZARD_UPDATE_MS):
            h.last_write_ms = now_ms
            _fb_update(hazards_ref.child(h.key), _hazard_fields(h, now_ms), "hazard")


def close_stale_hazards():
    """Hazards left active by a previous run: mark them inactive (new ones open on the next
    reading if the condition still holds)."""
    try:
        snap = hazards_ref.order_by_key().limit_to_last(300).get()
    except Exception as e:
        print(f"[FIREBASE] reading hazards failed: {e!r}")
        return 0
    if not isinstance(snap, dict):
        return 0
    closed = 0
    for key, h in snap.items():
        if isinstance(h, dict) and h.get("active") is True and re.match(r"^[-_A-Za-z0-9]{1,64}$", str(key)):
            if _fb_update(hazards_ref.child(key), {"active": False}, "stale hazard"):
                closed += 1
    if closed:
        print(f"[HAZARDS] Closed {closed} hazard(s) left active by the previous run")
    return closed


# ─── ANALYTICS: MINUTES AND SESSIONS (SPEC §8.7) ───────────────────────────
SESSION_GAP_MS   = 10 * 60 * 1000
DT_CAP_MS        = 30 * 1000
MINUTE_FLUSH_MS  = 15 * 1000
SESSION_FLUSH_MS = 60 * 1000
SED_HR_MAX       = 1440
ACC_VERSION      = 1


def _agg():
    return {"n": 0, "sum": 0.0, "min": None, "max": None}


def _agg_add(a, v):
    a["n"] += 1
    a["sum"] += v
    if a["min"] is None or v < a["min"]:
        a["min"] = v
    if a["max"] is None or v > a["max"]:
        a["max"] = v


def _agg_avg(a):
    return a["sum"] / a["n"] if a["n"] else None


def _r(v, digits=1):
    return None if v is None else round(v, digits)


def _max(a, b):
    if b is None:
        return a
    return b if a is None else max(a, b)


def _new_minute(key):
    return {"key": key, "n": 0, "hr": _agg(), "spo2": _agg(), "co": _agg(), "aq": _agg(),
            "temp": _agg(), "hum": _agg(), "heat": _agg(), "psi": _agg(), "act": _agg(),
            "rssi": _agg(), "snr": _agg(), "still_max": None, "twa": None, "core": None,
            "pri_worst": None, "falls": 0, "no_motion": 0, "co_sat_n": 0, "batt_chest": None,
            "batt_arm": None, "vbat_chest": None, "vbat_arm": None, "loss": None, "lat": None,
            "lon": None, "worn": 0, "worn_known": 0}


def _new_acc(start_ms, source):
    return {"v": ACC_VERSION, "start_ms": start_ms, "end_ms": start_ms, "n": 0, "minutes": 0,
            "last_minute": None, "source": source,
            "hr": _agg(), "psi": _agg(), "co": _agg(), "spo2": _agg(), "act": _agg(),
            "rssi": _agg(), "snr": _agg(), "loss": _agg(),
            "core_max": None, "heat_max": None, "aq_max": None, "twa_max": None, "dose_ppm_s": 0.0,
            "zones_s": {f"z{i}": 0.0 for i in range(6)},
            "psi_s": {b: 0.0 for b in PSI_BANDS},
            "heat_s": {b: 0.0 for b in HEAT_BANDS},
            "co_s": {"over_35": 0.0, "over_200": 0.0, "sat": 0.0},
            "air_s": {"poor": 0.0, "hazardous": 0.0},
            "spo2_s": {"below_94": 0.0, "below_90": 0.0},
            "act_s": {b: 0.0 for b in ACT_BANDS},
            "events": {"falls": 0, "no_motion": 0, "alerts_p0": 0, "alerts_p1": 0},
            # *_start/*_end: first and last reported %. Drain is measured per discharge segment
            # (a rise >= BATT_JUMP_RESET_PCT = pack swapped or charged → new segment).
            "batt": {f"{side}_{k}": (0.0 if k in ("drop", "drop_ms") else None)
                     for side in ("chest", "arm")
                     for k in ("start", "end", "end_ms", "seg_pct", "seg_ms", "drop", "drop_ms")},
            "sed_hr": [], "prev": None}


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _merge_acc(dst, src):
    """Copy stored values into a fresh accumulator, keeping defaults for anything missing or
    of the wrong type (Firebase drops nulls and empty objects)."""
    for k, dv in dst.items():
        if k not in src:
            continue
        sv = src[k]
        if isinstance(dv, dict):
            if isinstance(sv, dict):
                _merge_acc(dv, sv)
        elif k == "sed_hr":
            if isinstance(sv, list):
                dst[k] = [float(x) for x in sv if _is_num(x)][-SED_HR_MAX:]
        elif k == "prev":
            if isinstance(sv, dict) and _is_num(sv.get("t")):
                dst[k] = {pk: pv for pk, pv in sv.items() if _is_num(pv)}
        elif k == "source":
            if isinstance(sv, str):
                dst[k] = sv
        elif _is_num(sv):
            dst[k] = int(sv) if isinstance(dv, int) and float(sv).is_integer() else sv


def load_session_acc(doc):
    """Session document from Firebase → accumulator, or None if it cannot be resumed."""
    raw = doc.get("_acc") if isinstance(doc, dict) else None
    if not isinstance(raw, dict) or raw.get("v") != ACC_VERSION:
        return None
    if not _is_num(raw.get("start_ms")) or not _is_num(raw.get("end_ms")):
        return None
    acc = _new_acc(int(raw["start_ms"]), raw.get("source") if isinstance(raw.get("source"), str) else "unknown")
    _merge_acc(acc, raw)
    acc["start_ms"], acc["end_ms"] = int(acc["start_ms"]), int(acc["end_ms"])
    return acc


def _minute_add(mb, r, events):
    mb["n"] += 1
    hr, spo2 = r.get("hr"), r.get("spo2")
    if hr is not None and hr > 0:
        _agg_add(mb["hr"], hr)
    if spo2 is not None and spo2 > 0:
        _agg_add(mb["spo2"], spo2)
    for key, field in (("co", "co"), ("aq", "aq"), ("temp", "temp"), ("hum", "hum"),
                       ("heat", "heat_index"), ("psi", "psi"), ("act", "activity_mg"),
                       ("rssi", "rssi"), ("snr", "snr")):
        v = r.get(field)
        if v is not None:
            _agg_add(mb[key], v)
    if r.get("co") is not None and r.get("co_sat") is True:
        mb["co_sat_n"] += 1                    # MQ7 saturated: co is a lower bound in this reading
    mb["still_max"] = _max(mb["still_max"], r.get("still_s"))
    if r.get("twa_co") is not None and r.get("_twa_cov", 0) >= TWA_ALERT_MIN_COVERAGE_S:
        mb["twa"] = r["twa_co"]
    for key, field in (("core", "core_temp_est"), ("batt_chest", "batt_chest"), ("batt_arm", "batt_arm"),
                       ("vbat_chest", "vbat_chest"), ("vbat_arm", "vbat_arm"), ("loss", "link_loss_pct")):
        if r.get(field) is not None:
            mb[key] = r[field]
    pri = r["priority"]
    mb["pri_worst"] = pri if mb["pri_worst"] is None else min(mb["pri_worst"], pri)
    if r.get("gps_ok") and r.get("lat") is not None:
        mb["lat"], mb["lon"] = r["lat"], r["lon"]
    if r.get("skin") is not None:
        mb["worn_known"] += 1
        mb["worn"] += 1 if r["skin"] else 0
    for e in events:
        if e["event"] == "raised" and e["type"] in ("FALL", "NO_MOTION"):
            mb["falls" if e["type"] == "FALL" else "no_motion"] += 1


# Minute accumulator key → minute doc field, for values kept as the latest or the extreme
MINUTE_SCALAR_FIELDS = (("twa", "twa_co"), ("core", "core_est"), ("still_max", "still_max"),
                        ("pri_worst", "pri_worst"), ("batt_chest", "batt_chest"), ("batt_arm", "batt_arm"),
                        ("vbat_chest", "vbat_chest"), ("vbat_arm", "vbat_arm"), ("loss", "loss_pct"),
                        ("lat", "lat"), ("lon", "lon"))
# Minute doc averages → aggregate: (aggregate, avg field, min field, max field, count field or None)
MINUTE_AGG_FIELDS = (
    ("hr", "hr_avg", "hr_min", "hr_max", "hr_n"), ("spo2", "spo2_avg", "spo2_min", None, None),
    ("co", "co_avg", None, "co_max", None), ("aq", "aq_avg", None, "aq_max", None),
    ("temp", "temp_avg", None, None, None), ("hum", "hum_avg", None, None, None),
    ("heat", "heat_avg", None, "heat_max", None), ("psi", "psi_avg", None, "psi_max", None),
    ("act", "act_avg", None, "act_max", None), ("rssi", "rssi_avg", None, None, None),
    ("snr", "snr_avg", None, None, None),
)


def minute_doc(mb, hr_max):
    doc = {"t": mb["key"] * 60000, "n": mb["n"]}
    hr = mb["hr"]
    if hr["n"]:
        avg = _agg_avg(hr)
        doc.update(hr_avg=_r(avg), hr_min=hr["min"], hr_max=hr["max"], hr_n=hr["n"],
                   zone=hr_zone(avg, hr_max))
    if mb["spo2"]["n"]:
        doc.update(spo2_avg=_r(_agg_avg(mb["spo2"])), spo2_min=mb["spo2"]["min"])
    if mb["co"]["n"]:
        doc.update(co_avg=_r(_agg_avg(mb["co"])), co_max=mb["co"]["max"], co_sat_n=mb["co_sat_n"])
    if mb["aq"]["n"]:
        doc.update(aq_avg=_r(_agg_avg(mb["aq"])), aq_max=mb["aq"]["max"])
    if mb["temp"]["n"]:
        doc["temp_avg"] = _r(_agg_avg(mb["temp"]), 2)
    if mb["hum"]["n"]:
        doc["hum_avg"] = _r(_agg_avg(mb["hum"]))
    if mb["heat"]["n"]:
        doc.update(heat_avg=_r(_agg_avg(mb["heat"])), heat_max=mb["heat"]["max"])
    if mb["psi"]["n"]:
        doc.update(psi_avg=_r(_agg_avg(mb["psi"]), 2), psi_max=mb["psi"]["max"])
    if mb["act"]["n"]:
        doc.update(act_avg=_r(_agg_avg(mb["act"])), act_max=mb["act"]["max"])
    if mb["rssi"]["n"]:
        doc["rssi_avg"] = _r(_agg_avg(mb["rssi"]))
    if mb["snr"]["n"]:
        doc["snr_avg"] = _r(_agg_avg(mb["snr"]))
    for key, out in MINUTE_SCALAR_FIELDS:
        if mb[key] is not None:
            doc[out] = mb[key]
    doc["falls"] = mb["falls"]
    doc["no_motion"] = mb["no_motion"]         # NO_MOTION alerts raised in this minute
    if mb["worn_known"]:
        doc["worn_frac"] = round(mb["worn"] / mb["worn_known"], 2)
    return doc


def minute_from_doc(key, doc):
    """A stored minute doc → minute accumulator, so a backend restarted inside that minute adds
    to it instead of overwriting it. Counts, minima, maxima and events come back exactly. The doc
    keeps averages, not sums, and a count only for HR (hr_n), so the other averages are weighted
    by the reading count n: the merged averages are close, not exact."""
    mb = _new_minute(key)
    if not isinstance(doc, dict) or not _is_num(doc.get("n")) or doc["n"] < 1:
        return mb
    n = int(doc["n"])
    mb["n"] = n
    for agg, avg_f, min_f, max_f, n_f in MINUTE_AGG_FIELDS:
        avg = doc.get(avg_f)
        cnt = doc.get(n_f) if n_f else n
        if not _is_num(avg) or not _is_num(cnt) or cnt < 1:
            continue
        a = mb[agg]
        a["n"], a["sum"] = int(cnt), avg * int(cnt)
        for side, f in (("min", min_f), ("max", max_f)):
            if f and _is_num(doc.get(f)):
                a[side] = doc[f]
    for name, f in MINUTE_SCALAR_FIELDS:
        if _is_num(doc.get(f)):
            mb[name] = doc[f]
    for name in ("falls", "no_motion", "co_sat_n"):
        if _is_num(doc.get(name)):
            mb[name] = int(doc[name])
    if _is_num(doc.get("worn_frac")):
        mb["worn_known"], mb["worn"] = n, int(round(doc["worn_frac"] * n))
    return mb


def _attribute(acc, prev, dt):
    """Time-in-band: dt seconds go to the bands of the earlier reading."""
    z = prev.get("zone")
    if z is not None:
        acc["zones_s"][f"z{int(z)}"] += dt
    psi = prev.get("psi")
    if psi is not None:
        acc["psi_s"][psi_band(psi)] += dt
    hb = heat_band(prev.get("heat"))
    if hb:
        acc["heat_s"][hb] += dt
    co = prev.get("co")
    if co is not None:
        acc["dose_ppm_s"] += co * dt
        if co > CO_WARNING_PPM:
            acc["co_s"]["over_35"] += dt
        if co > CO_CRITICAL_PPM:
            acc["co_s"]["over_200"] += dt
        if prev.get("co_sat"):                 # saturated: the dose and the times above are lower bounds
            acc["co_s"]["sat"] += dt
    aq = prev.get("aq")
    if aq is not None:
        if aq > AQI_POOR:
            acc["air_s"]["poor"] += dt
        if aq > AQI_HAZARDOUS:
            acc["air_s"]["hazardous"] += dt
    spo2 = prev.get("spo2")
    if spo2 is not None:
        if spo2 < SPO2_WARNING:
            acc["spo2_s"]["below_94"] += dt
        if spo2 < SPO2_CRITICAL:
            acc["spo2_s"]["below_90"] += dt
    act = prev.get("act")
    if act is not None:
        acc["act_s"][activity_band(act)] += dt


def _session_add(acc, r, now_ms, hr_max, events):
    prev = acc.get("prev")
    if prev:
        dt = max(0, min(now_ms - prev["t"], DT_CAP_MS)) / 1000.0
        if dt > 0:
            _attribute(acc, prev, dt)
    acc["n"] += 1
    acc["end_ms"] = max(acc["end_ms"], now_ms)
    if r["source"] != acc["source"]:
        acc["source"] = "mixed"
    hr, spo2 = r.get("hr"), r.get("spo2")
    hr_ok = hr is not None and hr > 0
    spo2_ok = spo2 is not None and spo2 > 0
    if hr_ok:
        _agg_add(acc["hr"], hr)
    if spo2_ok:
        _agg_add(acc["spo2"], spo2)
    for key, field in (("psi", "psi"), ("co", "co"), ("act", "activity_mg"), ("rssi", "rssi"),
                       ("snr", "snr"), ("loss", "link_loss_pct")):
        v = r.get(field)
        if v is not None:
            _agg_add(acc[key], v)
    acc["core_max"] = _max(acc["core_max"], r.get("core_temp_est"))
    acc["heat_max"] = _max(acc["heat_max"], r.get("heat_index"))
    acc["aq_max"] = _max(acc["aq_max"], r.get("aq"))
    if r.get("twa_co") is not None and r.get("_twa_cov", 0) >= TWA_ALERT_MIN_COVERAGE_S:
        acc["twa_max"] = _max(acc["twa_max"], r["twa_co"])
    b = acc["batt"]
    for side in ("chest", "arm"):
        pct = r.get(f"batt_{side}")
        if pct is None:
            continue
        if b[f"{side}_start"] is None:
            b[f"{side}_start"] = pct
        last, last_ms = b[f"{side}_end"], b[f"{side}_end_ms"]
        if b[f"{side}_seg_pct"] is None:
            b[f"{side}_seg_pct"], b[f"{side}_seg_ms"] = pct, now_ms
        elif last is not None and pct - last >= BATT_JUMP_RESET_PCT:
            b[f"{side}_drop"] += b[f"{side}_seg_pct"] - last          # close the discharge segment
            b[f"{side}_drop_ms"] += last_ms - b[f"{side}_seg_ms"]
            b[f"{side}_seg_pct"], b[f"{side}_seg_ms"] = pct, now_ms
        b[f"{side}_end"], b[f"{side}_end_ms"] = pct, now_ms
    ev = acc["events"]
    for e in events:
        if e["event"] == "raised":
            if e["type"] == "FALL":
                ev["falls"] += 1
            elif e["type"] == "NO_MOTION":
                ev["no_motion"] += 1
            ev["alerts_p0" if e["priority"] == 0 else "alerts_p1"] += 1
        elif e["event"] == "changed" and e["priority"] == 0:
            ev["alerts_p0"] += 1               # escalated to P0
    acc["prev"] = {"t": now_ms,
                   "zone": hr_zone(hr, hr_max) if hr_ok else None,
                   "psi": r.get("psi"), "heat": r.get("heat_index"), "co": r.get("co"),
                   "co_sat": 1 if r.get("co_sat") is True else 0,   # a number: _merge_acc keeps numbers only
                   "aq": r.get("aq"), "spo2": spo2 if spo2_ok else None,
                   "act": r.get("activity_mg")}


def _percentile(values, p):
    xs = sorted(values)
    if not xs:
        return None
    k = (len(xs) - 1) * p / 100.0
    f = int(math.floor(k))
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def session_doc(acc, profile, now_ms):
    hr = acc["hr"]
    rest_est = _r(_percentile(acc["sed_hr"], 5)) if len(acc["sed_hr"]) >= 5 else None
    hr_rest = profile.get("hr_rest")
    if hr_rest is None:
        hr_rest = rest_est if rest_est is not None else HR_REST_FALLBACK
    zones = acc["zones_s"]
    trimp = sum(i * zones[f"z{i}"] / 60.0 for i in range(1, 6))
    b = acc["batt"]

    def drain(side):
        """%/h over the discharge segments; None with less than 5 min of battery data."""
        seg, seg_ms, e, e_ms = (b[f"{side}_seg_pct"], b[f"{side}_seg_ms"], b[f"{side}_end"], b[f"{side}_end_ms"])
        if None in (seg, seg_ms, e, e_ms):
            return None
        drop = b[f"{side}_drop"] + (seg - e)
        span_ms = b[f"{side}_drop_ms"] + (e_ms - seg_ms)
        if span_ms < 5 * 60 * 1000:
            return None
        return round(drop / (span_ms / 3_600_000.0), 1)

    psi, co, spo2, act = acc["psi"], acc["co"], acc["spo2"], acc["act"]
    return {
        "start_ms": acc["start_ms"], "end_ms": acc["end_ms"],
        "duration_s": round((acc["end_ms"] - acc["start_ms"]) / 1000.0, 1),
        "minutes": acc["minutes"], "readings": acc["n"],
        "profile": {"age": profile["age"], "hr_max": profile["hr_max"], "hr_rest": hr_rest},
        "source": acc["source"],
        "hr": {"avg": _r(_agg_avg(hr)), "max": hr["max"], "min": hr["min"], "rest_est": rest_est},
        "zones_s": {k: round(v, 1) for k, v in zones.items()},
        "trimp": round(trimp, 1),
        "psi": {"avg": _r(_agg_avg(psi), 2), "max": psi["max"],
                **{f"s_{k}": round(v, 1) for k, v in acc["psi_s"].items()}},
        "core_max": acc["core_max"],
        "heat": {"max": acc["heat_max"], **{f"s_{k}": round(v, 1) for k, v in acc["heat_s"].items()}},
        "co": {"max": co["max"], "avg": _r(_agg_avg(co)), "dose_ppm_min": round(acc["dose_ppm_s"] / 60.0, 1),
               "s_over_35": round(acc["co_s"]["over_35"], 1), "s_over_200": round(acc["co_s"]["over_200"], 1),
               "s_sat": round(acc["co_s"]["sat"], 1), "twa_max": acc["twa_max"]},
        "air": {"max": acc["aq_max"], "s_poor": round(acc["air_s"]["poor"], 1),
                "s_hazardous": round(acc["air_s"]["hazardous"], 1)},
        "spo2": {"min": spo2["min"], "avg": _r(_agg_avg(spo2)),
                 "s_below_94": round(acc["spo2_s"]["below_94"], 1),
                 "s_below_90": round(acc["spo2_s"]["below_90"], 1)},
        "activity": {"avg_mg": _r(_agg_avg(act)), **{f"s_{k}": round(v, 1) for k, v in acc["act_s"].items()}},
        "events": dict(acc["events"]),
        "battery": {"chest_start": b["chest_start"], "chest_end": b["chest_end"],
                    "arm_start": b["arm_start"], "arm_end": b["arm_end"],
                    "chest_drain_pct_h": drain("chest"), "arm_drain_pct_h": drain("arm")},
        "link": {"rssi_avg": _r(_agg_avg(acc["rssi"])), "snr_avg": _r(_agg_avg(acc["snr"])),
                 "loss_avg": _r(_agg_avg(acc["loss"]))},
        "updated_ms": now_ms,
        "_acc": acc,
    }


def _flush_minute(st, now_ms, final=False):
    mb = st.minute
    if mb is None:
        return
    ok = _fb_set(analytics_ref.child(st.id).child("minutes").child(str(mb["key"])),
                 minute_doc(mb, st.profile["hr_max"]), f"analytics/{st.id}/minutes")
    st.minute_flushed_ms = now_ms
    st.minute_dirty = not ok
    if final:
        if st.session is not None:             # sedentary minutes feed the resting-HR estimate
            act, hr = _agg_avg(mb["act"]), _agg_avg(mb["hr"])
            if act is not None and act < ACT_LIGHT_MG and hr is not None:
                st.session["sed_hr"].append(round(hr, 1))
                del st.session["sed_hr"][:-SED_HR_MAX]
                st.session_dirty = True
        st.minute = None


def _flush_session(st, now_ms):
    if st.session is None:
        return
    ok = _fb_set(analytics_ref.child(st.id).child("sessions").child(str(st.session["start_ms"])),
                 session_doc(st.session, st.profile, now_ms), f"analytics/{st.id}/sessions")
    st.session_flushed_ms = now_ms
    st.session_dirty = not ok


def _close_session(st, now_ms):
    if st.minute is not None:
        _flush_minute(st, now_ms, final=True)
    if st.session is not None:
        _flush_session(st, now_ms)
        st.session = None


def _maybe_flush(st, now_ms):
    if st.minute is not None and st.minute_dirty and now_ms - st.minute_flushed_ms >= MINUTE_FLUSH_MS:
        _flush_minute(st, now_ms)
    if st.session is not None and st.session_dirty and now_ms - st.session_flushed_ms >= SESSION_FLUSH_MS:
        _flush_session(st, now_ms)


def _try_resume(rid, now_ms):
    """Latest stored session for rid, if it ended less than 10 min ago."""
    try:
        snap = analytics_ref.child(rid).child("sessions").order_by_key().limit_to_last(1).get()
    except Exception as e:
        print(f"[FIREBASE] reading the last session of {rid} failed: {e!r}")
        return None
    if not isinstance(snap, dict) or not snap:
        return None
    key, doc = list(snap.items())[-1]
    acc = load_session_acc(doc)
    if acc is None or str(acc["start_ms"]) != str(key):
        return None
    if abs(now_ms - acc["end_ms"]) >= SESSION_GAP_MS:
        return None
    print(f"[ANALYTICS] {rid}: resuming session {key} ({acc['n']} readings, "
          f"last data {int((now_ms - acc['end_ms']) / 1000)} s ago)")
    return acc


def _stored_minute(rid, key):
    """analytics/<rid>/minutes/<key> as stored, or None (missing or the read failed)."""
    try:
        doc = analytics_ref.child(rid).child("minutes").child(str(key)).get()
    except Exception as e:
        print(f"[FIREBASE] reading analytics/{rid}/minutes/{key} failed: {e!r}")
        return None
    return doc if isinstance(doc, dict) else None


def _analytics_add(st, r, now_ms, events):
    if st.session is not None and now_ms - st.session["end_ms"] >= SESSION_GAP_MS:
        _close_session(st, now_ms)
    resumed = False
    if st.session is None:
        acc = None
        if not st.resume_checked:
            st.resume_checked = True
            acc = _try_resume(st.id, now_ms)
        resumed = acc is not None
        st.session = acc or _new_acc(now_ms, r["source"])
        st.session_flushed_ms = 0              # write a new or resumed session right away
    key = now_ms // 60000
    if st.minute is not None and key > st.minute["key"]:
        _flush_minute(st, now_ms, final=True)
    if st.minute is None:
        # Resumed inside a minute that was already flushed before the restart: add to that doc.
        stored = _stored_minute(st.id, key) if resumed else None
        st.minute = minute_from_doc(key, stored) if stored else _new_minute(key)
        if st.session["last_minute"] != key:
            st.session["minutes"] += 1
            st.session["last_minute"] = key
    _minute_add(st.minute, r, events)
    _session_add(st.session, r, now_ms, st.profile["hr_max"], events)
    st.minute_dirty = st.session_dirty = True
    _maybe_flush(st, now_ms)


# ─── PROCESS + WRITE TO FIREBASE ───────────────────────────────────────────
# live/<id> field list (SPEC §8.8, plus mq_warmup_s from §12.5). Every update writes all of them;
# unknown ones are None, which deletes them in Firebase, so the dashboard never shows stale values.
LIVE_FIELDS = (
    "id", "ts", "ts_ms", "source", "fmt", "priority", "device_pri", "seq", "active_alerts",
    "link_lost", "hr", "spo2", "ppg_q", "skin", "ppg_motion", "arm_ok", "arm_loss_pct", "sensors",
    "co", "co_raw_mv", "co_sat", "twa_co", "twa_partial", "aq", "aq_raw_mv", "mq_warmup_s", "temp", "hum",
    "heat_index", "pressure", "bme_alt", "accel", "activity_mg", "still_s", "fall",
    "core_temp_est", "psi", "lat", "lon", "alt", "gps_ok", "gps_fresh", "gps_age_s", "gps_sats",
    "gps_hdop", "gps_acc_m", "batt_chest", "vbat_chest", "batt_chest_eta_min", "batt_chest_trend",
    "batt_arm", "vbat_arm", "batt_arm_eta_min", "batt_arm_trend", "rssi", "snr", "link_loss_pct",
    "lora_reinits", "chest_uptime_min", "bench_mode",
)
LIVE_ONLY_FIELDS = ("active_alerts", "sensors", "link_lost")
STALE_LIVE_KEYS  = ("batt",)    # written by the pre-Session-4 backend; deleted on every update


def process_and_store(data, source="hardware", now=None):
    """Process one reading (canonical fields, e.g. from parse_lora_csv or validate_json) and
    write live/readings/alerts/hazards/analytics. source: "hardware" or "simulator".
    Returns {"id", "priority", "active_alerts"}. Raises InputError for invalid input."""
    if source not in ("hardware", "simulator"):
        raise ValueError(f"unknown source {source!r}")
    fields, _ = _canonicalize(data, ALL_FIELDS)
    fields = _finalize(fields)
    with STATE_LOCK:
        now = time.time() if now is None else now   # read inside the lock: readings stay in time order
        ts, ts_ms = make_timestamps(now)
        return _process_locked(fields, source, now, ts, ts_ms)


def _gps_derived(r):
    lat, lon = r.get("lat"), r.get("lon")
    plausible = (lat is not None and lon is not None and abs(lat) <= 90 and abs(lon) <= 180
                 and not (lat == 0 and lon == 0))
    if "gps_fresh" in r:
        gps_ok = r["gps_fresh"] is True and plausible
    else:                                      # legacy: a non-zero position means a fix
        gps_ok = plausible
    hdop = r.get("gps_hdop")
    if hdop is not None:
        acc = round(min(max(hdop * 5.0, 5.0), 100.0), 1)
    else:
        acc = 15 if gps_ok else None
    return plausible, gps_ok, acc


def _battery_update(st, side, r, now):
    v, pct = r.get(f"vbat_{side}"), r.get(f"batt_{side}")
    level = soc_from_voltage(v) if v is not None else (float(pct) if pct is not None else None)
    hist = st.batt_hist[side]
    if level is None:
        return None, None                      # not measured now (history kept for later)
    if hist and level - hist[-1][1] >= BATT_JUMP_RESET_PCT:
        hist.clear()                           # battery swapped or charger attached
    if not hist or now - hist[-1][0] >= BATT_SAMPLE_S:
        hist.append((now, level))
        while hist and hist[0][0] < now - BATT_WINDOW_S:
            hist.popleft()
        st.batt_eta[side] = battery_trend(hist)
    return st.batt_eta[side]


def _process_locked(r, source, now, ts, ts_ms):
    rid = r["id"]
    st = _responder(rid, ts_ms)
    if (st.last_source is not None and st.last_source[0] != source and now - st.last_source[1] < 60
            and now - st.mixed_warned_at >= 60):
        st.mixed_warned_at = now
        print(f"[WARN] {rid} is getting readings from both the gateway and the simulator; their values "
              f"mix in live/{rid}, the TWA and the core estimate. Stop one, or run the simulator with "
              f"another --id.")
    st.last_source = (source, now)
    st.last_packet = now
    arm_ok = r.get("arm_ok")

    fall = r.get("fall")
    if fall is True:
        st.fall_active = True
    elif fall is False and arm_ok is not False:  # a silent arm cannot clear a fall
        st.fall_active = False

    # While the MQ sensors warm up, CO/AQ are stored in readings/ (with mq_warmup_s) but are not
    # measurements: they stay out of the TWA, the alerts, the hazards and the analytics.
    warming = mq_warming(r)
    st.twa, st.twa_cov = twa_update(st.co_hist, now, None if warming else r.get("co"))
    twa_partial = None if st.twa is None else st.twa_cov < TWA_WINDOW - 0.5

    temp, hum = r.get("temp"), r.get("hum")
    heat_index = compute_heat_index(temp, hum) if temp is not None else None
    hr = r.get("hr")
    hr_feed = hr if (hr is not None and hr > 0 and arm_ok is not False) else None
    core = st.core.update(hr_feed, now)
    psi = compute_psi(hr, core)

    plausible, gps_ok, acc = _gps_derived(r)
    if plausible:
        st.pos = (r["lat"], r["lon"], acc)
    chest_eta, chest_trend = _battery_update(st, "chest", r, now)
    arm_eta, arm_trend = _battery_update(st, "arm", r, now)
    loss = None
    if source == "hardware" and r.get("seq") is not None:
        loss = st.loss.add(r["seq"], r.get("chest_uptime_min"))

    sensors = {}
    asens = r.get("arm_sensors")
    if asens is not None:
        sensors.update(imu=bool(asens & 1), bme=bool(asens & 2), ppg=bool(asens & 4),
                       arm_batt=bool(asens & 8))
    sensors["chest_batt"] = r.get("batt_chest") is not None
    if r.get("gps_uart") is not None:
        sensors["gps_uart"] = r["gps_uart"]

    rec = {f: None for f in LIVE_FIELDS}
    for f in LIVE_FIELDS:
        if f in r:
            rec[f] = r[f]
    rec.update({
        "id": rid, "ts": ts, "ts_ms": ts_ms, "source": source, "link_lost": False,
        "bench_mode": True if BENCH_MODE else None,
        "twa_co": st.twa, "twa_partial": twa_partial, "heat_index": heat_index,
        "fall": st.fall_active, "core_temp_est": core, "psi": psi,
        "gps_ok": gps_ok, "gps_acc_m": acc,
        "batt_chest_eta_min": chest_eta, "batt_chest_trend": chest_trend,
        "batt_arm_eta_min": arm_eta, "batt_arm_trend": arm_trend,
        "link_loss_pct": loss, "sensors": sensors,
        "mq_warmup_s": r["mq_warmup_s"] if warming else None,   # 0 or absent: deleted from live
    })
    if not plausible:
        rec["lat"] = rec["lon"] = rec["alt"] = None

    # Alerts: the next packet always clears LINK, then every other type is re-evaluated.
    events = []
    clear_alert_now(st, "LINK", ts, ts_ms, events)
    st.link_lost = False
    st.link_reason_text = None
    conds = evaluate_alerts(rec, st)
    before = {typ: a.severity for typ, a in st.alerts.items()}
    for typ in PACKET_ALERT_TYPES:
        if warming and typ in MQ_ALERT_TYPES:
            clear_alert_now(st, typ, ts, ts_ms, events, MQ_WARMUP_REASON)
        elif typ in ARM_ALERT_INPUTS and not arm_input_known(rec, typ):
            hold_alert(st, typ, ts_ms, ts, ts_ms, events)
        else:
            step_alert(st, typ, conds.get(typ), ts_ms, ts, ts_ms, events)
    escalated = {typ for typ, a in st.alerts.items() if typ in before and a.severity < before[typ]}
    st.priority = responder_priority(st)
    rec["priority"] = st.priority
    rec["active_alerts"] = active_alerts_map(st)

    measured = dict(rec, co=None, aq=None, co_sat=None) if warming else rec
    update_hazards(st, measured, ts_ms, escalated, gps_ok)

    analytics_rec = dict(measured, _twa_cov=st.twa_cov, source=source)
    _analytics_add(st, analytics_rec, ts_ms, events)

    live = dict(rec)
    for k in STALE_LIVE_KEYS:
        live[k] = None
    _fb_update(live_ref.child(rid), live, f"live/{rid}")
    reading = {k: v for k, v in rec.items() if k not in LIVE_ONLY_FIELDS}
    for k in ("gps_uart", "arm_sensors"):      # reading fields that live/ carries inside "sensors"
        if r.get(k) is not None:
            reading[k] = r[k]
    if fall is not None:
        reading["fall_raw"] = fall             # what the device sent; "fall" is the held value
    _fb_push(readings_ref.child(rid), reading, f"readings/{rid}")
    _push_alerts(events)

    print(console_line(rec, st))
    return {"id": rid, "priority": st.priority, "active_alerts": sorted(st.alerts)}


def console_line(r, st):
    """One status line per reading (SPEC §8.9)."""
    def num(v, fmt="{:.1f}"):
        return "--" if v is None else fmt.format(v)

    def ppg(v):
        if v is None or v == 0:
            return "--"
        return "CAL" if v < 0 else f"{v:.0f}"

    src = "hw" if r["source"] == "hardware" else "sim"
    parts = [f"[P{r['priority']}] {r['id']} {src}"]
    if r.get("arm_ok") is False:
        parts.append("HR -- SpO2 -- (arm offline)")
    else:
        q = f" q{r['ppg_q']}" if r.get("ppg_q") is not None else ""
        parts.append(f"HR {ppg(r.get('hr'))} SpO2 {ppg(r.get('spo2'))}{q}")
    sat = " SAT" if r.get("co_sat") else ""
    co, aq, twa = num(r.get("co")), num(r.get("aq"), "{:.0f}"), num(r.get("twa_co"))
    if mq_warming(r):
        m, s = divmod(r["mq_warmup_s"], 60)
        parts.append(f"CO/AQI warming up {m}:{s:02d} (raw CO {co}{sat}, AQI {aq}) TWA {twa}")
    else:
        parts.append(f"CO {co}{sat} TWA {twa} AQI {aq}")
    parts.append(f"AMB {num(r.get('temp'))} HI {num(r.get('heat_index'))} "
                 f"CORE~{num(r.get('core_temp_est'))} PSI {num(r.get('psi'))}")
    parts.append(f"act {num(r.get('activity_mg'), '{:.0f}')}mg still {num(r.get('still_s'), '{:.0f}')}s"
                 + (" FALL" if r.get("fall") else ""))

    def batt(side):
        pct, v = r.get(f"batt_{side}"), r.get(f"vbat_{side}")
        if pct is None:
            return f"{side} --"
        text = f"{side} {pct}%" + (f" {v:.2f}V" if v is not None else "")
        eta, trend = r.get(f"batt_{side}_eta_min"), r.get(f"batt_{side}_trend")
        if eta is not None:
            text += f" ~{_fmt_minutes(eta).replace(' ', '')}"
        elif trend == "charging":
            text += " chg"
        return text

    parts.append(f"BAT {batt('chest')}, {batt('arm')}")
    arm_ok = r.get("arm_ok")
    if arm_ok is not None:
        loss = f" {r['arm_loss_pct']}%" if r.get("arm_loss_pct") is not None else ""
        parts.append(f"ARM {'ok' if arm_ok else 'OFFLINE'}{loss}")
    if r.get("gps_ok"):
        gps = "GPS fresh"
    elif r.get("lat") is not None:
        gps = "GPS stale" + (f" {r['gps_age_s']}s" if r.get("gps_age_s") is not None else "")
    else:
        gps = "GPS no fix"
    if r.get("gps_sats") is not None:
        gps += f" {r['gps_sats']}sat"
    if r.get("gps_hdop") is not None:
        gps += f" hdop{r['gps_hdop']:.1f}"
    parts.append(gps)
    if r.get("rssi") is not None:
        loss = f" loss {r['link_loss_pct']}%" if r.get("link_loss_pct") is not None else ""
        parts.append(f"LoRa {r['rssi']:.0f}dBm {num(r.get('snr'))}dB{loss}")
    if st.alerts:
        labels = [a.reason.split(":")[0] for _, a in sorted(st.alerts.items(), key=lambda kv: (kv[1].severity, kv[0]))]
        parts.append(", ".join(labels))
    return " | ".join(parts)


# ─── LINK WATCHDOG + PERIODIC FLUSHES ──────────────────────────────────────
def watchdog_tick(now=None):
    """Raise LINK for silent responders, flush analytics, retry failed alert pushes.
    Runs every WATCHDOG_SEC in its own thread; safe to call directly (tests)."""
    with STATE_LOCK:
        now = time.time() if now is None else now
        ts, ts_ms = make_timestamps(now)
        _retry_pending_alerts()
        for st in list(RESPONDERS.values()):
            try:
                _watch_responder(st, now, ts, ts_ms)
            except Exception as e:
                print(f"[WATCHDOG] {st.id}: {e!r}")
                traceback.print_exc()


def _watch_responder(st, now, ts, ts_ms):
    if st.last_packet is not None:
        silent = now - st.last_packet
        if silent >= LINK_LOST_SEC:
            severity = 0 if (st.priority == 0 or st.fall_active) else 1
            reason = f"LINK LOST: no data for {_fmt_age(silent)}"
            events = []
            a = st.alerts.get("LINK")
            if a is None:
                a = AlertState(severity, reason, ts_ms)
                st.alerts["LINK"] = a
                events.append(_alert_record(st.id, "LINK", severity, reason, "raised", ts, ts_ms))
            else:
                a.reason = reason
                if severity < a.severity:
                    a.severity = severity
                    events.append(_alert_record(st.id, "LINK", severity, reason, "changed", ts, ts_ms))
                    a.last_logged_ms = ts_ms
                elif (ts_ms - a.last_logged_ms >= ALERT_REPEAT_SEC * 1000
                      and silent < LINK_ONGOING_MAX_SEC):
                    events.append(_alert_record(st.id, "LINK", a.severity, reason, "ongoing", ts, ts_ms))
                    a.last_logged_ms = ts_ms
            if events or not st.link_lost or reason != st.link_reason_text:
                st.link_lost = True
                st.link_reason_text = reason
                _fb_update(live_ref.child(st.id),
                           {"link_lost": True, "active_alerts": active_alerts_map(st)}, f"live/{st.id}")
            if events and st.session is not None:
                _session_add_events(st.session, events)
            _push_alerts(events)
    if st.minute is not None and ts_ms // 60000 > st.minute["key"]:
        _flush_minute(st, ts_ms, final=True)
    _maybe_flush(st, ts_ms)
    if st.session is not None and ts_ms - st.session["end_ms"] >= SESSION_GAP_MS:
        _close_session(st, ts_ms)


def _session_add_events(acc, events):
    for e in events:
        if e["event"] == "raised":
            acc["events"]["alerts_p0" if e["priority"] == 0 else "alerts_p1"] += 1
        elif e["event"] == "changed" and e["priority"] == 0:
            acc["events"]["alerts_p0"] += 1


def flush_all(now=None):
    """Write the current minute and session of every responder (shutdown)."""
    now_ms = make_timestamps(now)[1]
    with STATE_LOCK:
        _retry_pending_alerts()
        for st in RESPONDERS.values():
            if st.minute is not None:
                _flush_minute(st, now_ms)
            if st.session is not None:
                _flush_session(st, now_ms)


# ─── STARTUP WRITES ────────────────────────────────────────────────────────
_UID_RE = re.compile(r"^[A-Za-z0-9_\-:@+=]{1,128}$")   # Firebase key-safe Auth UID


def write_operators():
    raw = os.environ.get("HALO_OPERATOR_UIDS", "")
    uids = [u.strip() for u in raw.split(",") if u.strip()]
    written = 0
    for uid in uids:
        if not _UID_RE.match(uid):
            print(f"[OPERATORS] Skipping {uid!r}: not a valid Firebase Auth UID")
            continue
        if _fb_set(operators_ref.child(uid), True, f"operators/{uid}"):
            written += 1
    if uids:
        print(f"[OPERATORS] {written} operator UID(s) written to operators/")
    return written


def startup_tasks(now=None):
    now_ms = make_timestamps(now)[1]
    with STATE_LOCK:
        for rid in PROFILES:
            _write_profile(rid, now_ms)
        write_operators()
        close_stale_hazards()


# ─── SERIAL READER THREAD ──────────────────────────────────────────────────
SERIAL_RETRY_SEC = 5
SERIAL_ERROR_BACKOFF_SEC = 2
MAX_LINE_BYTES = 1024
# Auto-detect only: a port that sends no gateway line ("ID:", "#" or "{") this long after it is
# opened is another ESP32 on USB (a chest or arm strap), and the next matching port is tried.
# The gateway prints "# alive" every 30 s. A port that is the only match is never given up.
GATEWAY_PROBE_SEC = 40
GATEWAY_LINE_PREFIXES = (b"ID:", b"#", b"{")
STOP = threading.Event()
_REJECTED_PORTS = set()   # auto-detect: ports that sent no gateway line; retried once all are rejected


class NotGatewayError(Exception):
    """read_lines(probe_s=...) saw no gateway line in time."""


def _candidate_ports():
    return [p.device for p in list_ports.comports() if p.vid in USB_SERIAL_VIDS]


def find_gateway_port():
    """HALO_COM_PORT if set, otherwise the first ESP32-style USB-serial port that has not been
    rejected for sending no gateway line (all rejected: start again from the first)."""
    if COM_PORT:
        return COM_PORT
    ports = _candidate_ports()
    _REJECTED_PORTS.intersection_update(ports)          # forget unplugged ports
    fresh = [p for p in ports if p not in _REJECTED_PORTS]
    if not fresh:
        _REJECTED_PORTS.clear()
        fresh = ports
    return fresh[0] if fresh else None


def open_gateway(port):
    ser = serial.Serial()
    ser.port     = port
    ser.baudrate = BAUD_RATE
    ser.timeout  = 2
    ser.dtr      = False        # don't hold the ESP32 in reset / trigger auto-reset on open
    ser.rts      = False
    ser.open()
    try:
        time.sleep(2)           # if the board did reset, let it finish booting
        ser.reset_input_buffer()    # drop boot messages and any partial line
    except Exception:
        ser.close()
        raise
    return ser


class SerialStatus:
    """Prints each serial state message once per change of state."""

    def __init__(self):
        self.state = None

    def report(self, state, message):
        if state != self.state:
            self.state = state
            print(message)


class _RateLimited:
    def __init__(self, every_s):
        self.every_s, self.last, self.suppressed = every_s, 0.0, 0

    def __call__(self, message):
        now = time.monotonic()
        if now - self.last >= self.every_s:
            extra = f" (+{self.suppressed} more)" if self.suppressed else ""
            print(message + extra)
            self.last, self.suppressed = now, 0
        else:
            self.suppressed += 1


_log_ignored = _RateLimited(10.0)


def handle_line(raw, source="hardware"):
    """One line from the gateway (bytes or str). '#' lines are gateway diagnostics."""
    if isinstance(raw, bytes):
        try:
            line = raw.decode("ascii")
        except UnicodeDecodeError:
            _log_ignored(f"[SERIAL] Ignored non-ASCII line ({len(raw)} bytes)")
            return None
    else:
        line = raw
    line = line.strip()
    if not line:
        return None
    if line.startswith("#"):
        print(f"[GATEWAY] {line}")
        return None
    try:
        if line.startswith("{"):
            data, _ = validate_json(json.loads(line))
        elif line.startswith("ID:"):
            data = _parse_csv(line)
        else:
            _log_ignored(f"[SERIAL] Ignored line: {line[:80]!r}")
            return None
    except (InputError, ValueError, RecursionError) as e:
        fields = f" {e.fields}" if isinstance(e, InputError) and e.fields else ""
        _log_ignored(f"[SERIAL] Rejected line ({e}{fields}): {line[:80]!r}")
        return None
    return process_and_store(data, source)


def read_lines(ser, probe_s=None):
    """Read lines until the port fails or STOP is set. A line cut by the read timeout is
    kept and completed by the next read. probe_s: raise NotGatewayError when no gateway line
    has arrived within probe_s seconds (auto-detect)."""
    buf = b""
    start = time.monotonic()
    while not STOP.is_set():
        if probe_s is not None and not buf and time.monotonic() - start >= probe_s:
            raise NotGatewayError
        chunk = ser.readline()
        if not chunk:
            continue
        buf += chunk
        if not buf.endswith(b"\n"):
            if len(buf) > MAX_LINE_BYTES:
                buf = b""                      # no newline in 1 KB: not a gateway line
            continue
        line, buf = buf, b""
        if line.lstrip().startswith(GATEWAY_LINE_PREFIXES):
            probe_s = None                     # it is the gateway
        try:
            handle_line(line)
        except Exception as e:                 # Firebase/processing error: keep reading
            print(f"[SERIAL] Error processing line: {e!r}")


def _read_probed(ser, port, status):
    """Auto-detect: read the port, but give it up for the next matching port if it sends no
    gateway line within GATEWAY_PROBE_SEC. The only matching port is kept (checked again every
    GATEWAY_PROBE_SEC). Returns when STOP is set or the port was given up; raises on port errors."""
    while True:
        try:
            read_lines(ser, GATEWAY_PROBE_SEC)
            return
        except NotGatewayError:
            if any(p != port for p in _candidate_ports()):
                _REJECTED_PORTS.add(port)
                status.state = ("rejected", port)
                print(f"[SERIAL] {port} sent no gateway line in {GATEWAY_PROBE_SEC} s (a chest or arm strap "
                      f"on USB?); trying the next USB-serial port. Set HALO_COM_PORT to choose one.")
                return


def serial_once(status, find_port=None, opener=None):
    """One connect-and-read cycle. Returns the delay before the next attempt. With the default
    find_port and no HALO_COM_PORT, a port that sends no gateway line is given up (_read_probed)."""
    auto = find_port is None and not COM_PORT
    find_port = find_port or find_gateway_port
    opener = opener or open_gateway
    port = find_port()
    if not port:
        status.report(("not_found",),
                      "[SERIAL] No gateway found (no CP210x/CH340/FTDI USB-serial port). Waiting for it "
                      "to be plugged in; POST /ingest still works.")
        return SERIAL_RETRY_SEC
    try:
        ser = opener(port)
    except Exception as e:
        status.report(("cant_open", port),
                      f"[SERIAL] Found {port} but can't open it: {e}\n"
                      f"         Close the Arduino IDE Serial Monitor (or anything else using the port). "
                      f"Retrying every {SERIAL_RETRY_SEC} s...")
        return SERIAL_RETRY_SEC
    status.report(("connected", port), f"[SERIAL] Connected to gateway on {port}")
    try:
        if auto:
            _read_probed(ser, port, status)
        else:
            read_lines(ser)
    except Exception as e:
        status.state = ("disconnected", port)
        print(f"[SERIAL] {port} disconnected ({e!r}); reconnecting...")
    finally:
        try:
            ser.close()
        except Exception:
            pass
    return SERIAL_ERROR_BACKOFF_SEC


def serial_reader(status=None):
    """Serial thread: never exits until STOP; every exception is logged and retried."""
    status = status or SerialStatus()
    while not STOP.is_set():
        try:
            delay = serial_once(status)
        except Exception as e:
            status.report(("error", repr(e)), f"[SERIAL] Unexpected error: {e!r}; retrying in "
                                              f"{SERIAL_ERROR_BACKOFF_SEC} s")
            delay = SERIAL_ERROR_BACKOFF_SEC
        STOP.wait(delay)


def watchdog_loop():
    while not STOP.wait(WATCHDOG_SEC):
        try:
            watchdog_tick()
        except Exception as e:
            print(f"[WATCHDOG] {e!r}")


_threads_started = False


def start_background_threads():
    global _threads_started
    if _threads_started:
        return
    _threads_started = True
    STOP.clear()
    threading.Thread(target=serial_reader, name="halo-serial", daemon=True).start()
    threading.Thread(target=watchdog_loop, name="halo-watchdog", daemon=True).start()


@asynccontextmanager
async def lifespan(_app):
    try:
        await run_in_threadpool(startup_tasks)
    except Exception as e:
        print(f"[STARTUP] {e!r}")
    start_background_threads()
    try:
        yield
    finally:
        STOP.set()
        await run_in_threadpool(flush_all)


# ─── APP + REST ENDPOINTS ──────────────────────────────────────────────────
app = FastAPI(
    title="HALO Backend", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan,
    middleware=[
        # Listed outermost first: the Host check runs before CORS and the routes.
        Middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS),
        Middleware(CORSMiddleware, allow_origins=list(DASHBOARD_ORIGINS), allow_methods=["GET"],
                   allow_headers=[], allow_credentials=False),
    ],
)


class _Reject(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


async def _read_body_capped(request):
    length = request.headers.get("content-length")
    if length is not None:
        if not length.strip().isdigit():
            raise _Reject(400, "bad Content-Length")
        if int(length) > MAX_BODY_BYTES:
            raise _Reject(413, f"body larger than {MAX_BODY_BYTES} bytes")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BODY_BYTES:
            raise _Reject(413, f"body larger than {MAX_BODY_BYTES} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


@app.post("/ingest")
async def ingest(request: Request):
    """One reading: a JSON object (Content-Type: application/json, the simulator) or one
    gateway line (Content-Type: text/csv). See the module docstring for the security checks."""
    try:
        origin = request.headers.get("origin")
        if origin is not None and origin not in DASHBOARD_ORIGINS:
            raise _Reject(403, "cross-origin requests are not accepted")
        media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media not in ("application/json", "text/csv"):
            raise _Reject(415, "Content-Type must be application/json (one JSON object) "
                               "or text/csv (one gateway line)")
        body = await _read_body_capped(request)
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            raise _Reject(400, "body is not valid UTF-8")
        if media == "application/json":
            try:
                obj = json.loads(text)
            except (ValueError, RecursionError):
                raise _Reject(400, "body is not valid JSON")
            data, ignored = validate_json(obj)
            source = "simulator"
        else:
            data, ignored = _parse_csv(text), []
            source = "hardware"
    except _Reject as e:
        return JSONResponse({"ok": False, "error": e.message}, status_code=e.status)
    except InputError as e:
        return JSONResponse({"ok": False, "error": str(e), "bad_fields": e.fields}, status_code=400)
    try:
        result = await run_in_threadpool(process_and_store, data, source)
    except Exception as e:
        print(f"[INGEST] processing failed: {e!r}")
        traceback.print_exc()
        return JSONResponse({"ok": False, "error": "processing failed"}, status_code=500)
    return {"ok": True, **result, "ignored": ignored}


@app.get("/summary")
def get_summary():
    """Latest values per responder from Firebase live/ (vitals, priority, batteries, alerts)."""
    try:
        snap = live_ref.get()
    except Exception as e:
        print(f"[SUMMARY] Firebase read failed: {e!r}")
        return JSONResponse({"error": "Firebase read failed"}, status_code=502)
    if not isinstance(snap, dict):
        return {}
    out = {}
    for rid, r in snap.items():
        if not isinstance(r, dict):
            continue
        active = r.get("active_alerts")
        out[rid] = {
            "latest_hr":   r.get("hr"),
            "latest_spo2": r.get("spo2"),
            "latest_co":   r.get("co"),
            "mq_warmup_s": r.get("mq_warmup_s"),   # set while CO/AQ are not valid yet
            "latest_psi":  r.get("psi"),
            "priority":    r.get("priority"),
            "fall":        r.get("fall"),
            "batt":        r.get("batt_chest"),
            "batt_chest":  r.get("batt_chest"),
            "vbat_chest":  r.get("vbat_chest"),
            "batt_chest_eta_min": r.get("batt_chest_eta_min"),
            "batt_arm":    r.get("batt_arm"),
            "vbat_arm":    r.get("vbat_arm"),
            "batt_arm_eta_min": r.get("batt_arm_eta_min"),
            "active_alerts": sorted(active) if isinstance(active, dict) else [],
            "link_lost":   r.get("link_lost"),
            "ts":          r.get("ts"),
        }
    return out


@app.get("/health")
def health():
    return {"status": "ok", "ts": make_timestamps()[0]}


# ─── ENTRY POINT ───────────────────────────────────────────────────────────
def is_loopback(host):
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def log_bind():
    print(f"[HTTP] Listening on http://{HOST}:{PORT} (POST /ingest, GET /summary, GET /health)")
    if is_loopback(HOST):
        print(f"[HTTP] Loopback only. From another machine use an SSH tunnel: "
              f"ssh -N -L {PORT}:127.0.0.1:{PORT} <user>@<this-host>")
    else:
        print(f"[HTTP] WARNING: HALO_HOST={HOST} is not loopback. POST /ingest has no authentication, so "
              f"anyone who can reach this port can write to Firebase with the service account. "
              f"Unset HALO_HOST and use an SSH tunnel instead.")


if __name__ == "__main__":
    import uvicorn
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")   # Windows consoles without UTF-8
    print("HALO Backend - Firebase edition (Session 4)")
    if BENCH_MODE:
        print("[BENCH] HALO_BENCH=1: no-motion (man-down) alerts are OFF. Unset it for a worn strap.")
    print(f"Database: {DATABASE_URL}")
    print(f"Serial port: {COM_PORT or 'auto-detect'}")
    log_bind()
    uvicorn.run(app, host=HOST, port=PORT)
