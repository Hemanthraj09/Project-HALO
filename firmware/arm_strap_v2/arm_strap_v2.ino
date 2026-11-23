/*
  =============================================
  HALO ARM STRAP - ESP32 (ESP-NOW sender, packet v2)
  Sensors: MPU6050, BME280, GY-MAX30102, battery sense on GPIO 33
  Sends one 60-byte arm_packet_t to the chest strap every 1 s,
  and immediately when a fall is confirmed.
  =============================================

  CORE
  arduino-esp32 >= 3.0 (ESP-IDF 5.x), board "ESP32 Dev Module" (esp32:esp32:esp32).
  Compiled with 3.3.11 (IDF 5.5.5) and 4.0.0 (IDF 6.1.1). The ESP-NOW send callback
  signature is picked by ESP_IDF_VERSION (IDF >= 5.5 passes esp_now_send_info_t, older
  IDF 5.x passes the MAC), so 3.0-3.2 cores match too; those were not compiled here.

  LIBRARIES (versions tested)
  - Adafruit MPU6050 2.2.9 (needs Adafruit Unified Sensor 1.1.15 and Adafruit BusIO 1.17.4)
  - Adafruit BME280 Library 2.3.0
  - SparkFun MAX3010x Pulse and Proximity Sensor Library 1.1.2 (only MAX30105.h is used;
    the Maxim spo2_algorithm is no longer used)

  WIRING
  I2C bus shared by the three sensors:
    VCC → 3.3V, GND → GND, SDA → GPIO 21, SCL → GPIO 22 (400 kHz)
    Addresses: MPU6050 0x68 · BME280 0x76 · MAX30102 0x57
  Power: 3.7 V 800 mAh Li-ion → TP4056 → MT3608 boost set to 5 V → ESP32 VIN
  Battery sense (new in Session 4, needed for the battery reading):
    TP4056 OUT+ → 100 kΩ → GPIO 33 → 100 kΩ → GND (ESP32 GND)
    plus 100 nF from GPIO 33 to GND (recommended: gives the ADC a low-impedance source)
    A full 4.2 V cell reads 2.1 V at the pin. The divider draws about 21 µA.
    Without the divider the battery is reported as not measured (batt_mv 0, batt_pct 255).

  VALUES SENT (field list in arm_packet_t below)
    heartRate  -1 calibrating, 0 no contact / no sensor / signal lost, else 30..220 bpm
    spO2       -1 calibrating, 0 no contact / no sensor / signal lost, else 70..100 %
    ARM_FLAG_FALL  set on a confirmed fall; stays set while the wearer stays down and
                   clears only after 15 s AND 3 s of sustained movement

  SESSION 4 CHANGES
  - ESP-NOW packet v2 (magic, version, unit id, seq, sensor bits, flags, PPG quality,
    activity, stillness, battery). Flash the chest strap with its matching v2 sketch.
  - Battery voltage and % from the new divider on GPIO 33 (trimmed mean, 30 s filter).
  - CPU at 80 MHz and TX-only ESP-NOW radio power save.
  - HR/SpO2: the Maxim algorithm is replaced by a 50 Hz band-pass beat detector with
    IBI checks, a quality score and motion gating. HR 30..220 and SpO2 70..100 now reach
    the chest (Session 3 dropped anything outside 40..200 / 80..100).
  - Activity (ENMO, mg) and seconds since the last movement, for man-down detection.
  - Fall confirmation needs an orientation change, a >= 3.5 g impact or >= 150 ms of
    free-fall, so a knock followed by standing still is no longer a fall.
  - Sensors are health-checked at run time; a sensor that stops answering is reported
    as absent instead of sending stale values.
*/
#include <Wire.h>
#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_idf_version.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
// MAX30105.h redefines I2C_BUFFER_LENGTH (Wire.h already set it); it only uses the macro
// inside MAX30105.cpp, so the sketch keeps Wire's value and skips the redefinition warning.
#pragma push_macro("I2C_BUFFER_LENGTH")
#undef I2C_BUFFER_LENGTH
#include "MAX30105.h"
#pragma pop_macro("I2C_BUFFER_LENGTH")
#include <math.h>
#include <stdint.h>
#include <string.h>

// ─── CHEST STRAP MAC ADDRESS ──────────────────────────────────────
uint8_t chestStrapMAC[] = {0x1C, 0x69, 0x20, 0xA4, 0x5D, 0x18};
#define ESPNOW_CHANNEL 1          // must match the chest strap

// ─── ESP-NOW PAYLOAD: ARM → CHEST (v2) ── must be byte-identical in arm_strap_v2.ino and chest_strap_v2.ino ───
#define ARM_PKT_MAGIC    0x4D52   // arbitrary constant, rejects foreign ESP-NOW frames
#define ARM_PKT_VERSION  2
#define HALO_UNIT_ID     1        // 1 = "HALO-01"; must match on arm and chest (and appears in the LoRa packet)

#define ARM_SENS_IMU   0x01       // MPU6050 initialised
#define ARM_SENS_BME   0x02       // BME280 initialised
#define ARM_SENS_PPG   0x04       // MAX30102 initialised
#define ARM_SENS_BATT  0x08       // battery sense voltage plausible

#define ARM_FLAG_FALL        0x01 // confirmed fall (latched, see fall detection)
#define ARM_FLAG_SKIN        0x02 // MAX30102 IR level says the sensor is on skin/finger
#define ARM_FLAG_PPG_MOTION  0x04 // HR/SpO2 currently held or suppressed because of motion

typedef struct __attribute__((packed)) {
  uint16_t magic;          // ARM_PKT_MAGIC
  uint8_t  version;        // ARM_PKT_VERSION
  uint8_t  unit_id;        // HALO_UNIT_ID
  uint16_t seq;            // +1 per packet (wraps); chest derives ESP-NOW loss
  uint8_t  sensors;        // ARM_SENS_*
  uint8_t  flags;          // ARM_FLAG_*
  float    accel_x, accel_y, accel_z;   // m/s², latest sample (0 if no IMU)
  float    gyro_x,  gyro_y,  gyro_z;    // rad/s, latest sample
  float    temperature;    // °C ambient (BME280), 0 if no BME
  float    humidity;       // %RH, 0 if no BME
  float    pressure;       // hPa, 0 if no BME
  float    altitude;       // m barometric, 0 if no BME
  int16_t  heartRate;      // bpm: -1 calibrating, 0 no contact / signal lost, else 30..220
  int8_t   spO2;           // %:  -1 calibrating, 0 no contact / signal lost, else 70..100
  uint8_t  ppgQuality;     // 0..100 signal quality of the current HR/SpO2 (0 when no value)
  uint16_t activity_mg;    // mean ENMO over the last 1 s window, milli-g
  uint16_t still_s;        // seconds since the last significant movement (saturates 65535)
  uint16_t batt_mv;        // filtered arm battery voltage, mV; 0 = not measured
  uint8_t  batt_pct;       // 0..100; 255 = unknown
  uint8_t  reserved;       // 0
} arm_packet_t;
static_assert(sizeof(arm_packet_t) == 60, "arm_packet_t layout changed: update arm and chest sketches together");

// ─── TIMING ───────────────────────────────────────────────────────
#define SEND_INTERVAL_MS   1000   // ESP-NOW packet to the chest strap
#define IMU_INTERVAL_MS    10     // MPU6050 sampled at 100 Hz
#define HEALTH_INTERVAL_MS 1000   // sensor health checks
#define DIAG_INTERVAL_MS   30000  // diagnostics line on Serial

// ─── POWER ────────────────────────────────────────────────────────
#define CPU_MHZ                      80     // lowest clock that still runs WiFi / ESP-NOW
#define ARM_RADIO_POWER_SAVE         1      // 1 = radio sleeps between transmissions (arm only sends)
#define ESPNOW_WAKE_WINDOW_MS        10     // radio awake time per wake interval (RX side)
#define ESPNOW_WAKE_INTERVAL_MS      1000
#define ESPNOW_WAKE_WINDOW_DEFAULT   65535  // IDF default: awake for the whole interval
#define ESPNOW_WAKE_INTERVAL_DEFAULT 0      // ESP_WIFI_CONNECTIONLESS_INTERVAL_DEFAULT_MODE

// ─── MAX30102 HEALTH ──────────────────────────────────────────────
#define PPG_STALL_MS       1000   // no FIFO samples for this long = sensor not working
#define PPG_REINIT_MS      10000  // retry interval for re-initialising a stalled sensor
#define PPG_RATE_MIN_MS    30000  // FIFO rate is measured over at least this long

// ─── BME280 ───────────────────────────────────────────────────────
#define SEA_LEVEL_HPA 1013.25f    // set to local QNH for accurate altitude

// ─── I2C ADDRESSES ────────────────────────────────────────────────
#define MPU_ADDR 0x68
#define BME_ADDR 0x76

// >>> HALO_PURE_BEGIN battery
// ─── BATTERY: TP4056 OUT+ → 100 kΩ → GPIO 33 → 100 kΩ → GND ──────
#define BATT_PIN          33
#define BATT_DIVIDER      2.0f    // (R_top + R_bottom) / R_bottom
#define BATT_CAL          1.000f  // trim: multimeter_V / reported_V
#define BATT_SAMPLES      16
#define BATT_PERIOD_MS    1000
#define BATT_TAU_S        30.0f   // EMA time constant
#define BATT_MIN_VALID_MV 2500    // below/above these the sense line is treated as not wired
#define BATT_MAX_VALID_MV 4500
#define BATT_TRIM         4       // readings dropped at each end before averaging
#define BATT_BAD_RUN      3       // implausible samples in a row before "not measured"
static_assert(BATT_SAMPLES > 2 * BATT_TRIM && BATT_SAMPLES <= 32, "BATT_SAMPLES must leave readings after trimming");

#define BATT_EV_NONE  0
#define BATT_EV_LOST  1           // just became "not measured" (log it once)
#define BATT_EV_FOUND 2           // first plausible sample after boot or after an outage

// Li-ion resting voltage (V) → state of charge (%), highest first.
static const float BATT_SOC_TABLE[][2] = {
  {4.20f, 100.0f}, {4.15f, 95.0f}, {4.11f, 90.0f}, {4.08f, 85.0f}, {4.02f, 80.0f}, {3.98f, 75.0f},
  {3.95f, 70.0f},  {3.91f, 65.0f}, {3.87f, 60.0f}, {3.85f, 55.0f}, {3.84f, 50.0f}, {3.82f, 45.0f},
  {3.80f, 40.0f},  {3.79f, 35.0f}, {3.77f, 30.0f}, {3.75f, 25.0f}, {3.73f, 20.0f}, {3.71f, 15.0f},
  {3.69f, 10.0f},  {3.61f, 5.0f},  {3.27f, 0.0f}};
#define BATT_SOC_POINTS ((int)(sizeof(BATT_SOC_TABLE) / sizeof(BATT_SOC_TABLE[0])))

// Piecewise-linear SoC (%) for a battery voltage in volts, clamped to 0..100.
float battSocFromVolts(float v) {
  if (!(v > BATT_SOC_TABLE[BATT_SOC_POINTS - 1][0])) return 0.0f;   // also catches NaN
  if (v >= BATT_SOC_TABLE[0][0]) return 100.0f;
  for (int i = 1; i < BATT_SOC_POINTS; i++) {
    const float vLo = BATT_SOC_TABLE[i][0];
    if (v >= vLo) {
      const float vHi = BATT_SOC_TABLE[i - 1][0];
      const float pHi = BATT_SOC_TABLE[i - 1][1];
      const float pLo = BATT_SOC_TABLE[i][1];
      return pLo + (v - vLo) * (pHi - pLo) / (vHi - vLo);
    }
  }
  return 0.0f;
}

// Mean of mv[0..n-1] after dropping the `trim` highest and `trim` lowest values (n <= 32).
float battTrimmedMean(const int32_t *mv, int n, int trim) {
  int32_t s[32];
  if (n > 32) n = 32;
  for (int i = 0; i < n; i++) {               // insertion sort into s
    const int32_t k = mv[i];
    int j = i - 1;
    while (j >= 0 && s[j] > k) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = k;
  }
  const int m = n - 2 * trim;
  if (m <= 0) return 0.0f;
  int64_t sum = 0;
  for (int i = trim; i < n - trim; i++) sum += s[i];
  return (float)sum / (float)m;
}

struct BattMonitor {
  float   emaMv;       // filtered battery voltage, mV
  bool    seeded;      // emaMv holds a value
  bool    measured;    // false: packet gets batt_mv 0 and batt_pct 255
  bool    lostLogged;  // the current outage has been reported
  uint8_t badRun;      // implausible samples in a row
  uint8_t pct;         // reported SoC, changes only after a 1 % move

  void reset() {
    emaMv = 0.0f;
    seeded = measured = lostLogged = false;
    badRun = 0;
    pct = 255;
  }

  static uint8_t toPct(float soc) {
    long p = lroundf(soc);
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    return (uint8_t)p;
  }

  // rawMv: battery voltage of one sample (trimmed-mean pin mV × BATT_DIVIDER × BATT_CAL).
  // dtS: seconds since the previous sample. Returns a BATT_EV_* code.
  uint8_t update(float rawMv, float dtS) {
    const bool plausible = rawMv >= (float)BATT_MIN_VALID_MV && rawMv <= (float)BATT_MAX_VALID_MV;  // false for NaN
    if (!plausible) {
      if (badRun < 255) badRun++;
      if (badRun >= BATT_BAD_RUN) {
        seeded = measured = false;            // the next plausible sample seeds the filter again
        pct = 255;
        if (!lostLogged) {
          lostLogged = true;
          return BATT_EV_LOST;
        }
      }
      return BATT_EV_NONE;                    // 1-2 bad samples: keep the last filtered value
    }
    badRun = 0;
    uint8_t ev = BATT_EV_NONE;
    if (!seeded) {
      emaMv = rawMv;
      seeded = true;
      pct = toPct(battSocFromVolts(emaMv / 1000.0f));
      ev = BATT_EV_FOUND;
    } else {
      const float a = (dtS > 0.0f) ? 1.0f - expf(-dtS / BATT_TAU_S) : 0.0f;
      emaMv += a * (rawMv - emaMv);
      const float soc = battSocFromVolts(emaMv / 1000.0f);
      if (fabsf(soc - (float)pct) >= 1.0f) pct = toPct(soc);
    }
    measured = true;
    lostLogged = false;
    return ev;
  }

  uint16_t reportMv() const { return measured ? (uint16_t)lroundf(emaMv) : 0; }
  uint8_t reportPct() const { return measured ? pct : 255; }
};
// <<< HALO_PURE_END battery

// >>> HALO_PURE_BEGIN ppg
// ─── MAX30102 SETTINGS (particleSensor.setup in setup() uses exactly these) ──
#define PPG_LED          0x5F     // LED current, 0.2 mA per step: 0x5F = 19 mA
#define PPG_SAMPLE_AVG   2        // ADC samples averaged into one FIFO entry
#define PPG_LED_MODE     2        // 2 = Red + IR
#define PPG_SPS          100      // ADC samples per second
#define PPG_PULSE_WIDTH  411      // LED pulse width, µs (18-bit ADC)
#define PPG_ADC_RANGE    16384    // ADC full scale, nA
#define PPG_FS           (PPG_SPS / PPG_SAMPLE_AVG)   // FIFO entries per second = pipeline rate
static_assert(PPG_FS == 50, "the PPG pipeline is tuned and tested at 50 Hz: keep PPG_SPS / PPG_SAMPLE_AVG == 50");
static_assert(PPG_SPS % PPG_SAMPLE_AVG == 0, "PPG_SPS must be a multiple of PPG_SAMPLE_AVG");
static_assert(PPG_SAMPLE_AVG == 1 || PPG_SAMPLE_AVG == 2 || PPG_SAMPLE_AVG == 4 || PPG_SAMPLE_AVG == 8 ||
              PPG_SAMPLE_AVG == 16 || PPG_SAMPLE_AVG == 32, "MAX30105::setup() would silently use 4");
static_assert(PPG_SPS == 50 || PPG_SPS == 100 || PPG_SPS == 200 || PPG_SPS == 400 || PPG_SPS == 800 ||
              PPG_SPS == 1000 || PPG_SPS == 1600 || PPG_SPS == 3200, "MAX30105::setup() would round PPG_SPS down");
static_assert(PPG_PULSE_WIDTH == 69 || PPG_PULSE_WIDTH == 118 || PPG_PULSE_WIDTH == 215 || PPG_PULSE_WIDTH == 411,
              "MAX30105::setup() would use another pulse width");
static_assert(PPG_ADC_RANGE == 2048 || PPG_ADC_RANGE == 4096 || PPG_ADC_RANGE == 8192 || PPG_ADC_RANGE == 16384,
              "MAX30105::setup() would use another ADC range");
static_assert(PPG_LED_MODE == 2, "the pipeline reads Red + IR");
static_assert(PPG_PULSE_WIDTH != 411 || PPG_SPS <= 400, "MAX30102 SpO2 mode allows at most 400 sps with 411 us pulses");

// ─── PPG CONTACT ──────────────────────────────────────────────────
#define FINGER_ON_LEVEL      80000  // IR counts: contact starts at or above this (Session 3 tuning)
#define FINGER_OFF_LEVEL     60000  // IR counts: contact ends below this (hysteresis)
#define PPG_CONTACT_SAMPLES  5      // samples in a row needed to change the contact state (100 ms)

// ─── PPG PIPELINE ─────────────────────────────────────────────────
#define PPG_DC_TAU_S         1.5f   // DC = EMA low-pass with this time constant
#define PPG_HP_HZ            0.5f   // AC = 2nd-order Butterworth high-pass ...
#define PPG_LP_HZ            4.0f   // ... followed by a 2nd-order Butterworth low-pass
#define PPG_SETTLE_S         2.0f   // after contact the filters settle; no beat detection
#define PPG_SETTLE_WIN_S     1.25f  // last part of the settle time, used to seed the envelope
#define PPG_THRESH_FRAC      0.5f   // a peak/trough counts once the signal moves this × envelope away
#define PPG_MIN_DELTA        2.0f   // floor of that threshold, ADC counts
#define PPG_ENV_TAU_S        3.0f   // envelope of beat amplitudes decays with this time constant
#define PPG_ENV_MAX_STEP     3.0f   // one beat raises the envelope by at most this factor
#define PPG_REFRACTORY_S     0.27f  // 220 bpm
#define PPG_IBI_MIN_S        0.27f  // accepted IBI range: 220 ...
#define PPG_IBI_MAX_S        2.0f   // ... to 30 bpm
#define PPG_IBI_TOL          0.30f  // reject an IBI more than 30 % from the median
#define PPG_LEARN_IBIS       3      // the first 3 IBIs skip the median check
#define PPG_GAP_S            4.0f   // no accepted beat for this long: re-learn; estimate not valid
#define PPG_EARLY_RELEARN    3      // this many early (ignored) beats among the last 8 force re-learning
#define PPG_AMP_RATIO        2.5f   // beat amplitude this far above/below the recent median = artifact
#define PPG_RESEED_S         2.5f   // no peak for this long (outside motion): re-seed the envelope ...
#define PPG_RESEED_WIN       100    // ... from the peak-to-peak of the last 2 s
#define PPG_FID_HALF         1      // peak/trough levels are means of 2 × PPG_FID_HALF + 1 samples
#define PPG_HIST             8      // IBIs and per-beat ratios kept for the medians
#define PPG_WINDOW_S         10.0f  // HR/SpO2 use the beats of the last 10 s ...
#define PPG_MIN_BEATS        4      // ... and need at least 4 of them
#define PPG_R_MIN            0.20f  // per-beat ratio R outside this range is discarded
#define PPG_R_MAX            2.00f
#define PPG_SPO2_A          -45.060f // SpO2 = A·R² + B·R + C (Maxim calibration curve)
#define PPG_SPO2_B           30.354f
#define PPG_SPO2_C           94.845f
#define PPG_PI_MIN           0.0005f // perfusion index AC_ir/DC_ir is plausible from 0.05 % ...
#define PPG_PI_FULL          0.0010f // ... (full quality from 0.10 %) ...
#define PPG_PI_MAX           0.10f   // ... up to 10 %
#define PPG_CV_GOOD          0.05f   // IBI coefficient of variation: full quality at or below ...
#define PPG_CV_BAD           0.25f   // ... zero quality at or above
#define PPG_MOT_GOOD_MG      50      // activity_mg: full quality at or below; half quality at the gate
#define PPG_MOTION_GATE_MG   150     // activity_mg above this: no new beats are accepted
#define PPG_Q_MIN            40      // estimates with lower quality are not published
#define PPG_HOLD_S           10.0f   // no valid value for 10 s → 0; also the motion hold limit
#define PPG_CAL_TIMEOUT_S    15.0f   // -1 (calibrating) lasts at most 15 s after contact
#define PPG_OUT_MEDIAN       5       // output = median of the last 5 published one-second values
#define PPG_HR_OUT_MIN       30
#define PPG_HR_OUT_MAX       220
#define PPG_SPO2_OUT_MIN     70
#define PPG_SPO2_OUT_MAX     100
#define PPG_RING             128u    // pulse history, samples (power of 2)
static_assert((PPG_RING & (PPG_RING - 1u)) == 0, "PPG_RING must be a power of 2");
static_assert(PPG_RESEED_WIN + 2 * PPG_FID_HALF + 2 < (int)PPG_RING, "PPG_RING too short");
static_assert(PPG_HIST <= 16 && PPG_OUT_MEDIAN <= 16, "ppgMedian sorts at most 16 values");
static_assert(PPG_HIST == 8, "the early-beat history is an 8-bit shift register");

// Median of v[0..n-1] (n <= 16); 0 for n == 0.
float ppgMedian(const float *v, int n) {
  float s[16];
  if (n <= 0) return 0.0f;
  if (n > 16) n = 16;
  for (int i = 0; i < n; i++) {               // insertion sort into s
    const float k = v[i];
    int j = i - 1;
    while (j >= 0 && s[j] > k) {
      s[j + 1] = s[j];
      j--;
    }
    s[j + 1] = k;
  }
  return (n & 1) ? s[n / 2] : 0.5f * (s[n / 2 - 1] + s[n / 2]);
}

// SpO2 (%) from the ratio of ratios R, clamped to 70..100. Below the top of the curve
// (R = 0.337, SpO2 = 99.96) the quadratic falls again, so smaller R is held at the top.
float ppgSpo2FromR(float r) {
  const float rTop = -PPG_SPO2_B / (2.0f * PPG_SPO2_A);
  if (r < rTop) r = rTop;
  float s = PPG_SPO2_A * r * r + PPG_SPO2_B * r + PPG_SPO2_C;
  if (s < (float)PPG_SPO2_OUT_MIN) s = (float)PPG_SPO2_OUT_MIN;
  if (s > (float)PPG_SPO2_OUT_MAX) s = (float)PPG_SPO2_OUT_MAX;
  return s;
}

// 0 at x <= x0, 1 at x >= x1, linear in between (x0 < x1).
float ppgRamp(float x, float x0, float x1) {
  if (x <= x0) return 0.0f;
  if (x >= x1) return 1.0f;
  return (x - x0) / (x1 - x0);
}

// 2nd-order Butterworth section (RBJ cookbook, Q = 1/sqrt(2)), transposed direct form II.
struct PpgBiquad {
  float b0, b1, b2, a1, a2, z1, z2;
  void design(float fs, float f0, bool highpass) {
    const double w0 = 2.0 * 3.14159265358979323846 * (double)f0 / (double)fs;
    const double c = cos(w0);
    const double alpha = sin(w0) / (2.0 * 0.70710678118654752440);
    const double a0 = 1.0 + alpha;
    const double bEdge = highpass ? (1.0 + c) / 2.0 : (1.0 - c) / 2.0;
    const double bMid = highpass ? -(1.0 + c) : (1.0 - c);
    b0 = (float)(bEdge / a0);
    b1 = (float)(bMid / a0);
    b2 = (float)(bEdge / a0);
    a1 = (float)(-2.0 * c / a0);
    a2 = (float)((1.0 - alpha) / a0);
    z1 = z2 = 0.0f;
  }
  void clear() { z1 = z2 = 0.0f; }
  float step(float x) {
    const float y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};

// One optical channel: DC by EMA, AC by band-pass of (x - DC).
struct PpgChannel {
  float     dc;
  PpgBiquad hp, lp;
  void design(float fs) {
    hp.design(fs, PPG_HP_HZ, true);
    lp.design(fs, PPG_LP_HZ, false);
  }
  void start(float x) {
    dc = x;
    hp.clear();
    lp.clear();
  }
  float step(float x, float dcAlpha) {
    dc += dcAlpha * (x - dc);
    return lp.step(hp.step(x - dc));
  }
};

// Output stage of one value (HR or SpO2): -1 until the first valid value (max 15 s),
// then the median of the last 5 published one-second values, 0 after 10 s without one.
struct PpgOutput {
  float   hist[PPG_OUT_MEDIAN];
  uint8_t n, head;
  bool    everValid;
  float   lastValidS;   // seconds since contact of the last published value
  int16_t value;        // packet value
  void reset() {
    n = head = 0;
    everValid = false;
    lastValidS = 0.0f;
    value = 0;
  }
  void start() {
    reset();
    value = -1;
  }
  void step(bool valid, float v, float nowS, int lo, int hi) {
    if (valid) {
      hist[head] = v;
      head = (uint8_t)((head + 1) % PPG_OUT_MEDIAN);
      if (n < PPG_OUT_MEDIAN) n++;
      everValid = true;
      lastValidS = nowS;
    }
    if (!everValid) {
      value = (nowS < PPG_CAL_TIMEOUT_S) ? -1 : 0;
      return;
    }
    if (nowS - lastValidS >= PPG_HOLD_S) {   // signal lost: drop the old values
      n = head = 0;
      value = 0;
      return;
    }
    long r = lroundf(ppgMedian(hist, n));
    if (r < lo) r = lo;
    if (r > hi) r = hi;
    value = (int16_t)r;
  }
};

// The whole HR / SpO2 pipeline. push() takes one FIFO sample (50 Hz); the outputs are
// refreshed once per 50 samples. Times inside are counted in samples since contact.
struct PpgPipeline {
  float      tbase;              // seconds per FIFO sample (1 / measured rate)
  float      dcAlpha, envDecay;
  uint32_t   settleN, settleWinN;
  PpgChannel ir, red;
  bool       contact;
  uint8_t    contactRun;
  uint32_t   n;                  // samples since contact
  uint16_t   secN;               // samples into the current one-second step
  float      pIr[PPG_RING], pRed[PPG_RING];   // pulse signals (-AC), index n & (PPG_RING-1)
  bool       detecting, lookPeak, haveValley;
  float      env, setMax, setMin, mx, mn, valleyVal;
  uint32_t   mxIdx, mnIdx, valleyIdx;
  uint32_t   lastPeakN;          // sample index of the last confirmed peak
  bool       haveRef, haveAccept;
  double     refT, lastAcceptT;  // beat times in samples since contact (with sub-sample part)
  // accepted beats (cleared when re-learning): the IBI ending at the beat and that beat's values
  float      ibi[PPG_HIST];      // s
  double     ibiT[PPG_HIST];
  float      beatPi[PPG_HIST];   // perfusion index AC_ir/DC_ir (0 = not measured)
  float      beatR[PPG_HIST];    // ratio of ratios (0 = not measured or out of range)
  uint8_t    ibiN, ibiHead;
  // amplitudes of accepted beats, kept across re-learning (artifact reference, 10 s)
  float      ampVal[PPG_HIST];
  double     ampT[PPG_HIST];
  uint8_t    ampN, ampHead;
  uint8_t    early, earlyN;      // last 8 candidate beats; bit set = ignored as too early
  uint16_t   act;                // activity_mg from the IMU
  bool       gatedNow, gatedSec, motionHold;
  float      gateEndS;
  PpgOutput  hrOut, spOut;
  uint8_t    qLast, qOut;
  float      hrEst, spEst, qEst; // latest one-second estimates (0 = none), for the log
  uint32_t   beatsSeen, beatsAccepted, beatsArtifact, lostSamples;

  void init() {
    tbase = 1.0f / (float)PPG_FS;
    dcAlpha = 1.0f - expf(-1.0f / ((float)PPG_FS * PPG_DC_TAU_S));
    envDecay = expf(-1.0f / ((float)PPG_FS * PPG_ENV_TAU_S));
    settleN = (uint32_t)(PPG_SETTLE_S * (float)PPG_FS + 0.5f);
    settleWinN = (uint32_t)((PPG_SETTLE_S - PPG_SETTLE_WIN_S) * (float)PPG_FS + 0.5f);
    ir.design((float)PPG_FS);
    red.design((float)PPG_FS);
    contactRun = 0;
    beatsSeen = beatsAccepted = beatsArtifact = lostSamples = 0;
    stopContact();
  }

  // Timing uses the measured FIFO rate (the MAX30102 runs on its own oscillator).
  // Values more than 5 % off the nominal rate are ignored.
  bool setSampleRate(float fsMeasured) {
    if (!(fsMeasured >= 0.95f * (float)PPG_FS && fsMeasured <= 1.05f * (float)PPG_FS)) return false;
    tbase = 1.0f / fsMeasured;
    return true;
  }

  void push(uint32_t irRaw, uint32_t redRaw, uint16_t activityMg) {
    act = activityMg;
    const bool want = contact ? (irRaw >= FINGER_OFF_LEVEL) : (irRaw >= FINGER_ON_LEVEL);
    if (want != contact) {
      if (++contactRun >= PPG_CONTACT_SAMPLES) {
        contactRun = 0;
        if (want) startContact((float)irRaw, (float)redRaw);
        else stopContact();
      }
    } else {
      contactRun = 0;
    }
    if (contact) sample((float)irRaw, (float)redRaw);
  }

  // `count` FIFO samples were lost (SparkFun ring overrun): advance the sample clock so beat
  // times stay right. The reference beat is kept: an IBI across the gap is still timed correctly,
  // and a beat lost in the gap gives a long IBI that the 30 % rule rejects.
  void skip(uint16_t count) {
    if (!contact) return;
    lostSamples += count;
    for (uint16_t i = 0; i < count; i++) {
      const uint32_t k = n & (PPG_RING - 1u), kp = (n - 1u) & (PPG_RING - 1u);
      pIr[k] = pIr[kp];
      pRed[k] = pRed[kp];
      n++;
      if (++secN >= PPG_FS) {
        secN = 0;
        secondStep();
      }
    }
  }

  void forceNoContact() {
    contactRun = 0;
    stopContact();
  }

  int16_t heartRate() const { return contact ? hrOut.value : 0; }
  int8_t spo2() const { return contact ? (int8_t)spOut.value : 0; }
  uint8_t quality() const { return contact ? qOut : 0; }
  bool skin() const { return contact; }
  bool motionFlag() const { return contact && (gatedNow || motionHold); }

  void stopContact() {
    contact = false;
    n = 0;
    secN = 0;
    detecting = lookPeak = haveValley = false;
    lastPeakN = 0;
    haveRef = haveAccept = false;
    refT = lastAcceptT = 0.0;
    ibiN = ibiHead = ampN = ampHead = 0;
    early = earlyN = 0;
    gatedNow = gatedSec = motionHold = false;
    gateEndS = 0.0f;
    hrOut.reset();
    spOut.reset();
    qLast = qOut = 0;
    hrEst = spEst = qEst = 0.0f;
  }

  void startContact(float irv, float redv) {
    stopContact();
    contact = true;
    ir.start(irv);
    red.start(redv);
    env = 0.0f;
    setMax = -1e30f;
    setMin = 1e30f;
    hrOut.start();
    spOut.start();
  }

  float at(const float *r, uint32_t i) const { return r[i & (PPG_RING - 1u)]; }
  float level(const float *r, uint32_t i) const {   // mean of 2*PPG_FID_HALF+1 samples around i
    float s = 0.0f;
    for (int d = -PPG_FID_HALF; d <= PPG_FID_HALF; d++) s += at(r, i + (uint32_t)d);
    return s / (float)(2 * PPG_FID_HALF + 1);
  }
  float ageS(double t) const { return (float)(((double)n - t) * (double)tbase); }

  // Median amplitude of the beats accepted in the last PPG_WINDOW_S; 0 if fewer than 3.
  float ampReference() const {
    float a[PPG_HIST];
    int m = 0;
    for (int i = 0; i < ampN; i++) {
      const int idx = (ampHead + PPG_HIST - 1 - i) % PPG_HIST;
      if (ageS(ampT[idx]) > PPG_WINDOW_S) break;
      a[m++] = ampVal[idx];
    }
    return (m >= 3) ? ppgMedian(a, m) : 0.0f;
  }

  // No peak for PPG_RESEED_S: the envelope is too high (contact transient, amplitude drop).
  void reseed(float p) {
    float lo = p, hi = p;
    for (uint32_t d = 1; d < (uint32_t)PPG_RESEED_WIN; d++) {
      const float v = at(pIr, n - d);
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    env = hi - lo;
    lookPeak = false;
    haveValley = false;
    mn = p;
    mnIdx = n;
    lastPeakN = n;
  }

  void sample(float irv, float redv) {
    const float p = -ir.step(irv, dcAlpha);     // IR falls when blood volume rises: use -AC
    const float pr = -red.step(redv, dcAlpha);
    const uint32_t k = n & (PPG_RING - 1u);
    pIr[k] = p;
    pRed[k] = pr;
    const bool gated = act > PPG_MOTION_GATE_MG;
    gatedNow = gated;
    if (gated) gatedSec = true;
    else env *= envDecay;                        // frozen while motion blocks the beats
    if (n < settleN) {
      if (n >= settleWinN) {
        if (p > setMax) setMax = p;
        if (p < setMin) setMin = p;
      }
    } else {
      if (!detecting) {
        detecting = true;
        env = (setMax > setMin) ? setMax - setMin : 0.0f;
        lookPeak = false;
        haveValley = false;
        mn = p;
        mnIdx = n;
        lastPeakN = n;
      }
      detect(p, gated);
      if (gated) lastPeakN = n;                  // re-seed only after PPG_RESEED_S without motion
      else if ((float)(n - lastPeakN) * tbase > PPG_RESEED_S) reseed(p);
    }
    n++;
    if (++secN >= PPG_FS) {
      secN = 0;
      secondStep();
    }
  }

  // Alternating trough/peak search with hysteresis: a peak is the maximum since the last
  // trough, confirmed once the signal falls PPG_THRESH_FRAC × envelope below it (and the
  // reverse for troughs). A dicrotic wave smaller than that is not a beat.
  void detect(float p, bool gated) {
    float delta = PPG_THRESH_FRAC * env;
    if (delta < PPG_MIN_DELTA) delta = PPG_MIN_DELTA;
    if (lookPeak) {
      if (p > mx) {
        mx = p;
        mxIdx = n;
      } else if (p < mx - delta) {
        onPeak(gated);
        lookPeak = false;
        mn = p;
        mnIdx = n;
      }
    } else {
      if (p < mn) {
        mn = p;
        mnIdx = n;
      } else if (p > mn + delta) {
        haveValley = true;
        valleyIdx = mnIdx;
        valleyVal = mn;
        lookPeak = true;
        mx = p;
        mxIdx = n;
      }
    }
  }

  void onPeak(bool gated) {
    const uint32_t k = mxIdx;                    // k + 1 <= n, so all three samples exist
    const float ym = at(pIr, k - 1u), y0 = at(pIr, k), yp = at(pIr, k + 1u);
    const float den = ym - 2.0f * y0 + yp;
    float frac = 0.0f;
    if (den < 0.0f) {                            // parabolic interpolation of the peak time
      frac = 0.5f * (ym - yp) / den;
      if (frac > 0.5f) frac = 0.5f;
      if (frac < -0.5f) frac = -0.5f;
    }
    lastPeakN = n;
    bool ampOk = haveValley && valleyIdx < k && k + (uint32_t)PPG_FID_HALF <= n &&
                 (n - valleyIdx) + (uint32_t)PPG_FID_HALF < PPG_RING;
    float amp = 0.0f, acIr = 0.0f, acRed = 0.0f;
    if (ampOk) {
      amp = mx - valleyVal;
      // Peak-to-trough in both channels, at the IR peak and trough (short means against noise).
      acIr = level(pIr, k) - level(pIr, valleyIdx);
      acRed = level(pRed, k) - level(pRed, valleyIdx);
      ampOk = amp > 0.0f && acIr > 0.0f && acRed > 0.0f;
    }
    haveValley = false;
    onBeat((double)k + (double)frac, gated, ampOk, amp, acIr, acRed);
  }

  void relearn() {
    ibiN = ibiHead = 0;
    early = earlyN = 0;
  }

  void noteCandidate(bool isEarly) {
    early = (uint8_t)((early << 1) | (isEarly ? 1u : 0u));
    if (earlyN < 8) earlyN++;
  }

  int earlyCount() const {
    const uint8_t mask = (earlyN >= 8) ? 0xFFu : (uint8_t)((1u << earlyN) - 1u);
    uint8_t b = (uint8_t)(early & mask);
    int c = 0;
    while (b) {
      c += b & 1u;
      b = (uint8_t)(b >> 1);
    }
    return c;
  }

  void onBeat(double t, bool gated, bool ampOk, float amp, float acIr, float acRed) {
    beatsSeen++;
    if (gated) {                                 // motion: no beats, and no IBI across the burst
      haveRef = false;
      return;
    }
    if (ampOk) {
      const float ref = ampReference();
      if (ref > 0.0f && (amp > PPG_AMP_RATIO * ref || amp * PPG_AMP_RATIO < ref)) {
        beatsArtifact++;                         // artifact: ignore it, keep the reference beat
        return;
      }
      const float cap = env * PPG_ENV_MAX_STEP;  // envelope = decaying max of beat amplitudes
      const float a = (env > 0.0f && amp > cap) ? cap : amp;
      if (a > env) env = a;
    }
    if (!haveRef) {
      haveRef = true;
      refT = t;
      return;
    }
    const float ibiS = (float)((t - refT) * (double)tbase);
    if (ibiS < PPG_REFRACTORY_S) return;         // inside the refractory period of the reference
    if (haveAccept && (float)((t - lastAcceptT) * (double)tbase) > PPG_GAP_S) relearn();
    if (ibiS > PPG_IBI_MAX_S) {                  // too slow to be one beat: restart from here
      refT = t;
      return;
    }
    if (ibiN >= PPG_LEARN_IBIS) {
      const float med = ppgMedian(ibi, ibiN);
      if (ibiS < med * (1.0f - PPG_IBI_TOL)) {   // extra peak (noise, dicrotic wave): keep the reference
        noteCandidate(true);
        if (earlyCount() >= PPG_EARLY_RELEARN) relearn();
        return;
      }
      if (ibiS > med * (1.0f + PPG_IBI_TOL)) {   // probably a missed beat: restart from this one
        noteCandidate(false);
        refT = t;
        return;
      }
    }
    noteCandidate(false);
    float r = 0.0f;
    if (ampOk && ir.dc > 0.0f && red.dc > 0.0f) {
      r = (acRed / red.dc) / (acIr / ir.dc);
      if (r < PPG_R_MIN || r > PPG_R_MAX) r = 0.0f;
    }
    ibi[ibiHead] = ibiS;
    ibiT[ibiHead] = t;
    beatPi[ibiHead] = (ampOk && ir.dc > 0.0f) ? acIr / ir.dc : 0.0f;
    beatR[ibiHead] = r;
    ibiHead = (uint8_t)((ibiHead + 1) % PPG_HIST);
    if (ibiN < PPG_HIST) ibiN++;
    if (ampOk) {
      ampVal[ampHead] = amp;
      ampT[ampHead] = t;
      ampHead = (uint8_t)((ampHead + 1) % PPG_HIST);
      if (ampN < PPG_HIST) ampN++;
    }
    refT = t;
    lastAcceptT = t;
    haveAccept = true;
    beatsAccepted++;
  }

  // Once per second: estimate, score, publish.
  void secondStep() {
    const float nowS = (float)((double)n * (double)tbase);
    int win[PPG_HIST];
    float w[PPG_HIST];
    int nw = 0;
    for (int i = 0; i < ibiN; i++) {             // accepted beats of the last 10 s, newest first
      const int idx = (ibiHead + PPG_HIST - 1 - i) % PPG_HIST;
      if (ageS(ibiT[idx]) > PPG_WINDOW_S) break;
      win[nw] = idx;
      w[nw++] = ibi[idx];
    }
    // Same 30 % rule as beat acceptance, applied to the window: an IBI taken during
    // re-learning (no median check) cannot skew the estimate or the score.
    const float med0 = ppgMedian(w, nw);
    float sel[PPG_HIST], piSel[PPG_HIST], sp[PPG_HIST];
    int m = 0, mp = 0, ms = 0;
    for (int i = 0; i < nw; i++) {
      const int idx = win[i];
      if (fabsf(ibi[idx] - med0) > PPG_IBI_TOL * med0) continue;
      sel[m++] = ibi[idx];
      if (beatPi[idx] > 0.0f) piSel[mp++] = beatPi[idx];
      if (beatR[idx] > 0.0f) sp[ms++] = ppgSpo2FromR(beatR[idx]);
    }
    const bool fresh = haveAccept && ageS(lastAcceptT) <= PPG_GAP_S;
    const bool hrValid = fresh && m >= PPG_MIN_BEATS;
    float q = 0.0f;
    hrEst = 0.0f;
    if (hrValid) {
      hrEst = 60.0f / ppgMedian(sel, m);
      float mean = 0.0f, var = 0.0f;
      for (int i = 0; i < m; i++) mean += sel[i];
      mean /= (float)m;
      for (int i = 0; i < m; i++) var += (sel[i] - mean) * (sel[i] - mean);
      const float cv = sqrtf(var / (float)m) / mean;
      const float pi = ppgMedian(piSel, mp);
      const float qCv = 1.0f - ppgRamp(cv, PPG_CV_GOOD, PPG_CV_BAD);
      const float qPi = (pi > PPG_PI_MAX) ? 0.0f : ppgRamp(pi, PPG_PI_MIN, PPG_PI_FULL);
      float qMot = 1.0f - 0.5f * ppgRamp((float)act, (float)PPG_MOT_GOOD_MG, (float)PPG_MOTION_GATE_MG);
      if (act > PPG_MOTION_GATE_MG) qMot = 0.0f;
      q = 100.0f * qCv * qPi * qMot;
    }
    qEst = q;
    const bool spValid = hrValid && ms >= PPG_MIN_BEATS;
    spEst = spValid ? ppgMedian(sp, ms) : 0.0f;
    const bool publish = !gatedSec && q >= (float)PPG_Q_MIN;
    hrOut.step(publish && hrValid, hrEst, nowS, PPG_HR_OUT_MIN, PPG_HR_OUT_MAX);
    spOut.step(publish && spValid, spEst, nowS, PPG_SPO2_OUT_MIN, PPG_SPO2_OUT_MAX);
    if (publish && hrValid) qLast = (uint8_t)lroundf(q);
    qOut = (hrOut.value > 0 || spOut.value > 0) ? qLast : 0;
    if (gatedSec) {                              // motion flag: gate active, or values still from before it
      motionHold = true;
      gateEndS = nowS;
    } else if (motionHold && ((publish && hrValid) || nowS - gateEndS >= PPG_HOLD_S)) {
      motionHold = false;
    }
    gatedSec = false;
  }
};
// <<< HALO_PURE_END ppg

// >>> HALO_PURE_BEGIN motion
// ─── ACTIVITY + STILLNESS (MPU6050, 100 Hz) ───────────────────────
#define GRAVITY            9.80665f  // m/s² per g
#define IMU_HZ             100       // sampleIMU() rate (IMU_INTERVAL_MS = 10)
#define MOTION_WINDOW      100       // ENMO samples in activity_mg (1 s)
#define MOTION_LP_TAU_S    0.5f      // gravity low-pass for the dynamic acceleration
#define MOTION_DYN_G       0.08f     // |a - lowpass(a)| above this = significant movement
#define MOTION_GYRO_RADS   0.35f     // |gyro| above this = significant movement
#define MOTION_QUIET_G     0.02f     // arm at rest: dynamic acceleration below this ...
#define MOTION_QUIET_N     100       // ... for 1 s; then gyro bias and the 1 g level are learned
#define MOTION_CAL_TAU_S   5.0f      // learning time constant at rest
#define MOTION_BIAS_MAX    0.2f      // rad/s, limit of the learned gyro bias per axis. Brings even the
                                     // MPU6050 worst-case offset (±20 °/s = 0.35 rad/s) under MOTION_GYRO_RADS,
                                     // and limits what a slow steady turn at rest can be mistaken for.
#define MOTION_G_MIN       0.90f     // limits of the learned 1 g level (accelerometer scale/offset error)
#define MOTION_G_MAX       1.10f

struct MotionTracker {
  float    lp[3];
  bool     lpInit;
  uint16_t enmo[MOTION_WINDOW];
  uint32_t enmoSum;
  uint16_t enmoHead, enmoN;
  float    bias[3];          // learned gyro zero-rate offset, rad/s
  float    gLevel;           // learned |a| at rest, g (this sensor's own 1 g)
  uint16_t quietRun;
  float    lpAlpha, calAlpha;
  uint32_t lastMoveMs;
  uint16_t activityMg;       // mean ENMO over the last 1 s, mg
  uint16_t stillS;           // whole seconds since the last significant movement
  float    gyroMag;          // |gyro - bias|, rad/s
  float    dynG;             // |a - lowpass(a)|, g
  bool     moving;           // the latest sample was significant movement

  void reset(uint32_t nowMs) {
    lpAlpha = 1.0f - expf(-1.0f / ((float)IMU_HZ * MOTION_LP_TAU_S));
    calAlpha = 1.0f - expf(-1.0f / ((float)IMU_HZ * MOTION_CAL_TAU_S));
    bias[0] = bias[1] = bias[2] = 0.0f;
    gLevel = 1.0f;
    restart(nowMs);
  }

  // Clears the windows (e.g. after a sensor outage) and keeps the learned calibration.
  void restart(uint32_t nowMs) {
    lpInit = false;
    enmoSum = 0;
    enmoHead = enmoN = 0;
    quietRun = 0;
    lastMoveMs = nowMs;
    activityMg = stillS = 0;
    gyroMag = dynG = 0.0f;
    moving = false;
  }

  // a in m/s², g in rad/s, one call per IMU sample.
  void update(float ax, float ay, float az, float gx, float gy, float gz, uint32_t nowMs) {
    const float v[3] = {ax / GRAVITY, ay / GRAVITY, az / GRAVITY};
    const float mag = sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);

    // ENMO = max(|a|/g - 1, 0), g = the 1 g level this sensor reads at rest
    float e = mag / gLevel - 1.0f;
    if (e < 0.0f) e = 0.0f;
    float emg = e * 1000.0f;
    if (emg > 65535.0f) emg = 65535.0f;
    const uint16_t emgI = (uint16_t)(emg + 0.5f);
    if (enmoN == MOTION_WINDOW) enmoSum -= enmo[enmoHead];
    else enmoN++;
    enmo[enmoHead] = emgI;
    enmoSum += emgI;
    enmoHead = (uint16_t)((enmoHead + 1) % MOTION_WINDOW);
    activityMg = (uint16_t)((enmoSum + enmoN / 2u) / enmoN);

    // dynamic acceleration against a 0.5 s low-pass of the vector
    if (!lpInit) {
      lp[0] = v[0];
      lp[1] = v[1];
      lp[2] = v[2];
      lpInit = true;
    }
    float d2 = 0.0f;
    for (int i = 0; i < 3; i++) {
      lp[i] += lpAlpha * (v[i] - lp[i]);
      const float d = v[i] - lp[i];
      d2 += d * d;
    }
    dynG = sqrtf(d2);

    const float w[3] = {gx - bias[0], gy - bias[1], gz - bias[2]};
    gyroMag = sqrtf(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);

    moving = dynG > MOTION_DYN_G || gyroMag > MOTION_GYRO_RADS;
    if (moving) lastMoveMs = nowMs;
    const uint32_t s = (nowMs - lastMoveMs) / 1000u;
    stillS = (uint16_t)(s > 65535u ? 65535u : s);

    // At rest: learn the gyro zero-rate offset and the 1 g level
    if (dynG < MOTION_QUIET_G) {
      if (quietRun < 65535) quietRun++;
    } else {
      quietRun = 0;
    }
    if (quietRun >= MOTION_QUIET_N) {
      const float g[3] = {gx, gy, gz};
      for (int i = 0; i < 3; i++) {
        bias[i] += calAlpha * (g[i] - bias[i]);
        if (bias[i] > MOTION_BIAS_MAX) bias[i] = MOTION_BIAS_MAX;
        if (bias[i] < -MOTION_BIAS_MAX) bias[i] = -MOTION_BIAS_MAX;
      }
      gLevel += calAlpha * (mag - gLevel);
      if (gLevel < MOTION_G_MIN) gLevel = MOTION_G_MIN;
      if (gLevel > MOTION_G_MAX) gLevel = MOTION_G_MAX;
    }
  }
};
// <<< HALO_PURE_END motion

// >>> HALO_PURE_BEGIN fall
// ─── FALL DETECTION ───────────────────────────────────────────────
#define IMPACT_G            2.5f   // trigger: |a| above this (g) ...
#define FREEFALL_G          0.5f   // ... or |a| below this ...
#define FREEFALL_MIN_MS     80     // ... for at least this long
#define STILL_ACCEL_TOL_G   0.25f  // still: |a| within 1 g ± this ...
#define STILL_GYRO_TOL      0.5f   // ... and rotation below this, rad/s (gyro bias removed)
#define STILL_MS            1500   // stillness needed to confirm ...
#define CONFIRM_TIMEOUT_MS  5000   // ... completed within this time after the trigger
#define FALL_ORIENT_DEG     35.0f  // evidence: arm orientation changed at least this much, or
#define FALL_STRONG_G       3.5f   //           peak impact at least this, or
#define FALL_LONG_FF_MS     150    //           free-fall lasted at least this long
#define FALL_HIST           100    // accel history for the pre-trigger gravity vector (1 s)
#define FALL_PRE_SKIP       20     // g_pre leaves out the last 0.2 s before the trigger
#define FALL_PRE_MIN        40     // g_pre needs at least this many samples (0.4 s)
#define FALL_HOLD_MS        15000  // latch: at least this long after confirmation ...
#define FALL_CLEAR_MG       50     // ... and the wearer moving again (activity_mg above this) ...
#define FALL_CLEAR_MS       3000   // ... for this long before the flag clears ...
#define FALL_CLEAR_GAP_MS   1500   // ... where pauses shorter than this don't restart the count

#define FALL_EV_TRIGGER 0x01       // update() result bits
#define FALL_EV_CONFIRM 0x02
#define FALL_EV_REJECT  0x04       // still in time, but no orientation change / strong impact / long free-fall
#define FALL_EV_CANCEL  0x08       // kept moving for the whole confirm window
#define FALL_EV_CLEAR   0x10       // latched flag released

struct FallDetector {
  float    hx[FALL_HIST], hy[FALL_HIST], hz[FALL_HIST];   // accel history, g
  uint16_t hHead, hN;
  bool     triggered, impactTrig, preValid, stillRun, stillNoEvidence;
  uint32_t trigMs, stillSinceMs;
  float    preX, preY, preZ;     // g_pre: mean accel over [trigger - 1.0 s, trigger - 0.2 s]
  float    trigG, peakG;
  bool     ffActive;
  uint32_t ffStartMs, ffDurMs, ffMaxMs;
  float    sx, sy, sz;           // sum of accel over the current still run (g_still)
  uint32_t sN;
  bool     latched, moveRun;
  uint32_t confirmMs, moveSinceMs, lastMoveMs;
  float    lastAngle, lastPeakG; // evidence of the last stillness check (angle -1 = no g_pre)
  uint32_t lastFfMs;

  void reset() {
    hHead = hN = 0;
    triggered = impactTrig = preValid = stillRun = stillNoEvidence = false;
    trigMs = stillSinceMs = 0;
    preX = preY = preZ = trigG = peakG = 0.0f;
    ffActive = false;
    ffStartMs = ffDurMs = ffMaxMs = 0;
    sx = sy = sz = 0.0f;
    sN = 0;
    latched = moveRun = false;
    confirmMs = moveSinceMs = lastMoveMs = 0;
    lastAngle = lastPeakG = 0.0f;
    lastFfMs = 0;
  }

  // Drops a pending trigger (IMU outage or reset); a latched fall stays latched. The movement
  // run restarts too, so the latch clears only after FALL_CLEAR_MS of movement after the gap.
  void cancelTrigger() {
    triggered = false;
    stillRun = false;
    ffActive = false;
    moveRun = false;
    hN = 0;
  }

  static float angleDeg(float ax, float ay, float az, float bx, float by, float bz) {
    const float na = sqrtf(ax * ax + ay * ay + az * az), nb = sqrtf(bx * bx + by * by + bz * bz);
    if (na < 0.1f || nb < 0.1f) return 0.0f;
    float c = (ax * bx + ay * by + az * bz) / (na * nb);
    if (c > 1.0f) c = 1.0f;
    if (c < -1.0f) c = -1.0f;
    return acosf(c) * (180.0f / 3.14159265f);
  }

  // a in m/s², gyroMag in rad/s (bias removed), activityMg from MotionTracker. Returns FALL_EV_* bits.
  uint8_t update(float ax, float ay, float az, float gyroMag, uint16_t activityMg, uint32_t nowMs) {
    const float x = ax / GRAVITY, y = ay / GRAVITY, z = az / GRAVITY;
    const float mag = sqrtf(x * x + y * y + z * z);
    uint8_t ev = 0;

    hx[hHead] = x;                               // newest sample = age 0
    hy[hHead] = y;
    hz[hHead] = z;
    hHead = (uint16_t)((hHead + 1) % FALL_HIST);
    if (hN < FALL_HIST) hN++;

    if (mag < FREEFALL_G) {
      if (!ffActive) {
        ffActive = true;
        ffStartMs = nowMs;
      }
      ffDurMs = nowMs - ffStartMs;
    } else {
      ffActive = false;
      ffDurMs = 0;
    }

    if (latched) {                               // release only after the hold AND sustained movement
      if (activityMg > FALL_CLEAR_MG) {
        if (!moveRun) {
          moveRun = true;
          moveSinceMs = nowMs;
        }
        lastMoveMs = nowMs;
      } else if (moveRun && nowMs - lastMoveMs > FALL_CLEAR_GAP_MS) {
        moveRun = false;                         // stopped moving: the 3 s count starts again
      }
      if (nowMs - confirmMs >= FALL_HOLD_MS && moveRun && lastMoveMs - moveSinceMs >= FALL_CLEAR_MS) {   // pauses don't count as movement
        latched = false;
        moveRun = false;
        ev |= FALL_EV_CLEAR;
      }
    }

    if (!triggered) {
      const bool impact = mag > IMPACT_G;
      const bool freefall = ffActive && ffDurMs >= FREEFALL_MIN_MS;
      if (impact || freefall) {
        triggered = true;
        impactTrig = impact;
        trigMs = nowMs;
        trigG = peakG = mag;
        ffMaxMs = ffDurMs;
        stillRun = stillNoEvidence = false;
        float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f;
        uint16_t c = 0;
        for (uint16_t age = FALL_PRE_SKIP; age < hN; age++) {
          const uint16_t i = (uint16_t)((hHead + FALL_HIST - 1 - age) % FALL_HIST);
          s0 += hx[i];
          s1 += hy[i];
          s2 += hz[i];
          c++;
        }
        preValid = c >= FALL_PRE_MIN;
        if (preValid) {
          preX = s0 / (float)c;
          preY = s1 / (float)c;
          preZ = s2 / (float)c;
        }
        ev |= FALL_EV_TRIGGER;
      }
      return ev;
    }

    if (mag > peakG) peakG = mag;
    if (ffDurMs > ffMaxMs) ffMaxMs = ffDurMs;
    const bool still = fabsf(mag - 1.0f) < STILL_ACCEL_TOL_G && gyroMag < STILL_GYRO_TOL;
    if (!still) {
      stillRun = false;
    } else {
      if (!stillRun) {
        stillRun = true;
        stillSinceMs = nowMs;
        sx = sy = sz = 0.0f;
        sN = 0;
      }
      sx += x;
      sy += y;
      sz += z;
      sN++;
    }
    if (stillRun && nowMs - stillSinceMs >= STILL_MS) {
      lastAngle = preValid ? angleDeg(preX, preY, preZ, sx / (float)sN, sy / (float)sN, sz / (float)sN) : -1.0f;
      lastPeakG = peakG;
      lastFfMs = ffMaxMs;
      const bool orient = preValid && lastAngle >= FALL_ORIENT_DEG;
      const bool strong = peakG >= FALL_STRONG_G;
      const bool longFf = ffMaxMs >= FALL_LONG_FF_MS;
      if (orient || strong || longFf) {
        latched = true;
        confirmMs = nowMs;
        moveRun = false;
        triggered = false;
        ev |= FALL_EV_CONFIRM;
        return ev;
      }
      stillNoEvidence = true;                    // keep watching: the wearer may still settle into a new pose
    }
    if (nowMs - trigMs > CONFIRM_TIMEOUT_MS) {
      triggered = false;
      ev |= stillNoEvidence ? FALL_EV_REJECT : FALL_EV_CANCEL;
    }
    return ev;
  }
};
// <<< HALO_PURE_END fall

// ─── SENSOR OBJECTS AND STATE ─────────────────────────────────────
Adafruit_MPU6050 mpu;
Adafruit_BME280  bme;
MAX30105         particleSensor;
bool hasMPU = false, hasBME = false, hasMAX = false;   // found at boot
bool imuOk = false, bmeOk = false, ppgStalled = false; // working right now
bool bmeFault = false;                                 // a BME280 problem has been logged

PpgPipeline   ppg;
MotionTracker motion;
FallDetector  fall;
BattMonitor   batt;

arm_packet_t pkt;
uint16_t     txSeq = 0;
bool         sendNow = false;
esp_err_t    lastSendErr = ESP_OK;

float imuAx = 0, imuAy = 0, imuAz = 0, imuGx = 0, imuGy = 0, imuGz = 0;   // latest IMU sample
float bmeT = 0, bmeH = 0, bmeP = 0, bmeAlt = 0;                         // latest valid BME280 reading

uint32_t lastImuMs = 0, lastBattMs = 0, lastHealthMs = 0, lastSendMs = 0, lastDiagMs = 0;
bool     haveBattSample = false;
uint32_t lastPpgDataMs = 0, lastPpgReinitMs = 0;
bool     ppgRateRunning = false;
uint32_t ppgRateStartMs = 0, ppgRateCount = 0;
float    ppgFsMeasured = 0.0f;                 // 0 = not measured yet
uint32_t lastPollUs = 0, maxPollGapUs = 0;
bool     pollStarted = false;

static char lineBuf[256];                      // status / diagnostics line (no heap use in loop)

// ─── ESP-NOW CALLBACK ─────────────────────────────────────────────
// Runs in the WiFi task. Plain assignment instead of ++ (C++20 deprecates ++ on volatile).
volatile uint32_t espnowAcked = 0, espnowFailed = 0;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void onDataSent(const esp_now_send_info_t *info, esp_now_send_status_t status) {
  (void)info;
#else
void onDataSent(const uint8_t *mac, esp_now_send_status_t status) {
  (void)mac;
#endif
  if (status == ESP_NOW_SEND_SUCCESS) espnowAcked = espnowAcked + 1;
  else espnowFailed = espnowFailed + 1;
}

// ─── HELPERS ──────────────────────────────────────────────────────
// One register read; false if the device does not answer.
bool i2cReadReg(uint8_t addr, uint8_t reg, uint8_t &val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, (uint8_t)1) != 1) return false;
  val = (uint8_t)Wire.read();
  return true;
}

void configureMpu() {
  mpu.enableSleep(false);
  mpu.setClock(MPU6050_PLL_GYROX);
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);   // fall impacts can exceed 8 g
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);      // keeps short impact peaks
}

void configureBme() {
  bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                  Adafruit_BME280::SAMPLING_X2,    // temperature
                  Adafruit_BME280::SAMPLING_X16,   // pressure
                  Adafruit_BME280::SAMPLING_X1,    // humidity
                  Adafruit_BME280::FILTER_X4,
                  Adafruit_BME280::STANDBY_MS_125);
}

void configurePpg() {
  particleSensor.setup(PPG_LED, PPG_SAMPLE_AVG, PPG_LED_MODE, PPG_SPS, PPG_PULSE_WIDTH, PPG_ADC_RANGE);
}

void setupRadioPowerSave() {
#if ARM_RADIO_POWER_SAVE
  const esp_err_t ePs = esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
  const esp_err_t eWin = esp_now_set_wake_window(ESPNOW_WAKE_WINDOW_MS);
  const esp_err_t eInt = esp_wifi_connectionless_module_set_wake_interval(ESPNOW_WAKE_INTERVAL_MS);
  Serial.printf("Radio power save: esp_wifi_set_ps(MIN_MODEM) %s, esp_now_set_wake_window(%u) %s, "
                "esp_wifi_connectionless_module_set_wake_interval(%u) %s\n",
                esp_err_to_name(ePs), (unsigned)ESPNOW_WAKE_WINDOW_MS, esp_err_to_name(eWin),
                (unsigned)ESPNOW_WAKE_INTERVAL_MS, esp_err_to_name(eInt));
  if (ePs != ESP_OK || eWin != ESP_OK || eInt != ESP_OK) {
    const esp_err_t rWin = esp_now_set_wake_window(ESPNOW_WAKE_WINDOW_DEFAULT);
    const esp_err_t rInt = esp_wifi_connectionless_module_set_wake_interval(ESPNOW_WAKE_INTERVAL_DEFAULT);
    Serial.printf("Radio power save not applied, back to defaults (wake window %s, wake interval %s)\n",
                  esp_err_to_name(rWin), esp_err_to_name(rInt));
  }
#else
  Serial.println("Radio power save off (ARM_RADIO_POWER_SAVE 0)");
#endif
}

// ─── MAX30102: FIFO DRAIN ─────────────────────────────────────────
// The SparkFun ring holds 4 entries, so at 50 Hz this must run at least every ~60 ms.
// check() returns how many samples it read from the sensor; any that did not fit in the
// ring are reported to the pipeline as a gap so its clock stays right.
void pollPPG() {
  const uint32_t us = micros();
  if (pollStarted) {
    const uint32_t gap = us - lastPollUs;
    if (gap > maxPollGapUs) maxPollGapUs = gap;
  }
  lastPollUs = us;
  pollStarted = true;
  if (!hasMAX) return;

  const uint16_t got = particleSensor.check();
  if (got == 0) return;
  const uint32_t now = millis();
  lastPpgDataMs = now;
  if (ppgStalled) {
    ppgStalled = false;
    Serial.println("MAX30102: samples resumed");
  }
  if (!ppgRateRunning) {                         // rate is counted from the next batch on
    ppgRateRunning = true;
    ppgRateStartMs = now;
    ppgRateCount = 0;
  } else {
    ppgRateCount += got;
  }

  const uint8_t avail = particleSensor.available();
  if (got > avail) ppg.skip((uint16_t)(got - avail));
  const uint16_t act = imuOk ? motion.activityMg : 0;
  while (particleSensor.available()) {
    const uint32_t red = particleSensor.getFIFORed();
    const uint32_t ir = particleSensor.getFIFOIR();
    particleSensor.nextSample();
    ppg.push(ir, red, act);
  }
}

void checkPpgHealth(uint32_t now) {
  if (!hasMAX) return;
  if (!ppgStalled && now - lastPpgDataMs > PPG_STALL_MS) {
    ppgStalled = true;
    ppgRateRunning = false;
    ppg.forceNoContact();
    lastPpgReinitMs = now;
    Serial.println("WARNING: MAX30102 sent no samples for 1 s; HR/SpO2 sent as 0 (check wiring)");
  }
  if (ppgStalled && now - lastPpgReinitMs >= PPG_REINIT_MS) {
    lastPpgReinitMs = now;
    if (particleSensor.begin(Wire, I2C_SPEED_FAST)) {
      configurePpg();
      Serial.println("MAX30102: re-initialised");
    } else {
      Serial.println("MAX30102: re-init failed (no answer on I2C)");
    }
  }
  if (ppgRateRunning && lastPpgDataMs - ppgRateStartMs >= PPG_RATE_MIN_MS) {
    const float fs = (float)ppgRateCount * 1000.0f / (float)(lastPpgDataMs - ppgRateStartMs);
    if (ppg.setSampleRate(fs)) {
      ppgFsMeasured = fs;
    } else if (ppgFsMeasured >= 0.0f) {
      ppgFsMeasured = -1.0f;                     // log the mismatch once
      Serial.printf("WARNING: MAX30102 FIFO rate %.2f Hz, expected %d Hz; using the nominal rate\n", fs, PPG_FS);
    }
  }
}

// ─── MPU6050: ACTIVITY, STILLNESS, FALL ───────────────────────────
void handleFallEvents(uint8_t ev) {
  if (ev & FALL_EV_TRIGGER) {
    Serial.printf("FALL: %s %.2f g, checking for stillness\n", fall.impactTrig ? "impact" : "free-fall", fall.trigG);
  }
  char angle[16];
  if (fall.lastAngle >= 0.0f) snprintf(angle, sizeof(angle), "%.0f deg", fall.lastAngle);
  else snprintf(angle, sizeof(angle), "n/a");          // trigger came before 0.4 s of history
  if (ev & FALL_EV_CONFIRM) {
    sendNow = true;
    Serial.printf("FALL CONFIRMED: orientation change %s, peak %.2f g, free-fall %lu ms\n",
                  angle, fall.lastPeakG, (unsigned long)fall.lastFfMs);
  }
  if (ev & FALL_EV_REJECT) {
    Serial.printf("FALL: rejected (still, but orientation change %s < %.0f deg, peak %.2f g < %.1f, "
                  "free-fall %lu ms < %d)\n",
                  angle, FALL_ORIENT_DEG, fall.lastPeakG, FALL_STRONG_G,
                  (unsigned long)fall.lastFfMs, FALL_LONG_FF_MS);
  }
  if (ev & FALL_EV_CANCEL) Serial.println("FALL: cancelled (wearer kept moving)");
  if (ev & FALL_EV_CLEAR) Serial.println("FALL: cleared (moving again after the hold)");
}

void sampleIMU(uint32_t now) {
  if (!imuOk) return;
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  imuAx = a.acceleration.x;
  imuAy = a.acceleration.y;
  imuAz = a.acceleration.z;
  imuGx = g.gyro.x;
  imuGy = g.gyro.y;
  imuGz = g.gyro.z;
  // A reset MPU6050 sleeps and reads exactly 0 on all six axes until checkImuHealth() wakes it; an awake
  // chip never does (zero-g and zero-rate offsets). Fed to the trackers, zeros look like free-fall and
  // movement, so they are skipped.
  if (imuAx == 0.0f && imuAy == 0.0f && imuAz == 0.0f && imuGx == 0.0f && imuGy == 0.0f && imuGz == 0.0f) return;
  motion.update(imuAx, imuAy, imuAz, imuGx, imuGy, imuGz, now);
  const uint8_t ev = fall.update(imuAx, imuAy, imuAz, motion.gyroMag, motion.activityMg, now);
  if (ev) handleFallEvents(ev);
}

// The Adafruit library cannot report a failed read (BusIO returns 0xFFFFFFFF), so the
// chip is checked directly: WHO_AM_I, sleep bit (set after a power-on reset) and range.
void checkImuHealth(uint32_t now) {
  if (!hasMPU) return;
  uint8_t who = 0, pwr = 0, acfg = 0;
  const bool alive = i2cReadReg(MPU_ADDR, 0x75, who) && who == MPU6050_DEVICE_ID &&
                     i2cReadReg(MPU_ADDR, 0x6B, pwr) && i2cReadReg(MPU_ADDR, 0x1C, acfg);
  if (!alive) {
    if (imuOk) {
      imuOk = false;
      imuAx = imuAy = imuAz = imuGx = imuGy = imuGz = 0.0f;
      fall.cancelTrigger();
      Serial.println("WARNING: MPU6050 not answering; fall detection and activity paused");
    }
    return;
  }
  if ((pwr & 0x40) != 0 || ((acfg >> 3) & 0x03) != 0x03) {
    configureMpu();
    fall.cancelTrigger();          // samples since the reset were skipped (sampleIMU): same as an outage
    Serial.println("MPU6050 was reset; settings re-applied");
  }
  if (!imuOk) {
    imuOk = true;
    motion.restart(now);
    Serial.println("MPU6050 answering again");
  }
}

// ─── BME280 ───────────────────────────────────────────────────────
void readBME280() {
  if (!hasBME) return;
  uint8_t id = 0, ctrl = 0;
  if (!i2cReadReg(BME_ADDR, 0xD0, id) || id != 0x60 || !i2cReadReg(BME_ADDR, 0xF4, ctrl)) {
    if (!bmeFault) Serial.println("WARNING: BME280 not answering; temperature/humidity/pressure not sent");
    bmeFault = true;
    bmeOk = false;
    return;
  }
  if ((ctrl & 0x03) != 0x03) {                   // power-on reset leaves it in sleep mode
    configureBme();
    Serial.println("BME280 was reset; settings re-applied");
    bmeOk = false;
    return;
  }
  const float t = bme.readTemperature();
  const float h = bme.readHumidity();
  const float hPa = bme.readPressure() / 100.0f;
  const bool valid = t >= -40.0f && t <= 85.0f && h >= 0.0f && h <= 100.0f && hPa >= 300.0f && hPa <= 1100.0f;
  if (!valid) {                                  // also false for NaN
    if (!bmeFault) Serial.println("WARNING: BME280 reading out of range; not sent");
    bmeFault = true;
    bmeOk = false;
    return;
  }
  if (bmeFault) Serial.println("BME280 readings valid again");
  bmeFault = false;
  bmeT = t;
  bmeH = h;
  bmeP = hPa;
  bmeAlt = 44330.0f * (1.0f - powf(hPa / SEA_LEVEL_HPA, 0.1903f));
  bmeOk = true;
}

// ─── BATTERY ──────────────────────────────────────────────────────
void sampleBattery(float dtS) {
  int32_t mv[BATT_SAMPLES];
  for (int i = 0; i < BATT_SAMPLES; i++) mv[i] = (int32_t)analogReadMilliVolts(BATT_PIN);
  const float battMv = battTrimmedMean(mv, BATT_SAMPLES, BATT_TRIM) * BATT_DIVIDER * BATT_CAL;
  const uint8_t ev = batt.update(battMv, dtS);
  if (ev == BATT_EV_LOST) {
    Serial.printf("battery sense not detected on GPIO%d (check divider); last sample %.0f mV\n", BATT_PIN, battMv);
  } else if (ev == BATT_EV_FOUND) {
    Serial.printf("battery sense OK on GPIO%d: %.2f V %u%%\n", BATT_PIN, batt.emaMv / 1000.0f, (unsigned)batt.pct);
  }
}

// ─── PACKET ───────────────────────────────────────────────────────
void buildPacket() {
  memset(&pkt, 0, sizeof(pkt));
  pkt.magic = ARM_PKT_MAGIC;
  pkt.version = ARM_PKT_VERSION;
  pkt.unit_id = HALO_UNIT_ID;
  pkt.seq = txSeq++;

  // A sensor bit means: found at boot and answering now. A sensor that stops answering is
  // reported like a missing one, so the chest and backend drop its fields instead of using stale values.
  uint8_t sensors = 0;
  if (imuOk) sensors |= ARM_SENS_IMU;
  if (bmeOk) sensors |= ARM_SENS_BME;
  if (hasMAX && !ppgStalled) sensors |= ARM_SENS_PPG;
  if (batt.measured) sensors |= ARM_SENS_BATT;
  pkt.sensors = sensors;

  uint8_t flags = 0;
  if (fall.latched) flags |= ARM_FLAG_FALL;
  if (ppg.skin()) flags |= ARM_FLAG_SKIN;
  if (ppg.motionFlag()) flags |= ARM_FLAG_PPG_MOTION;
  pkt.flags = flags;

  if (imuOk) {
    pkt.accel_x = imuAx;
    pkt.accel_y = imuAy;
    pkt.accel_z = imuAz;
    pkt.gyro_x = imuGx;
    pkt.gyro_y = imuGy;
    pkt.gyro_z = imuGz;
    pkt.activity_mg = motion.activityMg;
    pkt.still_s = motion.stillS;
  }
  if (bmeOk) {
    pkt.temperature = bmeT;
    pkt.humidity = bmeH;
    pkt.pressure = bmeP;
    pkt.altitude = bmeAlt;
  }
  pkt.heartRate = ppg.heartRate();
  pkt.spO2 = ppg.spo2();
  pkt.ppgQuality = ppg.quality();
  pkt.batt_mv = batt.reportMv();
  pkt.batt_pct = batt.reportPct();
  pkt.reserved = 0;
}

// One status line per send, e.g.
// HR:72 SpO2:98 q86 skin | T:29.8C H:54.5% P:913.2hPa | act:35mg still:0s fall:no | BAT 3.91V 72% | ESP-NOW ok fails:0 seq:1234
void printStatus() {
  char bmeStr[48], imuStr[40], batStr[24];
  if (pkt.sensors & ARM_SENS_BME) {
    snprintf(bmeStr, sizeof(bmeStr), "T:%.1fC H:%.1f%% P:%.1fhPa", pkt.temperature, pkt.humidity, pkt.pressure);
  } else {
    snprintf(bmeStr, sizeof(bmeStr), "BME n/a");
  }
  if (pkt.sensors & ARM_SENS_IMU) {
    snprintf(imuStr, sizeof(imuStr), "act:%umg still:%us", (unsigned)pkt.activity_mg, (unsigned)pkt.still_s);
  } else {
    snprintf(imuStr, sizeof(imuStr), "IMU n/a");
  }
  if (pkt.sensors & ARM_SENS_BATT) {
    snprintf(batStr, sizeof(batStr), "BAT %.2fV %u%%", pkt.batt_mv / 1000.0f, (unsigned)pkt.batt_pct);
  } else {
    snprintf(batStr, sizeof(batStr), "BAT n/a");
  }
  const char *contact = !hasMAX ? "no-sensor" : ppgStalled ? "sensor-stalled"
                      : (pkt.flags & ARM_FLAG_SKIN) ? "skin" : "no-skin";
  const int len = snprintf(lineBuf, sizeof(lineBuf),
                           "HR:%d SpO2:%d q%u %s%s | %s | %s fall:%s | %s | ESP-NOW %s fails:%lu seq:%u\n",
                           (int)pkt.heartRate, (int)pkt.spO2, (unsigned)pkt.ppgQuality, contact,
                           (pkt.flags & ARM_FLAG_PPG_MOTION) ? " motion" : "", bmeStr, imuStr,
                           (pkt.flags & ARM_FLAG_FALL) ? "YES" : "no", batStr,
                           lastSendErr == ESP_OK ? "ok" : esp_err_to_name(lastSendErr),
                           (unsigned long)espnowFailed, (unsigned)pkt.seq);
  if (len > 0) Serial.write((const uint8_t *)lineBuf, strnlen(lineBuf, sizeof(lineBuf)));
}

void printDiagnostics() {
  char fsStr[16];
  if (ppgFsMeasured > 0.0f) snprintf(fsStr, sizeof(fsStr), "%.2fHz", ppgFsMeasured);
  else snprintf(fsStr, sizeof(fsStr), "nominal");
  const int len = snprintf(lineBuf, sizeof(lineBuf),
                           "DIAG ppg rate %s lost %lu beats %lu/%lu hr~%.1f spo2~%.1f q~%.0f | max FIFO poll gap %lu ms | "
                           "gyro bias %.3f rad/s, 1g %.3f | ESP-NOW acked %lu failed %lu | heap %lu\n",
                           fsStr, (unsigned long)ppg.lostSamples, (unsigned long)ppg.beatsAccepted,
                           (unsigned long)ppg.beatsSeen, ppg.hrEst, ppg.spEst, ppg.qEst,
                           (unsigned long)(maxPollGapUs / 1000u),
                           sqrtf(motion.bias[0] * motion.bias[0] + motion.bias[1] * motion.bias[1] +
                                 motion.bias[2] * motion.bias[2]),
                           motion.gLevel, (unsigned long)espnowAcked, (unsigned long)espnowFailed,
                           (unsigned long)ESP.getFreeHeap());
  if (len > 0) Serial.write((const uint8_t *)lineBuf, strnlen(lineBuf, sizeof(lineBuf)));
  maxPollGapUs = 0;
}

// ─── SETUP ────────────────────────────────────────────────────────
void setup() {
  const bool cpuSet = setCpuFrequencyMhz(CPU_MHZ);   // first: WiFi needs >= 80 MHz
  Serial.setTxBufferSize(1024);                      // log lines never block the loop
  Serial.begin(115200);
  delay(500);
  Serial.println("=== HALO ARM STRAP STARTING (ESP-NOW packet v2) ===");
  Serial.printf("CPU %lu MHz (setCpuFrequencyMhz(%d) %s)\n", (unsigned long)getCpuFrequencyMhz(), CPU_MHZ,
                cpuSet ? "ok" : "failed");

  Wire.begin(21, 22);
  Wire.setClock(400000);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  // ESP-NOW (restart on failure: nothing works without it)
  if (esp_now_init() != ESP_OK) {
    Serial.println("ERROR: ESP-NOW init failed; restarting");
    delay(2000);
    ESP.restart();
  }
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_now_register_send_cb(onDataSent);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, chestStrapMAC, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;
  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("ERROR: Failed to add peer; restarting");
    delay(2000);
    ESP.restart();
  }
  Serial.printf("ESP-NOW initialized: unit HALO-%02u, %u-byte packet v%u to %02X:%02X:%02X:%02X:%02X:%02X, channel %d\n",
                (unsigned)HALO_UNIT_ID, (unsigned)sizeof(arm_packet_t), (unsigned)ARM_PKT_VERSION,
                chestStrapMAC[0], chestStrapMAC[1], chestStrapMAC[2], chestStrapMAC[3], chestStrapMAC[4],
                chestStrapMAC[5], ESPNOW_CHANNEL);
  setupRadioPowerSave();

  // MPU6050
  hasMPU = mpu.begin(MPU_ADDR, &Wire);
  if (hasMPU) {
    configureMpu();
    Serial.println("MPU6050 OK");
  } else {
    Serial.println("WARNING: MPU6050 not found; fall detection and activity disabled");
  }
  imuOk = hasMPU;

  // BME280
  hasBME = bme.begin(BME_ADDR, &Wire);
  if (hasBME) {
    configureBme();
    Serial.println("BME280 OK");
  } else {
    Serial.println("WARNING: BME280 not found at 0x76");
  }

  // GY-MAX30102
  hasMAX = particleSensor.begin(Wire, I2C_SPEED_FAST);
  if (hasMAX) {
    configurePpg();
    Serial.printf("GY-MAX30102 OK (LED 0x%02X, %d sps / %d-sample average = %d Hz, %d us, %d nA)\n",
                  PPG_LED, PPG_SPS, PPG_SAMPLE_AVG, PPG_FS, PPG_PULSE_WIDTH, PPG_ADC_RANGE);
  } else {
    Serial.println("WARNING: MAX30102 not found; HR/SpO2 disabled");
  }

  analogSetPinAttenuation(BATT_PIN, ADC_11db);       // 0..~3.1 V range; 4.2 V cell = 2.1 V at the pin

  const uint32_t now = millis();
  ppg.init();
  motion.reset(now);
  fall.reset();
  batt.reset();
  lastImuMs = lastHealthMs = lastSendMs = lastDiagMs = now;
  lastBattMs = now - BATT_PERIOD_MS;                 // first battery sample on the first loop pass
  lastPpgDataMs = now;
  Serial.println("=== ARM STRAP READY ===\n");
}

// ─── LOOP ─────────────────────────────────────────────────────────
// Nothing here blocks: the slowest step (BME280 read + status line) takes a few ms,
// and pollPPG() runs before and after each slower call.
void loop() {
  pollPPG();
  const uint32_t now = millis();

  if (now - lastImuMs >= IMU_INTERVAL_MS) {
    lastImuMs += IMU_INTERVAL_MS;
    if (now - lastImuMs >= IMU_INTERVAL_MS) lastImuMs = now;   // fell behind: resync instead of bursting
    sampleIMU(now);
  }

  if (now - lastBattMs >= BATT_PERIOD_MS) {
    const float dtS = haveBattSample ? (float)(now - lastBattMs) / 1000.0f : 0.0f;
    lastBattMs = now;
    haveBattSample = true;
    sampleBattery(dtS);
    pollPPG();
  }

  if (now - lastHealthMs >= HEALTH_INTERVAL_MS) {
    lastHealthMs = now;
    checkImuHealth(now);
    pollPPG();
    checkPpgHealth(millis());      // not `now`: the pollPPG() calls above can stamp lastPpgDataMs later than `now`
  }

  if (sendNow || now - lastSendMs >= SEND_INTERVAL_MS) {
    sendNow = false;
    lastSendMs = now;
    pollPPG();
    readBME280();
    pollPPG();
    buildPacket();
    lastSendErr = esp_now_send(chestStrapMAC, (const uint8_t *)&pkt, sizeof(pkt));
    pollPPG();
    printStatus();
  }

  if (now - lastDiagMs >= DIAG_INTERVAL_MS) {
    lastDiagMs = now;
    printDiagnostics();
  }
}
