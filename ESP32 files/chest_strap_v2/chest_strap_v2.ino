/*
  =============================================
  CHEST STRAP - ESP32 (ESP-NOW receiver + LoRa transmitter)
  Sensors: GPS NEO-6M, MQ7 (CO), MQ135 (air quality), battery sense
  =============================================
  Receives the arm strap packet over ESP-NOW (binary v2, 60 bytes), adds GPS, CO,
  air quality and the chest battery, and sends one binary LoRa packet (v2, 62 bytes,
  about 370 ms on air) to the gateway:
    P0 MAYDAY every 1 s · P1 WARNING every 2 s · P2 NOMINAL every 5 s,
    and at once when the priority escalates (e.g. a fall arrives).
  Keeps sensing and transmitting CO / AQI / GPS / battery when the arm strap is silent
  (the packet then says ARM:0 and the priority is at least P1). Keeps sensing and
  logging while the LoRa radio is down and re-initialises it with backoff; it never
  restarts for radio problems.

  CORE: arduino-esp32 >= 3.0 (ESP-IDF 5.x API). Tested with 3.3.11 and 4.0.0,
        board "ESP32 Dev Module".

  LIBRARIES REQUIRED:
  - TinyGPSPlus 1.0.3 (by Mikal Hart)
  - LoRa 0.8.0 (by Sandeep Mistry)

  POWER:
    3.7 V 2000 mAh Li-ion → TP4056 charger/protection → MT3608 boost set to 5 V → ESP32 5V/VIN.
    The MQ7 and MQ135 heaters run from the same 5 V rail.

  WIRING:
  GPS NEO6M  → ESP32
    VCC      → 3.3V
    GND      → GND
    TX       → GPIO 16 (ESP32 RX2)
    RX       → GPIO 17 (ESP32 TX2)

  MQ7        → ESP32
    VCC      → 5V
    GND      → GND
    AO       → GPIO 34   (see the MQ7 divider note below)

  MQ135      → ESP32
    VCC      → 5V
    GND      → GND
    AO       → GPIO 35   (same 5V → 3.3V concern as MQ7)

  LoRa RA02  → ESP32   (3.3V ONLY — 5V destroys the module)
    VCC      → 3.3V
    GND      → GND
    SCK      → GPIO 18
    MISO     → GPIO 19
    MOSI     → GPIO 23
    NSS/CS   → GPIO 5
    RST      → GPIO 14
    DIO0     → GPIO 4

  BATTERY SENSE (new in Session 4)
    TP4056 OUT+ → 100 kΩ → GPIO 33 → 100 kΩ → GND (ESP32 GND)
    100 nF from GPIO 33 to GND (recommended: gives the ADC a low-impedance source).
    4.2 V reads as 2.1 V at the pin; the divider draws about 21 µA.
    Without the divider the battery is reported as not measured ("BAT chest n/a").
    Load drop: the MQ heaters, WiFi and GPS draw about 0.7-0.8 A from the cell. The cell's internal
    resistance, the TP4056 module's protection FETs (DW01 + 8205) and the wires add up to roughly
    0.1-0.2 ohm, so GPIO 33 sees about 80-150 mV less than the resting voltage. The % table is for
    a resting cell: a 120 mV drop makes a true 55 % read 20 %. Measure it once:
      1. With BATT_LOAD_COMP_MV 0, set BATT_CAL (multimeter on TP4056 OUT+ and ESP32 GND, running).
      2. Run the strap for 10 min and note the "BAT chest" voltage in the status line.
      3. Switch the strap off (unplug the MT3608 input), wait 5 min, measure the cell.
      4. Set BATT_LOAD_COMP_MV to (cell V - noted V) in mV.

  SESSION 4 CHANGES
  - ESP-NOW arm packet v2 (60 bytes): magic / version / unit checks, rejects counted and
    logged, sender MAC printed on first contact and on change, optional ARM_STRAP_MAC pin,
    ESP-NOW loss from sequence gaps.
  - LoRa packet v2: binary, 62 bytes instead of ~190 bytes of text. It carries the arm link
    state, GPS fix age / satellites / HDOP, the CO saturation flag, both batteries and link
    counters. The gateway turns it into one text line for backend.py.
  - Arm strap silent for 4 s → ARM flag cleared and at least P1 (it used to look NOMINAL).
    The last fall state the arm reported is kept while it is silent.
  - GPS: fix age and freshness, 50 m/s jump filter. The last fix is still sent, marked stale.
  - MQ7 / MQ135: trimmed mean + 2 s EMA, ADC saturation flag, CO ceiling logged at boot,
    MQ7_R0 comment corrected.
  - Chest battery on GPIO 33, with an optional load-drop correction (BATT_LOAD_COMP_MV).
  - LoRa: register read-back after init, health check every 2 s, TX watchdog, re-init with
    backoff 1-30 s. TX every 1 / 2 / 5 s (was 2 / 3 / 5 s), radio asleep between packets,
    CPU at 80 MHz.
  - MQ warm-up: for the first 180 s after boot, CO, CO saturation and AQI do not raise the TX
    priority (cold heaters read high). The readings are still sent; the status line shows
    "MQ warm-up 2:31 left".
  - GPSU (LP_FLAG_GPS_UART) needs a GGA/RMC sentence with a valid checksum. Bytes at a wrong
    baud rate or line noise no longer count; the chest logs a baud / wiring hint once.
*/

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_timer.h>
#include <TinyGPSPlus.h>
#include <HardwareSerial.h>
#include <LoRa.h>
#include <SPI.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// >>> HALO_PURE_BEGIN config
// ─── ESP-NOW ──────────────────────────────────────────────────────
#define ESPNOW_CHANNEL 1          // must match the arm strap

// ─── LORA ─────────────────────────────────────────────────────────
#define LORA_SCK  18
#define LORA_MISO 19
#define LORA_MOSI 23
#define LORA_CS   5
#define LORA_RST  14
#define LORA_DIO0 4
#define LORA_FREQ_HZ        433000000L  // radio settings below must match the gateway
#define LORA_SF             9
#define LORA_BW_HZ          125000L
#define LORA_CR_DEN         5           // coding rate 4/5
#define LORA_TX_DBM         17
#define LORA_PREAMBLE       8
#define LORA_CHECK_MS       2000        // register health check interval while not transmitting
#define LORA_TX_WATCHDOG_MS 1500        // a 62-byte packet takes ~370 ms; still in TX after this = radio fault

// ─── TIMING ───────────────────────────────────────────────────────
#define SENSOR_INTERVAL_MS 250    // gas sensors + priority check
#define ARM_TIMEOUT_MS     4000   // arm strap sends every 1 s; silent this long = arm offline
#define TX_P0_MS           1000   // P0 MAYDAY TX interval
#define TX_P1_MS           2000   // P1 WARNING
#define TX_P2_MS           2000   // P2 NOMINAL (2 s so live demos update smoothly; 5000 saves airtime/battery)

// ─── GPS ──────────────────────────────────────────────────────────
#define GPS_RX   16
#define GPS_TX   17
#define GPS_BAUD 9600
#define MAX_HDOP 3.0              // reject fixes with poor satellite geometry
#define MIN_SATS 4
#define GPS_GEOM_MAX_AGE_MS 3000  // HDOP / satellite count must come from a GGA sentence this recent
#define GPS_MAX_SPEED_MPS   50.0  // reject a fix that implies moving faster than this ...
#define GPS_JUMP_RESET_S    60    // ... unless the last accepted fix is older than this
#define GPS_FRESH_S         10    // fix age at or below this = fresh (LP_FLAG_GPS_FRESH)
#define GPS_UART_TIMEOUT_MS 5000  // no GGA/RMC with a valid checksum for this long = no NMEA (LP_FLAG_GPS_UART clear)
#define GPS_GARBAGE_CHARS   1000  // this many characters without a valid GGA/RMC = wrong baud rate or noisy
                                  // RX line (logged once). A NEO-6M at 9600 sends one at least every ~400.

// ─── MQ SENSORS ───────────────────────────────────────────────────
#define MQ7_PIN        34
#define MQ135_PIN      35
#define MQ_SAMPLES     32         // analogReadMilliVolts() readings per sensor every SENSOR_INTERVAL_MS
#define MQ_TRIM        8          // drop the 8 highest and 8 lowest, average the middle 16
#define MQ_TAU_S       2.0f       // EMA time constant on the trimmed-mean voltage
#define MQ_SAT_SAMPLES 8          // raw analogRead() readings for the saturation test
#define MQ_SAT_RAW     4080       // their mean at or above this = ADC saturated (12-bit full scale 4095)
#define MQ_WARMUP_S    180        // for this long after boot, CO, CO saturation and AQI do not raise the TX
                                  // priority (cold heaters read high). The packet does not carry it; 180 s is
                                  // exactly UP 0..2 (uptime_min comes from the same esp_timer clock).

// ─── MQ7 CO CALIBRATION ───────────────────────────────────────────
// Module powered at 5V. AO → GPIO34.
// ⚠️ With no divider, AO can exceed the ESP32's 3.3V limit at high CO.
//    Readings clip at ~3.1V and GPIO34 can be damaged above 3.6V.
//    Fix: 10k (AO→GPIO34) + 20k (GPIO34→GND) divider, then set MQ7_DIVIDER to 1.5.
//    The boot log prints the CO value at the ADC ceiling (above it the packet sets COSAT).
#define MQ7_VC              5.0f    // Module supply voltage (V)
#define MQ7_RL              10.0f   // Load resistor (kΩ). Cancels out in Rs/R0, exact value not critical
#define MQ7_DIVIDER         1.0f    // AO voltage / GPIO34 voltage (1.0 = no divider, 1.5 with 10k/20k)
#define MQ7_R0              10.0f   // R0 (kΩ) = clean-air Rs / MQ7_CLEAN_AIR_RATIO, i.e. the value the
                                    // status line prints as "R0(clean)". It is NOT the clean-air Rs itself
                                    // (entering Rs makes clean air read ~99 ppm). 10.0 is a placeholder.
                                    // CALIBRATE: see mq7_ppm().
#define MQ7_CLEAN_AIR_RATIO 27.5f   // Rs/R0 in clean air (datasheet)
#define MQ7_ADC_MAX_MV      3100    // nominal ADC ceiling at 11 dB attenuation (about 3060-3210 mV per chip)
#define AQ_FULL_SCALE_MV    3100    // MQ135 pin voltage that maps to AQI 500

// ─── PRIORITY THRESHOLDS (mirror backend.py) ──────────────────────
#define CO_WARNING_PPM  35    // NIOSH 8-hr REL
#define CO_CRITICAL_PPM 200   // NIOSH ceiling
#define SPO2_CRITICAL   90
#define SPO2_WARNING    94
#define HR_CRITICAL     170
#define HR_HIGH         150
#define HR_LOW          40
#define HEAT_EXTREME    51.7  // NWS heat index "Extreme Danger" (°C) — BME280 reads ambient air
#define HEAT_DANGER     39.4  // NWS heat index "Danger"
#define STILL_P0_S      60    // no movement this long with skin contact or a fall = P0
#define STILL_P1_S      30    // ... = P1
#define AQI_HAZARDOUS   300   // MQ135 relative index above this = P1

// ─── BATTERY SENSE ────────────────────────────────────────────────
#define BATT_PIN          33
#define BATT_DIVIDER      2.0f    // (R_top + R_bottom) / R_bottom
#define BATT_CAL          1.000f  // trim: multimeter_V / reported_V
#define BATT_LOAD_COMP_MV 0       // chest only: cell voltage drop under the running load (mV), added to every
                                  // reading so the % comes from the resting voltage. Measure once, see the
                                  // BATTERY SENSE notes at the top. 0 = no correction.
#define BATT_SAMPLES      16
#define BATT_TRIM         4       // drop the 4 highest and 4 lowest readings, average the middle 8
#define BATT_PERIOD_MS    1000
#define BATT_TAU_S        30.0f   // EMA time constant
#define BATT_MIN_VALID_MV 2500    // below/above these the sense line is treated as not wired
#define BATT_MAX_VALID_MV 4500
#define BATT_TX_SETTLE_MS 20      // no battery reading during a LoRa TX or this soon after it (TX current sag)
// <<< HALO_PURE_END config

// >>> HALO_PURE_BEGIN arm_payload
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
// <<< HALO_PURE_END arm_payload

// >>> HALO_PURE_BEGIN lora_payload
// ─── LORA PAYLOAD: CHEST → GATEWAY (v2) ── must be byte-identical in chest_strap_v2.ino and gateway.ino ───
#define LORA_PKT_MAGIC   0xA7     // first byte; legacy v1 text packets start with 'I' (0x49)
#define LORA_PKT_VERSION 2

#define LP_FLAG_FALL       0x01   // fall latched (from arm)
#define LP_FLAG_ARM_OK     0x02   // arm packet received within ARM_TIMEOUT_MS
#define LP_FLAG_GPS_FRESH  0x04   // last accepted fix is <= GPS_FRESH_S old
#define LP_FLAG_HAVE_FIX   0x08   // at least one accepted fix since boot (lat/lng meaningful)
#define LP_FLAG_CO_SAT     0x10   // MQ7 ADC saturated: true CO is >= the reported value
#define LP_FLAG_SKIN       0x20   // arm sensor on skin
#define LP_FLAG_PPG_MOTION 0x40   // arm HR/SpO2 suppressed by motion
#define LP_FLAG_GPS_UART   0x80   // NMEA is arriving from the GPS module

typedef struct __attribute__((packed)) {
  uint8_t  magic;          // LORA_PKT_MAGIC
  uint8_t  version;        // LORA_PKT_VERSION
  uint8_t  unit_id;        // 1 = HALO-01
  uint8_t  priority;       // chest-computed 0/1/2 (drives TX rate)
  uint16_t seq;            // chest LoRa packet counter (wraps)
  uint8_t  flags;          // LP_FLAG_*
  uint8_t  arm_sensors;    // ARM_SENS_* from the last arm packet (0 when arm silent)
  int32_t  lat_e7;         // last accepted fix, degrees × 1e7 (0 if never)
  int32_t  lng_e7;
  int16_t  gps_alt_m;      // metres
  uint8_t  gps_sats;       // satellites used, 0 if unknown
  uint8_t  gps_hdop_x10;   // HDOP × 10; 255 = unknown or >= 25.5
  uint16_t gps_age_s;      // seconds since the last accepted fix; 65535 = never
  int16_t  hr;             // arm_packet_t.heartRate (0 when arm silent)
  int8_t   spo2;           // arm_packet_t.spO2
  uint8_t  ppg_quality;
  int16_t  temp_c_x100;    // ambient °C × 100
  uint16_t hum_x100;       // %RH × 100
  uint16_t pres_hpa_x10;   // hPa × 10
  int16_t  balt_m;         // barometric altitude, m
  int16_t  ax_cms2;        // m/s² × 100, latest arm sample
  int16_t  ay_cms2;
  int16_t  az_cms2;
  uint16_t activity_mg;    // mean ENMO over arm packets since the previous LoRa TX
  uint16_t still_s;        // from arm
  uint16_t co_ppm_x10;     // ppm × 10 (0..20000)
  uint16_t co_mv;          // MQ7 pin mV (filtered)
  uint16_t aqi;            // 0..500 relative index (MQ135)
  uint16_t aq_mv;          // MQ135 pin mV (filtered)
  uint16_t vbat_chest_mv;  // 0 = not measured
  uint16_t vbat_arm_mv;    // 0 = not measured or arm silent
  uint8_t  batt_chest_pct; // 255 = unknown
  uint8_t  batt_arm_pct;   // 255 = unknown
  uint8_t  arm_loss_pct;   // ESP-NOW loss over the last ~30 expected arm packets; 255 = unknown
  uint8_t  lora_reinits;   // chest radio re-initialisations since boot (saturates 255)
  uint16_t uptime_min;     // chest uptime in minutes (wraps)
} lora_packet_t;
static_assert(sizeof(lora_packet_t) == 62, "lora_packet_t layout changed: update chest and gateway sketches together");
// <<< HALO_PURE_END lora_payload

// ─── FORWARD DECLARATIONS ─────────────────────────────────────────
// The Arduino IDE inserts generated function prototypes above the first function in this
// file. Declaring the structs here lets those prototypes name structs defined further down.
struct recent_flag;
struct batt_state;
struct mq_filter;
struct gps_track;
struct gps_nmea;
struct arm_loss;
struct lora_fields;
struct lora_regs;
struct lora_link;
struct arm_rx;

// >>> HALO_PURE_BEGIN timing
// ─── TIMING HELPERS ───────────────────────────────────────────────
// "An event happened within the last window_ms". Once expired it stays expired until the next
// event, so a millis() wrap (every 49.7 days) can never make an old event look recent again.
struct recent_flag {
  uint32_t last_ms;
  bool     ever;
  bool     expired;
};

static void recent_mark(recent_flag *r, uint32_t now_ms) {
  r->last_ms = now_ms;
  r->ever    = true;
  r->expired = false;
}

static bool recent_check(recent_flag *r, uint32_t now_ms, uint32_t window_ms) {
  if (!r->ever || r->expired) return false;
  if ((uint32_t)(now_ms - r->last_ms) > window_ms) {
    r->expired = true;
    return false;
  }
  return true;
}

static uint32_t tx_interval_ms(uint8_t pri) {
  return pri == 0 ? TX_P0_MS : pri == 1 ? TX_P1_MS : TX_P2_MS;
}

// A LoRa TX is due when nothing has been sent yet, a send was requested (radio just
// recovered), the priority escalated past the last transmitted one, or the interval for
// the current priority has passed since the last TX.
static bool tx_due(uint8_t pri, uint8_t last_tx_pri, uint32_t last_tx_ms, bool any_tx, bool asap,
                   uint32_t now_ms) {
  if (!any_tx || asap || pri < last_tx_pri) return true;
  return (uint32_t)(now_ms - last_tx_ms) >= tx_interval_ms(pri);
}
// <<< HALO_PURE_END timing

// >>> HALO_PURE_BEGIN battery
// ─── BATTERY: TRIMMED MEAN, PLAUSIBILITY, EMA, STATE OF CHARGE ─────
// Same logic in arm_strap_v2.ino and chest_strap_v2.ino. Feed one cell-voltage reading
// (pin mV × BATT_DIVIDER × BATT_CAL, see batt_trimmed_mean()) every BATT_PERIOD_MS.
#define BATT_BAD_RUN 3            // implausible readings in a row before "not measured"

struct batt_state {
  float    ema_mv;     // filtered cell voltage, mV (valid while seeded)
  float    soc;        // state of charge of ema_mv, % (valid while seeded)
  bool     seeded;     // EMA holds a plausible reading
  bool     missing;    // sense line treated as not wired: report mv 0, pct 255
  uint8_t  bad_run;    // implausible readings in a row
  uint8_t  pct;        // reported %, moves only when soc is >= 1 % away from it (255 = none yet)
  uint32_t last_ms;    // millis() of the last reading fed to the EMA
};

// {mV, %} for a Li-ion cell, highest first. Linear between points, clamped 0..100.
static const float BATT_SOC_TABLE[21][2] = {
  {4200.0f, 100.0f}, {4150.0f, 95.0f}, {4110.0f, 90.0f}, {4080.0f, 85.0f}, {4020.0f, 80.0f},
  {3980.0f,  75.0f}, {3950.0f, 70.0f}, {3910.0f, 65.0f}, {3870.0f, 60.0f}, {3850.0f, 55.0f},
  {3840.0f,  50.0f}, {3820.0f, 45.0f}, {3800.0f, 40.0f}, {3790.0f, 35.0f}, {3770.0f, 30.0f},
  {3750.0f,  25.0f}, {3730.0f, 20.0f}, {3710.0f, 15.0f}, {3690.0f, 10.0f}, {3610.0f,  5.0f},
  {3270.0f,   0.0f}};

static void batt_reset(batt_state *s) {
  memset(s, 0, sizeof(*s));
  s->pct = 255;
}

static float batt_soc_from_mv(float mv) {
  const int n = (int)(sizeof(BATT_SOC_TABLE) / sizeof(BATT_SOC_TABLE[0]));
  if (mv >= BATT_SOC_TABLE[0][0]) return 100.0f;
  if (!(mv > BATT_SOC_TABLE[n - 1][0])) return 0.0f;           // at or below 3.27 V (and NaN)
  for (int i = 1; i < n; i++) {
    if (mv >= BATT_SOC_TABLE[i][0]) {
      float v0 = BATT_SOC_TABLE[i][0],     p0 = BATT_SOC_TABLE[i][1];
      float v1 = BATT_SOC_TABLE[i - 1][0], p1 = BATT_SOC_TABLE[i - 1][1];
      return p0 + (mv - v0) * (p1 - p0) / (v1 - v0);
    }
  }
  return 0.0f;
}

// Mean of v[0..n-1] without its `drop` lowest and `drop` highest values. Sorts v in place.
static float batt_trimmed_mean(int32_t *v, int n, int drop) {
  for (int i = 1; i < n; i++) {                                // insertion sort, n <= 32
    int32_t x = v[i];
    int j = i - 1;
    while (j >= 0 && v[j] > x) {
      v[j + 1] = v[j];
      j--;
    }
    v[j + 1] = x;
  }
  int64_t sum = 0;
  int m = 0;
  for (int i = drop; i < n - drop; i++) {
    sum += v[i];
    m++;
  }
  return m > 0 ? (float)sum / (float)m : 0.0f;
}

// Feeds one cell-voltage reading. Returns 1 when the sense line has just been declared
// missing, -1 when it has just come back, 0 otherwise (the caller logs those once).
static int batt_update(batt_state *s, float cell_mv, uint32_t now_ms) {
  if (!(cell_mv >= BATT_MIN_VALID_MV && cell_mv <= BATT_MAX_VALID_MV)) {   // implausible (or NaN)
    if (s->bad_run < 255) s->bad_run++;
    if (s->bad_run >= BATT_BAD_RUN && !s->missing) {
      s->missing = true;
      s->seeded  = false;                                      // re-seed from the next plausible reading
      s->pct     = 255;
      return 1;
    }
    return 0;
  }
  int event = s->missing ? -1 : 0;
  s->missing = false;
  s->bad_run = 0;
  if (!s->seeded) {
    s->ema_mv = cell_mv;                                       // seed with the first plausible reading
    s->seeded = true;
  } else {
    float dt_s  = (float)(uint32_t)(now_ms - s->last_ms) / 1000.0f;
    float alpha = 1.0f - expf(-dt_s / BATT_TAU_S);
    s->ema_mv  += alpha * (cell_mv - s->ema_mv);
  }
  s->last_ms = now_ms;
  s->soc = batt_soc_from_mv(s->ema_mv);
  if (s->pct > 100 || fabsf(s->soc - (float)s->pct) >= 1.0f) s->pct = (uint8_t)lroundf(s->soc);
  return event;
}

static uint16_t batt_report_mv(const batt_state *s) {   // 0 = not measured
  return s->seeded ? (uint16_t)lroundf(s->ema_mv) : 0;
}

static uint8_t batt_report_pct(const batt_state *s) {   // 255 = unknown
  return s->seeded ? s->pct : 255;
}
// <<< HALO_PURE_END battery

// >>> HALO_PURE_BEGIN mq
// ─── MQ7 / MQ135: FILTER, CO CURVE, AQI, SATURATION ───────────────
struct mq_filter {           // EMA on the trimmed-mean pin voltage
  float    mv;               // filtered pin voltage, mV
  bool     seeded;
  uint32_t last_ms;
};

static void mq_filter_update(mq_filter *f, float sample_mv, uint32_t now_ms) {
  if (!f->seeded) {
    f->mv     = sample_mv;
    f->seeded = true;
  } else {
    float dt_s = (float)(uint32_t)(now_ms - f->last_ms) / 1000.0f;
    f->mv += (1.0f - expf(-dt_s / MQ_TAU_S)) * (sample_mv - f->mv);
  }
  f->last_ms = now_ms;
}

// MQ7 sensor resistance Rs (kΩ) from the GPIO34 voltage: Rs = RL × (Vc − Vout) / Vout.
static float mq7_rs_kohm(float pin_mv) {
  float vout = pin_mv / 1000.0f * MQ7_DIVIDER;                // AO voltage
  if (!(vout >= 0.01f)) vout = 0.01f;                         // avoid divide-by-zero / negative Rs
  if (vout > MQ7_VC - 0.01f) vout = MQ7_VC - 0.01f;
  return MQ7_RL * (MQ7_VC - vout) / vout;
}

// CO ppm from the GPIO34 voltage via the datasheet curve ppm = 99.042 × (Rs/R0)^-1.518,
// clamped to 0..2000 ppm (datasheet range 20-2000 ppm).
// To calibrate R0: warm the sensor up for 5+ min in clean outdoor air, read "R0(clean)"
// (= Rs / 27.5) from the status line, and put that value into MQ7_R0.
static float mq7_ppm(float pin_mv) {
  float ppm = 99.042f * powf(mq7_rs_kohm(pin_mv) / MQ7_R0, -1.518f);
  if (!(ppm >= 0.0f)) return 0.0f;
  return ppm > 2000.0f ? 2000.0f : ppm;
}

// Relative air-quality index 0..500 (MQ135), linear in the calibrated pin voltage:
// round(mv × 500 / AQ_FULL_SCALE_MV), clamped. Not a calibrated AQI.
static uint16_t mq135_aqi(uint16_t pin_mv) {
  uint32_t a = ((uint32_t)pin_mv * 500u + AQ_FULL_SCALE_MV / 2) / AQ_FULL_SCALE_MV;
  return (uint16_t)(a > 500u ? 500u : a);
}

// True when the mean of n raw ADC counts is >= MQ_SAT_RAW.
static bool mq_saturated(const int32_t *raw, int n) {
  int64_t sum = 0;
  for (int i = 0; i < n; i++) sum += raw[i];
  return n > 0 && sum >= (int64_t)MQ_SAT_RAW * n;
}
// <<< HALO_PURE_END mq

// >>> HALO_PURE_BEGIN gps
// ─── GPS: FIX ACCEPTANCE, JUMP FILTER, AGE ────────────────────────
// A wrong accepted fix can block correct ones for up to GPS_JUMP_RESET_S; the packet marks the
// position stale (GPS:0) once it is older than GPS_FRESH_S, so it is never shown as current.
struct gps_track {
  bool     have_fix;      // at least one fix accepted since boot
  bool     age_pinned;    // last fix >= 65534 s old: age stays pinned (millis() wraps at 49.7 days)
  double   lat, lng;      // last accepted fix, degrees
  double   alt_m;         // altitude of the last fix that had one
  uint32_t fix_ms;        // millis() when the last fix was accepted
  uint32_t rej_geometry;  // fixes rejected for HDOP / satellite count / range
  uint32_t rej_jump;      // fixes rejected by the speed filter
};

// Great-circle distance in metres (haversine, mean Earth radius 6371 km).
static double gps_distance_m(double lat1, double lng1, double lat2, double lng2) {
  const double d2r = 3.14159265358979323846 / 180.0;
  double dlat = (lat2 - lat1) * d2r;
  double dlng = (lng2 - lng1) * d2r;
  double a = sin(dlat / 2) * sin(dlat / 2) +
             cos(lat1 * d2r) * cos(lat2 * d2r) * sin(dlng / 2) * sin(dlng / 2);
  if (a > 1.0) a = 1.0;
  return 2.0 * 6371000.0 * asin(sqrt(a));
}

// Offers a new fix. hdop < 0 = unknown, sats = 0 = unknown.
// Returns 0 accepted, 1 rejected (geometry or range), 2 rejected (implies > GPS_MAX_SPEED_MPS).
static int gps_offer_fix(gps_track *t, double lat, double lng, bool alt_valid, double alt_m,
                         double hdop, uint32_t sats, uint32_t now_ms) {
  bool geometry_ok = hdop >= 0.0 && hdop <= MAX_HDOP && sats >= MIN_SATS &&
                     lat >= -90.0 && lat <= 90.0 && lng >= -180.0 && lng <= 180.0;
  if (!geometry_ok) {
    t->rej_geometry++;
    return 1;
  }
  if (t->have_fix && !t->age_pinned) {
    uint32_t dt_ms = now_ms - t->fix_ms;
    if (dt_ms <= (uint32_t)GPS_JUMP_RESET_S * 1000u) {          // older fixes are not compared
      double dt_s = dt_ms < 1000u ? 1.0 : dt_ms / 1000.0;      // NMEA fixes arrive at 1 Hz
      if (gps_distance_m(t->lat, t->lng, lat, lng) > GPS_MAX_SPEED_MPS * dt_s) {
        t->rej_jump++;
        return 2;
      }
    }
  }
  t->have_fix   = true;
  t->age_pinned = false;
  t->lat        = lat;
  t->lng        = lng;
  if (alt_valid) t->alt_m = alt_m;
  t->fix_ms     = now_ms;
  return 0;
}

// Seconds since the last accepted fix; 65535 = never, pinned at 65534 once that old.
static uint16_t gps_age_s(gps_track *t, uint32_t now_ms) {
  if (!t->have_fix) return 65535;
  if (!t->age_pinned) {
    uint32_t age = (uint32_t)(now_ms - t->fix_ms) / 1000u;
    if (age < 65534u) return (uint16_t)age;
    t->age_pinned = true;
  }
  return 65534;
}

// HDOP × 10 from TinyGPSPlus hundredths, rounded; 255 = unknown or >= 25.5.
static uint8_t gps_hdop_x10(bool valid, int32_t hdop_x100) {
  if (!valid || hdop_x100 < 0) return 255;
  int32_t x10 = (hdop_x100 + 5) / 10;
  return x10 >= 255 ? 255 : (uint8_t)x10;
}

// NMEA health for LP_FLAG_GPS_UART. Only GGA / RMC sentences with a valid checksum count: a NEO-6M
// saved at another baud rate, or a noisy RX line, still delivers bytes, but they never parse.
struct gps_nmea {
  uint32_t chars_at_good;   // TinyGPSPlus charsProcessed() at the last valid GGA / RMC
  bool     garbage_logged;  // the "bytes but no valid NMEA" hint was logged since then
};

// good: a valid GGA / RMC arrived since the last call. chars: charsProcessed() (may wrap).
// Returns 1 on a valid sentence (mark GPSU), 2 when GPS_GARBAGE_CHARS characters have arrived
// without one (log the hint; once until the next valid sentence), 0 otherwise.
static int gps_nmea_update(gps_nmea *g, bool good, uint32_t chars) {
  if (good) {
    g->chars_at_good  = chars;
    g->garbage_logged = false;
    return 1;
  }
  if (!g->garbage_logged && (uint32_t)(chars - g->chars_at_good) >= GPS_GARBAGE_CHARS) {
    g->garbage_logged = true;
    return 2;
  }
  return 0;
}
// <<< HALO_PURE_END gps

// >>> HALO_PURE_BEGIN armloss
// ─── ESP-NOW LOSS FROM ARM SEQUENCE NUMBERS ───────────────────────
// Sliding window over the last ARM_LOSS_WINDOW expected arm packets. seq is uint16 and wraps.
// A backwards jump (arm reboot) or a forward jump larger than the arm could have sent in the
// elapsed time (arm rebooted at a lower seq) restarts the window.
#define ARM_LOSS_WINDOW  30       // expected packets in the window (~30 s at 1 Hz)
#define ARM_LOSS_MAX_PPS 2        // the arm sends 1/s plus an immediate send on a confirmed fall
#define ARM_LOSS_SLACK   5        // extra packets allowed on top of that
static_assert(ARM_LOSS_WINDOW <= 31, "the loss window is a 32-bit mask");

struct arm_loss {
  bool     started;
  uint16_t last_seq;
  uint32_t last_ms;       // millis() of the last in-order packet
  uint32_t bits;          // 1 = received, newest in bit 0
  uint8_t  count;         // expected packets in the window so far (<= ARM_LOSS_WINDOW)
  uint32_t restarts;      // window restarts after the first packet (arm reboot or impossible jump)
  uint32_t duplicates;
};

static void arm_loss_restart(arm_loss *w, uint16_t seq, uint32_t now_ms) {
  w->started  = true;
  w->last_seq = seq;
  w->last_ms  = now_ms;
  w->bits     = 1u;
  w->count    = 1;
}

static void arm_loss_push(arm_loss *w, bool received) {
  w->bits = ((w->bits << 1) | (received ? 1u : 0u)) & ((1u << ARM_LOSS_WINDOW) - 1u);
  if (w->count < ARM_LOSS_WINDOW) w->count++;
}

// Returns 0 in order (gap counted as lost), 1 duplicate (ignored), 2 window restarted.
static int arm_loss_update(arm_loss *w, uint16_t seq, uint32_t now_ms) {
  if (!w->started) {
    arm_loss_restart(w, seq, now_ms);
    return 2;
  }
  uint32_t d = (uint16_t)(seq - w->last_seq);                 // forward distance, mod 65536
  if (d == 0) {
    w->duplicates++;
    return 1;
  }
  uint32_t possible = (uint32_t)(now_ms - w->last_ms) / 1000u * ARM_LOSS_MAX_PPS + ARM_LOSS_SLACK;
  if (d >= 0x8000u || d > possible) {
    w->restarts++;
    arm_loss_restart(w, seq, now_ms);
    return 2;
  }
  for (uint32_t i = 1; i < d && i <= ARM_LOSS_WINDOW; i++) arm_loss_push(w, false);
  arm_loss_push(w, true);
  w->last_seq = seq;
  w->last_ms  = now_ms;
  return 0;
}

// Rounded loss % over the window; 255 = unknown (no packet yet).
static uint8_t arm_loss_pct(const arm_loss *w) {
  if (!w->started || w->count == 0) return 255;
  uint32_t b = w->bits & ((1u << w->count) - 1u);
  int got = 0;
  for (; b != 0; b &= b - 1u) got++;
  int lost = (int)w->count - got;
  return (uint8_t)((lost * 200 + (int)w->count) / (2 * (int)w->count));
}
// <<< HALO_PURE_END armloss

// >>> HALO_PURE_BEGIN priority
// ─── PRIORITY (TX rate only; mirrors backend.py) ──────────────────
// Python round(x, 1): the correctly rounded 1-decimal string, read back (ties to even).
static double halo_round1(double x) {
  char s[40];
  snprintf(s, sizeof(s), "%.1f", x);
  return strtod(s, NULL);
}

// NWS heat index (°C) from ambient temperature and humidity. Same formula, operation order
// and 0.1 °C rounding as backend.py compute_heat_index(); never below the air temperature.
static double heatIndexC(double tC, double rh) {
  if (!(rh > 0)) return halo_round1(tC);
  double t  = tC * 9 / 5 + 32;
  double hi = 0.5 * (t + 61.0 + (t - 68.0) * 1.2 + rh * 0.094);
  if ((hi + t) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
         - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
         + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
    if (rh < 13 && 80 <= t && t <= 112)      hi -= ((13 - rh) / 4) * sqrt((17 - fabs(t - 95)) / 17);
    else if (rh > 85 && 80 <= t && t <= 87)  hi += ((rh - 85) / 10) * ((87 - t) / 5);
  }
  double c = (hi - 32) * 5 / 9;
  return halo_round1(c >= tC ? c : tC);
}

// Seconds of MQ heater warm-up left (0 = warm), from the time since boot in ms (64-bit: no wrap).
static uint32_t mq_warmup_left_s(uint64_t uptime_ms) {
  uint64_t done_s = uptime_ms / 1000u;
  return done_s >= (uint64_t)MQ_WARMUP_S ? 0u : (uint32_t)((uint64_t)MQ_WARMUP_S - done_s);
}

// Priority of the packet about to be sent, computed from the packet's own (rounded) values so
// it matches what the backend will see. "Valid" HR/SpO2 means > 0 (-1 calibrating, 0 no signal).
// mq_warming (mq_warmup_left_s() > 0): CO, CO saturation and AQI are left out, because cold MQ7 /
// MQ135 heaters read falsely high. The packet still carries the readings.
// Backend-only rules (15-min CO TWA, estimated core temperature) are not evaluated here.
static uint8_t lora_priority(const lora_packet_t *p, float co_ceiling_ppm, bool mq_warming) {
  bool arm  = (p->flags & LP_FLAG_ARM_OK) != 0;
  bool fall = (p->flags & LP_FLAG_FALL) != 0;
  bool skin = (p->flags & LP_FLAG_SKIN) != 0;
  bool sat  = !mq_warming && (p->flags & LP_FLAG_CO_SAT) != 0;
  double co = mq_warming ? 0.0 : p->co_ppm_x10 / 10.0;
  int  aq   = mq_warming ? 0 : p->aqi;
  int  hr   = arm ? p->hr : 0;
  int  spo2 = arm ? p->spo2 : 0;
  long still = arm ? (long)p->still_s : 0;
  bool bme  = arm && (p->arm_sensors & ARM_SENS_BME) != 0;
  double heat = bme ? heatIndexC(p->temp_c_x100 / 100.0, p->hum_x100 / 100.0) : 0.0;

  if (fall || co > CO_CRITICAL_PPM ||
      (sat && (co >= CO_CRITICAL_PPM || co_ceiling_ppm >= CO_CRITICAL_PPM)) ||
      (spo2 > 0 && spo2 < SPO2_CRITICAL) ||
      hr > HR_CRITICAL ||
      (bme && heat >= HEAT_EXTREME) ||
      (still >= STILL_P0_S && (skin || fall)))
    return 0;

  if (co > CO_WARNING_PPM || sat ||
      (spo2 > 0 && spo2 < SPO2_WARNING) ||
      hr > HR_HIGH || (hr > 0 && hr < HR_LOW) ||
      (bme && heat >= HEAT_DANGER) ||
      (still >= STILL_P1_S && (skin || fall)) ||
      !arm ||
      aq > AQI_HAZARDOUS)
    return 1;

  return 2;
}
// <<< HALO_PURE_END priority

// >>> HALO_PURE_BEGIN lora_encode
// ─── LORA PACKET ENCODE ───────────────────────────────────────────
// Chest state in physical units. lora_encode() rounds (lround) and clamps every value to its
// packet field, and applies the "arm silent" rules (arm fields 0, arm_sensors 0, vbat_arm 0,
// batt_arm 255, arm_loss 255).
struct lora_fields {
  uint8_t  unit_id;
  uint16_t seq;
  bool     arm_ok;            // arm packet within ARM_TIMEOUT_MS
  bool     fall;              // last fall state the arm reported (kept while it is silent)
  bool     skin, ppg_motion;  // ARM_FLAG_* from the last arm packet
  bool     have_fix, gps_fresh, gps_uart;
  bool     co_sat;
  uint8_t  arm_sensors;       // ARM_SENS_* from the last arm packet
  double   lat, lng;          // last accepted fix, degrees
  double   gps_alt_m;
  uint32_t gps_sats;          // 0 = unknown
  uint8_t  gps_hdop_x10;      // 255 = unknown or >= 25.5
  uint16_t gps_age_s;         // 65535 = never
  int32_t  hr, spo2, ppg_quality;
  float    temp_c, hum_pct, pres_hpa, balt_m;
  float    ax, ay, az;        // m/s²
  float    activity_mg;
  uint32_t still_s;
  float    co_ppm, co_mv, aq_mv;
  uint16_t aqi;
  float    vbat_chest_mv, vbat_arm_mv;   // 0 = not measured
  uint8_t  batt_chest_pct, batt_arm_pct; // 255 = unknown
  uint8_t  arm_loss_pct;                 // 255 = unknown
  uint32_t lora_reinits;
  uint32_t uptime_min;
};

// round(x × scale) clamped to [lo, hi]; NaN → 0 (lo/hi always bracket 0 here).
static int32_t lp_q(double x, double scale, int32_t lo, int32_t hi) {
  double v = x * scale;
  if (v != v) return 0;
  if (v <= (double)lo) return lo;
  if (v >= (double)hi) return hi;
  return (int32_t)lround(v);
}

static int32_t lp_clamp(int32_t v, int32_t lo, int32_t hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static bool lp_finite(float x) {
  return x == x && x - x == 0.0f;   // false for NaN and ±Inf
}

static void lora_encode(const lora_fields *f, lora_packet_t *p) {
  memset(p, 0, sizeof(*p));
  p->magic    = LORA_PKT_MAGIC;
  p->version  = LORA_PKT_VERSION;
  p->unit_id  = f->unit_id;
  p->priority = 2;                    // set by the caller from lora_priority()
  p->seq      = f->seq;

  uint8_t fl = 0;
  if (f->fall)                   fl |= LP_FLAG_FALL;
  if (f->arm_ok)                 fl |= LP_FLAG_ARM_OK;
  if (f->have_fix && f->gps_fresh) fl |= LP_FLAG_GPS_FRESH;
  if (f->have_fix)               fl |= LP_FLAG_HAVE_FIX;
  if (f->co_sat)                 fl |= LP_FLAG_CO_SAT;
  if (f->arm_ok && f->skin)      fl |= LP_FLAG_SKIN;
  if (f->arm_ok && f->ppg_motion) fl |= LP_FLAG_PPG_MOTION;
  if (f->gps_uart)               fl |= LP_FLAG_GPS_UART;
  p->flags = fl;

  if (f->have_fix) {
    p->lat_e7    = lp_q(f->lat, 1e7, -900000000, 900000000);
    p->lng_e7    = lp_q(f->lng, 1e7, -1800000000, 1800000000);
    p->gps_alt_m = (int16_t)lp_q(f->gps_alt_m, 1.0, -32768, 32767);
    p->gps_age_s = f->gps_age_s;
  } else {
    p->gps_age_s = 65535;
  }
  p->gps_sats     = (uint8_t)(f->gps_sats > 255u ? 255u : f->gps_sats);
  p->gps_hdop_x10 = f->gps_hdop_x10;

  p->batt_arm_pct = 255;
  p->arm_loss_pct = 255;
  if (f->arm_ok) {
    uint8_t s = f->arm_sensors;
    if (!lp_finite(f->temp_c) || !lp_finite(f->hum_pct) || !lp_finite(f->pres_hpa) || !lp_finite(f->balt_m))
      s &= (uint8_t)~ARM_SENS_BME;    // a NaN reading is "no BME data", not 0 °C
    if (!lp_finite(f->ax) || !lp_finite(f->ay) || !lp_finite(f->az))
      s &= (uint8_t)~ARM_SENS_IMU;
    p->arm_sensors = s;
    p->hr          = (int16_t)lp_clamp(f->hr, -32768, 32767);
    p->spo2        = (int8_t)lp_clamp(f->spo2, -128, 127);
    p->ppg_quality = (uint8_t)lp_clamp(f->ppg_quality, 0, 255);
    if (s & ARM_SENS_BME) {
      p->temp_c_x100  = (int16_t)lp_q(f->temp_c, 100.0, -32768, 32767);
      p->hum_x100     = (uint16_t)lp_q(f->hum_pct, 100.0, 0, 65535);
      p->pres_hpa_x10 = (uint16_t)lp_q(f->pres_hpa, 10.0, 0, 65535);
      p->balt_m       = (int16_t)lp_q(f->balt_m, 1.0, -32768, 32767);
    }
    if (s & ARM_SENS_IMU) {
      p->ax_cms2 = (int16_t)lp_q(f->ax, 100.0, -32768, 32767);
      p->ay_cms2 = (int16_t)lp_q(f->ay, 100.0, -32768, 32767);
      p->az_cms2 = (int16_t)lp_q(f->az, 100.0, -32768, 32767);
    }
    p->activity_mg  = (uint16_t)lp_q(f->activity_mg, 1.0, 0, 65535);
    p->still_s      = (uint16_t)(f->still_s > 65535u ? 65535u : f->still_s);
    p->vbat_arm_mv  = (uint16_t)lp_q(f->vbat_arm_mv, 1.0, 0, 65535);
    p->batt_arm_pct = f->batt_arm_pct <= 100 ? f->batt_arm_pct : 255;
    p->arm_loss_pct = f->arm_loss_pct <= 100 ? f->arm_loss_pct : 255;
  }

  p->co_ppm_x10     = (uint16_t)lp_q(f->co_ppm, 10.0, 0, 20000);
  p->co_mv          = (uint16_t)lp_q(f->co_mv, 1.0, 0, 65535);
  p->aqi            = f->aqi > 500 ? 500 : f->aqi;
  p->aq_mv          = (uint16_t)lp_q(f->aq_mv, 1.0, 0, 65535);
  p->vbat_chest_mv  = (uint16_t)lp_q(f->vbat_chest_mv, 1.0, 0, 65535);
  p->batt_chest_pct = f->batt_chest_pct <= 100 ? f->batt_chest_pct : 255;
  p->lora_reinits   = (uint8_t)(f->lora_reinits > 255u ? 255u : f->lora_reinits);
  p->uptime_min     = (uint16_t)(f->uptime_min & 0xFFFFu);
}
// <<< HALO_PURE_END lora_encode

// >>> HALO_PURE_BEGIN lora_link
// ─── LORA RADIO CHECKS + RECONNECT BACKOFF (same code in chest_strap_v2.ino and gateway.ino) ───
#define LORA_REG_OP_MODE        0x01
#define LORA_REG_FRF_MSB        0x06
#define LORA_REG_FRF_MID        0x07
#define LORA_REG_FRF_LSB        0x08
#define LORA_REG_MODEM_CONFIG_1 0x1D
#define LORA_REG_MODEM_CONFIG_2 0x1E
#define LORA_REG_VERSION        0x42
#define LORA_EXPECT_VERSION     0x12    // SX1276/77/78 silicon version
#define LORA_EXPECT_FRF         ((uint32_t)(((uint64_t)LORA_FREQ_HZ << 19) / 32000000ULL))  // 0x6C4000 at 433 MHz
#define LORA_EXPECT_MC1         0x72    // BW 125 kHz (0x70) | CR 4/5 (0x02) | explicit header (bit0 = 0)
#define LORA_BACKOFF_MAX_MS     30000

struct lora_regs {
  uint8_t version, op_mode, frf_msb, frf_mid, frf_lsb, mc1, mc2;
};

// True when the SX1278 still holds our configuration. Otherwise writes the first mismatch into
// why. A module reset or brown-out leaves it in FSK mode at 434 MHz (FRF 0x6C8000); a loose
// SPI wire reads 0x00 or 0xFF.
static bool lora_regs_ok(const lora_regs *r, char *why, size_t why_len) {
  uint32_t frf = ((uint32_t)r->frf_msb << 16) | ((uint32_t)r->frf_mid << 8) | r->frf_lsb;
  if (r->version != LORA_EXPECT_VERSION) {
    snprintf(why, why_len, "REG_VERSION 0x%02X, expected 0x%02X%s", (unsigned)r->version,
             (unsigned)LORA_EXPECT_VERSION,
             (r->version == 0x00 || r->version == 0xFF) ? " (no SPI answer: check wiring and 3.3V)" : "");
    return false;
  }
  if ((r->op_mode & 0x80) == 0) {
    snprintf(why, why_len, "REG_OP_MODE 0x%02X: not in LoRa mode (module reset or brown-out)",
             (unsigned)r->op_mode);
    return false;
  }
  if (frf != LORA_EXPECT_FRF) {
    snprintf(why, why_len, "REG_FRF 0x%06lX, expected 0x%06lX", (unsigned long)frf,
             (unsigned long)LORA_EXPECT_FRF);
    return false;
  }
  if (r->mc1 != LORA_EXPECT_MC1) {
    snprintf(why, why_len, "REG_MODEM_CONFIG_1 0x%02X, expected 0x%02X (BW125, CR4/5, explicit header)",
             (unsigned)r->mc1, (unsigned)LORA_EXPECT_MC1);
    return false;
  }
  if ((r->mc2 >> 4) != LORA_SF || (r->mc2 & 0x04) == 0) {
    snprintf(why, why_len, "REG_MODEM_CONFIG_2 0x%02X, expected SF%d with CRC on", (unsigned)r->mc2,
             LORA_SF);
    return false;
  }
  if (why_len > 0) why[0] = '\0';
  return true;
}

// Wait before re-init attempt number failures+1: 1, 2, 4, 8, 16, then 30 s.
static uint32_t lora_backoff_ms(uint32_t failures) {
  static const uint32_t steps[5] = {1000, 2000, 4000, 8000, 16000};
  return failures < 5 ? steps[failures] : LORA_BACKOFF_MAX_MS;
}

struct lora_link {
  bool     up;             // radio verified and in use
  uint32_t failures;       // failed re-inits since the radio went down
  uint32_t wait_start_ms;  // start of the current backoff wait
  uint32_t wait_ms;        // length of the current backoff wait
  uint32_t reinits;        // re-init attempts since boot (the boot init is not counted)
  uint32_t down_since_ms;  // when the radio went down
};

static void lora_link_down(lora_link *l, uint32_t now_ms) {
  l->up            = false;
  l->failures      = 0;
  l->wait_start_ms = now_ms;
  l->wait_ms       = lora_backoff_ms(0);
  l->down_since_ms = now_ms;
}

static bool lora_link_retry_due(const lora_link *l, uint32_t now_ms) {
  return !l->up && (uint32_t)(now_ms - l->wait_start_ms) >= l->wait_ms;
}

// Records the result of a re-init attempt (backoff retry, or a soft re-init while up).
static void lora_link_result(lora_link *l, bool ok, uint32_t now_ms) {
  if (l->reinits < 0xFFFFFFFFu) l->reinits++;
  if (ok) {
    l->up       = true;
    l->failures = 0;
    return;
  }
  if (l->up) {                     // a soft re-init failed: start the backoff from the beginning
    lora_link_down(l, now_ms);
    return;
  }
  if (l->failures < 1000u) l->failures++;
  l->wait_start_ms = now_ms;
  l->wait_ms       = lora_backoff_ms(l->failures);
}
// <<< HALO_PURE_END lora_link

// >>> HALO_PURE_BEGIN lora_tx
// ─── LORA TX HELPERS (chest only) ─────────────────────────────────
// TX watchdog: true when REG_OP_MODE still says TX more than LORA_TX_WATCHDOG_MS after start.
static bool lora_tx_stuck(uint8_t op_mode, uint32_t tx_start_ms, uint32_t now_ms) {
  return (op_mode & 0x07) == 0x03 && (uint32_t)(now_ms - tx_start_ms) > LORA_TX_WATCHDOG_MS;
}

// Time on air (ms) of an explicit-header packet with CRC (Semtech SX1276/77/78 datasheet 4.1.1.7).
static double lora_airtime_ms(int payload_len, int sf, double bw_hz, int cr_den, int preamble) {
  double tsym = (double)(1L << sf) / bw_hz * 1000.0;
  int    de   = tsym > 16.0 ? 1 : 0;                  // low data rate optimisation, as the library sets it
  double n    = ceil((8.0 * payload_len - 4.0 * sf + 28.0 + 16.0) / (4.0 * (sf - 2 * de)));
  if (n < 0) n = 0;
  return (preamble + 4.25) * tsym + (8.0 + n * cr_den) * tsym;
}
// <<< HALO_PURE_END lora_tx

// ─── ESP-NOW RECEIVE STATE ────────────────────────────────────────
// Optional sender pin: the arm strap's STA MAC. All zero = accept any sender that passes the
// packet checks (magic, version, unit id). Pin it when more than one HALO unit is in range.
static const uint8_t ARM_STRAP_MAC[6] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

#define REJ_LEN     0
#define REJ_MAGIC   1
#define REJ_VERSION 2
#define REJ_UNIT    3
#define REJ_SENDER  4
#define REJ_COUNT   5

struct arm_rx {
  arm_packet_t pkt;                 // last accepted packet
  uint32_t     last_ms;             // millis() when it arrived
  uint32_t     accepted;            // accepted packets since boot
  uint32_t     rejected[REJ_COUNT]; // rejected frames by reason
  int          bad_len;             // details of the last rejected frame
  uint8_t      bad_version, bad_unit;
  uint8_t      bad_mac[6];
  uint8_t      mac[6];              // sender of the last accepted packet
  int8_t       rssi;                // its RSSI (dBm)
  uint64_t     act_sum;             // activity_mg sum since the last LoRa TX (64-bit: no overflow while the radio is down)
  uint32_t     act_n;               // arm packets in that sum
  arm_loss     loss;
};

// Written by the ESP-NOW callback (WiFi task), read by loop(); guarded by armMux.
static arm_rx       armRx;
static portMUX_TYPE armMux    = portMUX_INITIALIZER_UNLOCKED;
static bool         armMacPin = false;     // ARM_STRAP_MAC is non-zero

// ─── SENSOR OBJECTS / STATE ───────────────────────────────────────
TinyGPSPlus    gps;
HardwareSerial gpsSerial(2);
static gps_track   gpsTrack;
static recent_flag gpsUart;                // valid GGA / RMC sentences arriving
static gps_nmea    gpsNmea;                // characters since the last valid one

static mq_filter mq7Filt, mq135Filt;
static float     coPpm = 0.0f, coRs = 0.0f, coCeilingPpm = 0.0f;
static uint16_t  coMv = 0, aqMv = 0, aqi = 0;
static bool      coSat = false;
static uint32_t  mqWarmupLeftS = MQ_WARMUP_S;   // MQ heater warm-up left at the latest buildPacket()

static batt_state chestBatt;
static uint32_t   battLastMs = 0;

// ─── LINK / TX STATE ──────────────────────────────────────────────
static lora_link   radio;                  // up/down state machine + backoff
static bool        radioTx      = false;   // a packet is on air
static uint32_t    txStartMs    = 0;
static uint32_t    txEndMs      = 0;
static uint32_t    lastCheckMs  = 0;
static char        radioWhy[112];          // reason of the last failed check / init

static recent_flag armRecent;              // arm packet within ARM_TIMEOUT_MS
static uint32_t    seenAccepted = 0;
static bool        armWasOk     = false;
static bool        macShown     = false;
static uint8_t     macShownAddr[6];

static uint8_t     curPri       = 2;       // priority of the latest packet built
static bool        priDirty     = true;
static uint16_t    txSeq        = 0;       // next LoRa seq
static uint8_t     lastTxPri    = 2;
static uint32_t    lastTxMs     = 0;
static bool        anyTx        = false;
static bool        txAsap       = false;   // send as soon as possible (radio just recovered)
static bool        txHoldoff    = true;    // after boot: wait for the arm (up to ARM_TIMEOUT_MS)
static uint32_t    bootMs       = 0;
static uint32_t    lastDownLogMs = 0;

// ─── ESP-NOW CALLBACK ─────────────────────────────────────────────
// Accepts only a full v2 packet for this unit (and from ARM_STRAP_MAC when pinned).
static void onDataReceived(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  uint32_t now = millis();
  const uint8_t *src = (info != NULL) ? info->src_addr : NULL;
  arm_packet_t pkt;
  memset(&pkt, 0, sizeof(pkt));
  int reason = -1;
  if (data == NULL || len != (int)sizeof(arm_packet_t)) {
    reason = REJ_LEN;
  } else {
    memcpy(&pkt, data, sizeof(pkt));
    if (pkt.magic != ARM_PKT_MAGIC)          reason = REJ_MAGIC;
    else if (pkt.version != ARM_PKT_VERSION) reason = REJ_VERSION;
    else if (pkt.unit_id != HALO_UNIT_ID)    reason = REJ_UNIT;
    else if (armMacPin && (src == NULL || memcmp(src, ARM_STRAP_MAC, 6) != 0)) reason = REJ_SENDER;
  }

  portENTER_CRITICAL(&armMux);
  if (reason >= 0) {
    armRx.rejected[reason]++;
    armRx.bad_len     = len;
    armRx.bad_version = pkt.version;
    armRx.bad_unit    = pkt.unit_id;
    if (src != NULL) memcpy(armRx.bad_mac, src, 6);
  } else {
    armRx.pkt     = pkt;
    armRx.last_ms = now;
    armRx.accepted++;
    if (src != NULL) memcpy(armRx.mac, src, 6);
    armRx.rssi = (info != NULL && info->rx_ctrl != NULL) ? (int8_t)info->rx_ctrl->rssi : 0;
    armRx.act_sum += pkt.activity_mg;
    armRx.act_n++;
    arm_loss_update(&armRx.loss, pkt.seq, now);
  }
  portEXIT_CRITICAL(&armMux);
}

static void armSnapshot(arm_rx *out) {
  portENTER_CRITICAL(&armMux);
  *out = armRx;
  portEXIT_CRITICAL(&armMux);
}

static void printMac(const uint8_t *m) {
  Serial.printf("%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
}

// New packets, sender MAC changes, link timeout and rejected frames (logged from loop(), not
// from the WiFi-task callback).
static void serviceArm(uint32_t now) {
  arm_rx a;
  armSnapshot(&a);

  if (a.accepted != seenAccepted) {
    seenAccepted = a.accepted;
    recent_mark(&armRecent, now);
    priDirty = true;                                        // a fall must go out at once
    if (!macShown || memcmp(macShownAddr, a.mac, 6) != 0) {
      if (!macShown) Serial.print("arm strap: first contact from ");
      else           Serial.print("arm strap: sender changed to ");
      printMac(a.mac);
      Serial.printf(" (RSSI %d dBm)%s\n", (int)a.rssi,
                    armMacPin ? "" : "; set ARM_STRAP_MAC to pin it if another HALO unit is nearby");
      memcpy(macShownAddr, a.mac, 6);
      macShown = true;
    }
  }

  bool ok = recent_check(&armRecent, now, ARM_TIMEOUT_MS);
  if (ok != armWasOk) {
    if (ok) Serial.println("arm strap: link up");
    else    Serial.printf("arm strap: link LOST (no packet for %u s): vitals and fall detection offline\n",
                          (unsigned)(ARM_TIMEOUT_MS / 1000));
    armWasOk = ok;
    priDirty = true;
  }

  static uint32_t shown[REJ_COUNT];
  static uint32_t lastRejLogMs = 0;
  bool changed = false;
  for (int i = 0; i < REJ_COUNT; i++) changed |= (a.rejected[i] != shown[i]);
  if (!changed || (uint32_t)(now - lastRejLogMs) < 2000) return;
  lastRejLogMs = now;
  if (a.rejected[REJ_LEN] != shown[REJ_LEN])
    Serial.printf("ESP-NOW: arm firmware mismatch: reflash both (got a %d-byte frame, expected %u bytes; %lu rejected)\n",
                  a.bad_len, (unsigned)sizeof(arm_packet_t), (unsigned long)a.rejected[REJ_LEN]);
  if (a.rejected[REJ_VERSION] != shown[REJ_VERSION])
    Serial.printf("ESP-NOW: arm firmware mismatch: reflash both (got packet version %u, expected %u; %lu rejected)\n",
                  (unsigned)a.bad_version, (unsigned)ARM_PKT_VERSION, (unsigned long)a.rejected[REJ_VERSION]);
  if (a.rejected[REJ_MAGIC] != shown[REJ_MAGIC])
    Serial.printf("ESP-NOW: ignored %lu foreign frame(s) (wrong magic)\n", (unsigned long)a.rejected[REJ_MAGIC]);
  if (a.rejected[REJ_UNIT] != shown[REJ_UNIT])
    Serial.printf("ESP-NOW: ignored %lu frame(s) from unit %u (this chest is unit %u)\n",
                  (unsigned long)a.rejected[REJ_UNIT], (unsigned)a.bad_unit, (unsigned)HALO_UNIT_ID);
  if (a.rejected[REJ_SENDER] != shown[REJ_SENDER]) {
    Serial.printf("ESP-NOW: ignored %lu frame(s) from ", (unsigned long)a.rejected[REJ_SENDER]);
    printMac(a.bad_mac);
    Serial.print(" (ARM_STRAP_MAC is ");
    printMac(ARM_STRAP_MAC);
    Serial.println(")");
  }
  memcpy(shown, a.rejected, sizeof(shown));
}

// ─── LORA RADIO: INIT, HEALTH CHECK, RECONNECT ────────────────────
// Direct register access with the library's SPI settings (8 MHz, MSB first, mode 0, manual CS).
static uint8_t loraReadReg(uint8_t addr) {
  digitalWrite(LORA_CS, LOW);
  SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
  SPI.transfer(addr & 0x7F);
  uint8_t v = SPI.transfer(0x00);
  SPI.endTransaction();
  digitalWrite(LORA_CS, HIGH);
  return v;
}

static void loraReadRegs(lora_regs *r) {
  r->version = loraReadReg(LORA_REG_VERSION);
  r->op_mode = loraReadReg(LORA_REG_OP_MODE);
  r->frf_msb = loraReadReg(LORA_REG_FRF_MSB);
  r->frf_mid = loraReadReg(LORA_REG_FRF_MID);
  r->frf_lsb = loraReadReg(LORA_REG_FRF_LSB);
  r->mc1     = loraReadReg(LORA_REG_MODEM_CONFIG_1);
  r->mc2     = loraReadReg(LORA_REG_MODEM_CONFIG_2);
}

static bool radioRegsOk() {
  lora_regs r;
  loraReadRegs(&r);
  return lora_regs_ok(&r, radioWhy, sizeof(radioWhy));
}

// Full init + register read-back. Blocks ~20 ms (the library's reset pulse). Never calls
// LoRa.end() (that would end SPI) and never restarts the ESP32.
static bool radioInit() {
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_CS);   // returns at once if SPI is already running
  LoRa.setPins(LORA_CS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ_HZ)) {                      // pulses RST, fails only if REG_VERSION != 0x12
    uint8_t v = loraReadReg(LORA_REG_VERSION);
    snprintf(radioWhy, sizeof(radioWhy), "LoRa.begin() found no SX127x, REG_VERSION 0x%02X%s", (unsigned)v,
             (v == 0x00 || v == 0xFF) ? " (no SPI answer: check wiring and 3.3V)" : "");
    return false;
  }
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW_HZ);
  LoRa.setCodingRate4(LORA_CR_DEN);
  LoRa.enableCrc();                                     // the gateway drops corrupted packets
  LoRa.setTxPower(LORA_TX_DBM);
  LoRa.setPreambleLength(LORA_PREAMBLE);
  return radioRegsOk();
}

static void radioGoDown(uint32_t now, const char *why) {
  radioTx = false;
  lora_link_down(&radio, now);
  Serial.printf("radio: OK -> DOWN (%s); sensing continues, re-init in %lu s\n", why,
                (unsigned long)(radio.wait_ms / 1000));
}

static void serviceRadio(uint32_t now) {
  if (radioTx) {
    uint8_t op = loraReadReg(LORA_REG_OP_MODE);
    if ((op & 0x07) != 0x03) {                           // TX finished: the SX1278 returns to standby
      radioTx = false;
      txEndMs = now;
      if (op == 0x81) {
        LoRa.sleep();                                    // sleep until the next packet; beginPacket() wakes it
      } else {
        char why[64];
        snprintf(why, sizeof(why), "REG_OP_MODE 0x%02X after TX, expected standby 0x81", (unsigned)op);
        radioGoDown(now, why);
      }
    } else if (lora_tx_stuck(op, txStartMs, now)) {
      radioGoDown(now, "TX watchdog: still transmitting 1500 ms after start");
    }
    return;
  }

  if (radio.up) {
    if ((uint32_t)(now - lastCheckMs) >= LORA_CHECK_MS) {
      lastCheckMs = now;
      if (!radioRegsOk()) radioGoDown(now, radioWhy);
    }
    return;
  }

  if (!lora_link_retry_due(&radio, now)) return;
  bool ok = radioInit();
  lora_link_result(&radio, ok, now);
  if (ok) {
    LoRa.sleep();
    lastCheckMs = now;
    txAsap      = true;                                  // the latest data goes out at once
    Serial.printf("radio: DOWN -> OK after %lu s (re-init #%lu)\n",
                  (unsigned long)((uint32_t)(now - radio.down_since_ms) / 1000),
                  (unsigned long)radio.reinits);
  } else {
    Serial.printf("radio: re-init #%lu failed (%s); next try in %lu s\n", (unsigned long)radio.reinits,
                  radioWhy, (unsigned long)(radio.wait_ms / 1000));
  }
}

// Starts an async TX. On any SPI/FIFO anomaly the radio is marked down.
static bool radioStartTx(const lora_packet_t *p, uint32_t now) {
  if (!LoRa.beginPacket()) {
    radioGoDown(now, "beginPacket() refused: radio reports TX in progress");
    return false;
  }
  size_t n = LoRa.write((const uint8_t *)p, sizeof(*p));
  if (n != sizeof(*p)) {
    char why[64];
    snprintf(why, sizeof(why), "FIFO write stored %u of %u bytes", (unsigned)n, (unsigned)sizeof(*p));
    radioGoDown(now, why);
    return false;
  }
  LoRa.endPacket(true);                                 // async: the loop keeps running while on air
  radioTx   = true;
  txStartMs = now;
  return true;
}

// ─── GPS ──────────────────────────────────────────────────────────
// Non-blocking: feeds whatever NMEA has arrived, then offers a new fix (if any) to the filter.
static void feedGPS(uint32_t now) {
  while (gpsSerial.available()) gps.encode((char)gpsSerial.read());
  // TinyGPSPlus commits gps.time for every GGA and RMC with a valid checksum, fix or not. Nothing
  // else reads gps.time, so its updated flag marks "valid NMEA"; value() clears it.
  bool good = gps.time.isUpdated();
  if (good) (void)gps.time.value();
  int nmea = gps_nmea_update(&gpsNmea, good, gps.charsProcessed());
  if (nmea == 1)
    recent_mark(&gpsUart, now);
  else if (nmea == 2)
    Serial.printf("GPS: %u bytes but no valid NMEA (check 9600 baud / TX wire)\n", (unsigned)GPS_GARBAGE_CHARS);

  if (!gps.location.isUpdated()) return;
  double lat = gps.location.lat();                     // reading clears isUpdated()
  double lng = gps.location.lng();
  if (!gps.location.isValid()) return;
  double hdop = (gps.hdop.isValid() && gps.hdop.age() <= GPS_GEOM_MAX_AGE_MS) ? gps.hdop.hdop() : -1.0;
  uint32_t sats = (gps.satellites.isValid() && gps.satellites.age() <= GPS_GEOM_MAX_AGE_MS)
                    ? gps.satellites.value() : 0;
  bool altOk = gps.altitude.isValid();
  double alt = altOk ? gps.altitude.meters() : 0.0;
  gps_offer_fix(&gpsTrack, lat, lng, altOk, alt, hdop, sats, now);
}

// ─── ADC ──────────────────────────────────────────────────────────
// analogReadMilliVolts() returns uint32_t on core 3.x and int32_t on core 4.x.
static int32_t readMilliVolts(uint8_t pin) {
  int32_t v = (int32_t)analogReadMilliVolts(pin);
  return v < 0 ? 0 : v;
}

// ─── MQ7 + MQ135 ──────────────────────────────────────────────────
static void readGasSensors(uint32_t now) {
  int32_t buf[MQ_SAMPLES];
  for (int i = 0; i < MQ_SAMPLES; i++) buf[i] = readMilliVolts(MQ7_PIN);
  mq_filter_update(&mq7Filt, batt_trimmed_mean(buf, MQ_SAMPLES, MQ_TRIM), now);

  int32_t raw[MQ_SAT_SAMPLES];
  for (int i = 0; i < MQ_SAT_SAMPLES; i++) raw[i] = (int32_t)analogRead(MQ7_PIN);
  coSat = mq_saturated(raw, MQ_SAT_SAMPLES);

  for (int i = 0; i < MQ_SAMPLES; i++) buf[i] = readMilliVolts(MQ135_PIN);
  mq_filter_update(&mq135Filt, batt_trimmed_mean(buf, MQ_SAMPLES, MQ_TRIM), now);

  coPpm = mq7_ppm(mq7Filt.mv);
  coRs  = mq7_rs_kohm(mq7Filt.mv);
  coMv  = (uint16_t)lroundf(mq7Filt.mv);
  aqMv  = (uint16_t)lroundf(mq135Filt.mv);
  aqi   = mq135_aqi(aqMv);
}

// ─── BATTERY ──────────────────────────────────────────────────────
static void serviceBattery(uint32_t now) {
  if ((uint32_t)(now - battLastMs) < BATT_PERIOD_MS) return;
  if (radioTx || (uint32_t)(now - txEndMs) < BATT_TX_SETTLE_MS) return;   // read after the TX sag
  battLastMs = now;
  int32_t v[BATT_SAMPLES];
  for (int i = 0; i < BATT_SAMPLES; i++) v[i] = readMilliVolts(BATT_PIN);
  // + BATT_LOAD_COMP_MV: estimated resting voltage (the SoC table is for a resting cell)
  float cellMv = batt_trimmed_mean(v, BATT_SAMPLES, BATT_TRIM) * BATT_DIVIDER * BATT_CAL + BATT_LOAD_COMP_MV;
  int ev = batt_update(&chestBatt, cellMv, now);
  if (ev > 0)      Serial.println("battery sense not detected on GPIO33 (check divider)");
  else if (ev < 0) Serial.printf("battery sense OK on GPIO33 (%.2f V)\n", cellMv / 1000.0f);
}

// ─── PACKET ───────────────────────────────────────────────────────
// Builds the packet from the latest state. actSum/actN return the activity accumulator used,
// so it can be subtracted once the TX has started.
static void buildPacket(lora_packet_t *p, uint32_t now, uint64_t *actSum, uint32_t *actN) {
  arm_rx a;
  armSnapshot(&a);
  bool armOk = recent_check(&armRecent, now, ARM_TIMEOUT_MS);

  lora_fields f;
  memset(&f, 0, sizeof(f));
  f.unit_id     = HALO_UNIT_ID;
  f.seq         = txSeq;
  f.arm_ok      = armOk;
  f.fall        = a.accepted > 0 && (a.pkt.flags & ARM_FLAG_FALL) != 0;
  f.skin        = (a.pkt.flags & ARM_FLAG_SKIN) != 0;
  f.ppg_motion  = (a.pkt.flags & ARM_FLAG_PPG_MOTION) != 0;
  f.arm_sensors = a.pkt.sensors;

  f.have_fix  = gpsTrack.have_fix;
  f.lat       = gpsTrack.lat;
  f.lng       = gpsTrack.lng;
  f.gps_alt_m = gpsTrack.alt_m;
  f.gps_age_s = gps_age_s(&gpsTrack, now);
  f.gps_fresh = f.gps_age_s <= GPS_FRESH_S;
  f.gps_uart  = recent_check(&gpsUart, now, GPS_UART_TIMEOUT_MS);
  f.gps_sats  = (gps.satellites.isValid() && gps.satellites.age() <= GPS_GEOM_MAX_AGE_MS)
                  ? gps.satellites.value() : 0;
  bool hdopRecent = gps.hdop.isValid() && gps.hdop.age() <= GPS_GEOM_MAX_AGE_MS;
  f.gps_hdop_x10 = gps_hdop_x10(hdopRecent, hdopRecent ? gps.hdop.value() : -1);

  f.hr          = a.pkt.heartRate;
  f.spo2        = a.pkt.spO2;
  f.ppg_quality = a.pkt.ppgQuality;
  f.temp_c      = a.pkt.temperature;
  f.hum_pct     = a.pkt.humidity;
  f.pres_hpa    = a.pkt.pressure;
  f.balt_m      = a.pkt.altitude;
  f.ax          = a.pkt.accel_x;
  f.ay          = a.pkt.accel_y;
  f.az          = a.pkt.accel_z;
  f.activity_mg = a.act_n > 0 ? (float)a.act_sum / (float)a.act_n : (float)a.pkt.activity_mg;
  f.still_s     = a.pkt.still_s;
  f.vbat_arm_mv = a.pkt.batt_mv;
  f.batt_arm_pct = a.pkt.batt_pct;
  f.arm_loss_pct = arm_loss_pct(&a.loss);

  f.co_ppm = coPpm;
  f.co_mv  = coMv;
  f.co_sat = coSat;
  f.aqi    = aqi;
  f.aq_mv  = aqMv;
  f.vbat_chest_mv  = batt_report_mv(&chestBatt);
  f.batt_chest_pct = batt_report_pct(&chestBatt);
  f.lora_reinits   = radio.reinits;
  int64_t upUs     = esp_timer_get_time();     // µs since boot; one read for UP and the MQ warm-up
  f.uptime_min     = (uint32_t)(upUs / 60000000LL);

  lora_encode(&f, p);
  mqWarmupLeftS = mq_warmup_left_s((uint64_t)upUs / 1000u);
  p->priority   = lora_priority(p, coCeilingPpm, mqWarmupLeftS > 0);
  *actSum = a.act_sum;
  *actN   = a.act_n;
}

// One status line per TX (or per TX interval while the radio is down).
static void printStatus(const lora_packet_t *p, bool sent, uint32_t now) {
  arm_rx a;
  armSnapshot(&a);

  char armS[80];
  if (p->flags & LP_FLAG_ARM_OK) {
    char loss[8];
    if (p->arm_loss_pct == 255) snprintf(loss, sizeof(loss), "n/a");
    else                        snprintf(loss, sizeof(loss), "%u%%", (unsigned)p->arm_loss_pct);
    snprintf(armS, sizeof(armS), "arm:ok loss %s seq %u rssi %d", loss, (unsigned)a.pkt.seq, (int)a.rssi);
  } else if (a.accepted == 0) {
    snprintf(armS, sizeof(armS), "arm:NEVER SEEN");
  } else {
    snprintf(armS, sizeof(armS), "arm:SILENT %lus", (unsigned long)((uint32_t)(now - armRecent.last_ms) / 1000));
  }

  char gpsS[96], hd[12];
  if (p->gps_hdop_x10 == 255) snprintf(hd, sizeof(hd), "--");
  else                        snprintf(hd, sizeof(hd), "%.1f", p->gps_hdop_x10 / 10.0);
  if (!(p->flags & LP_FLAG_GPS_UART))
    snprintf(gpsS, sizeof(gpsS), "GPS NO NMEA (check wiring)%s", (p->flags & LP_FLAG_HAVE_FIX) ? ", last fix kept" : "");
  else if (!(p->flags & LP_FLAG_HAVE_FIX))
    snprintf(gpsS, sizeof(gpsS), "GPS searching %usat hdop%s", (unsigned)p->gps_sats, hd);
  else
    snprintf(gpsS, sizeof(gpsS), "GPS %s %usat hdop%s age %us", (p->flags & LP_FLAG_GPS_FRESH) ? "fix" : "STALE",
             (unsigned)p->gps_sats, hd, (unsigned)p->gps_age_s);
  if (gpsTrack.rej_geometry || gpsTrack.rej_jump) {
    size_t l = strlen(gpsS);
    snprintf(gpsS + l, sizeof(gpsS) - l, " rej %lu/%lu", (unsigned long)gpsTrack.rej_geometry,
             (unsigned long)gpsTrack.rej_jump);
  }

  char coS[96];
  snprintf(coS, sizeof(coS), "CO %s%.1fppm (%umV R0(clean) %.2fk)%s AQI %u", (p->flags & LP_FLAG_CO_SAT) ? ">=" : "",
           p->co_ppm_x10 / 10.0, (unsigned)p->co_mv, coRs / MQ7_CLEAN_AIR_RATIO,
           (p->flags & LP_FLAG_CO_SAT) ? " SATURATED" : "", (unsigned)p->aqi);
  char warmS[48] = "";                 // CO / AQI not in the priority yet (see MQ_WARMUP_S)
  if (mqWarmupLeftS > 0)
    snprintf(warmS, sizeof(warmS), " | MQ warm-up %u:%02u left", (unsigned)(mqWarmupLeftS / 60),
             (unsigned)(mqWarmupLeftS % 60));

  char batS[64], chest[20], arm[20];
  if (p->batt_chest_pct == 255) snprintf(chest, sizeof(chest), "n/a");
  else snprintf(chest, sizeof(chest), "%.2fV %u%%", p->vbat_chest_mv / 1000.0, (unsigned)p->batt_chest_pct);
  if (p->batt_arm_pct == 255) snprintf(arm, sizeof(arm), "n/a");
  else snprintf(arm, sizeof(arm), "%.2fV %u%%", p->vbat_arm_mv / 1000.0, (unsigned)p->batt_arm_pct);
  snprintf(batS, sizeof(batS), "BAT chest %s arm %s", chest, arm);

  if (sent) Serial.printf("LoRa TX #%u [P%u] %uB", (unsigned)p->seq, (unsigned)p->priority, (unsigned)sizeof(*p));
  else      Serial.printf("LoRa -- [P%u] not sent", (unsigned)p->priority);
  Serial.printf(" | %s | %s | %s%s | %s | radio %s reinits %lu\n", armS, gpsS, coS, warmS, batS,
                radio.up ? "ok" : "DOWN", (unsigned long)radio.reinits);
}

static void serviceTx(uint32_t now) {
  if (txHoldoff) {                     // first packet: wait until the arm is heard (or ARM_TIMEOUT_MS)
    if (seenAccepted == 0 && (uint32_t)(now - bootMs) < ARM_TIMEOUT_MS) return;
    txHoldoff = false;
  }
  if (!tx_due(curPri, lastTxPri, lastTxMs, anyTx, txAsap, now)) return;
  if (radioTx) return;                 // previous packet still on air: send right after it

  lora_packet_t p;
  uint64_t actSum;
  uint32_t actN;
  if (!radio.up) {                     // radio down: keep logging at the TX rate
    if ((uint32_t)(now - lastDownLogMs) < tx_interval_ms(curPri)) return;
    lastDownLogMs = now;
    buildPacket(&p, now, &actSum, &actN);
    printStatus(&p, false, now);
    return;
  }

  buildPacket(&p, now, &actSum, &actN);
  curPri = p.priority;
  if (!radioStartTx(&p, now)) return;

  portENTER_CRITICAL(&armMux);         // these arm packets are now accounted for
  armRx.act_sum -= actSum;
  armRx.act_n   -= actN;
  portEXIT_CRITICAL(&armMux);
  txSeq++;
  lastTxMs  = now;
  lastTxPri = p.priority;
  anyTx     = true;
  txAsap    = false;
  printStatus(&p, true, now);
}

static void updatePriority(uint32_t now) {
  lora_packet_t p;
  uint64_t actSum;
  uint32_t actN;
  buildPacket(&p, now, &actSum, &actN);
  static bool warmDoneLogged = false;
  if (mqWarmupLeftS == 0 && !warmDoneLogged) {
    warmDoneLogged = true;
    Serial.println("MQ warm-up done: CO, CO saturation and AQI now count in the priority");
  }
  if (p.priority != curPri && !txHoldoff)
    Serial.printf("priority: P%u -> P%u\n", (unsigned)curPri, (unsigned)p.priority);
  curPri = p.priority;
}

// ─── SETUP ────────────────────────────────────────────────────────
void setup() {
  setCpuFrequencyMhz(80);                         // saves power; WiFi / ESP-NOW need >= 80 MHz
  Serial.setTxBufferSize(1024);                   // status lines do not block the loop
  Serial.begin(115200);
  delay(500);
  bootMs = millis();
  Serial.printf("=== CHEST STRAP STARTING (HALO-%02u, Session 4) ===\n", (unsigned)HALO_UNIT_ID);
  Serial.printf("CPU %lu MHz (set to 80 MHz to save power; WiFi needs >= 80)\n",
                (unsigned long)getCpuFrequencyMhz());

  batt_reset(&chestBatt);
  for (int i = 0; i < 6; i++) armMacPin |= (ARM_STRAP_MAC[i] != 0);

  // WiFi STA for ESP-NOW
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();

  if (esp_now_init() != ESP_OK) {
    Serial.println("ERROR: ESP-NOW init failed — restarting");
    delay(2000);
    ESP.restart();
  }
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_ps(WIFI_PS_NONE);                  // never sleep the radio → no missed arm packets
  if (esp_now_register_recv_cb(onDataReceived) != ESP_OK) {
    Serial.println("ERROR: ESP-NOW receive callback not registered — restarting");
    delay(2000);
    ESP.restart();
  }

  uint8_t mac[6];
  esp_wifi_get_mac(WIFI_IF_STA, mac);             // read from the driver (WiFi.macAddress() can return zeros)
  Serial.print("Chest Strap MAC: ");
  printMac(mac);
  Serial.println(" (the arm strap sends to this address)");
  Serial.printf("ESP-NOW receiver ready on channel %d: arm packet v%u, %u bytes, unit %u, ",
                ESPNOW_CHANNEL, (unsigned)ARM_PKT_VERSION, (unsigned)sizeof(arm_packet_t), (unsigned)HALO_UNIT_ID);
  if (armMacPin) {
    Serial.print("sender pinned to ");
    printMac(ARM_STRAP_MAC);
    Serial.println();
  } else {
    Serial.println("any sender");
  }

  // GPS — larger RX buffer so NMEA isn't lost while the loop is busy
  gpsSerial.setRxBufferSize(1024);
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX, GPS_TX);
  Serial.println("GPS NEO6M on UART2 (RX 16, TX 17) at 9600 baud ✓");

  // MQ sensors + battery sense (ADC1 pins, usable with WiFi on)
  pinMode(MQ7_PIN,   INPUT);
  pinMode(MQ135_PIN, INPUT);
  pinMode(BATT_PIN,  INPUT);
  coCeilingPpm = mq7_ppm(MQ7_ADC_MAX_MV);
  Serial.printf("MQ7 & MQ135 ready ✓ (allow 2–5 min warm-up; CO / AQI do not raise the TX priority "
                "for the first %d s)\n", MQ_WARMUP_S);
  Serial.printf("MQ7: co_ceiling_ppm = %.1f (ADC ceiling %d mV, MQ7_R0 %.2f kOhm, MQ7_DIVIDER %.2f). "
                "At the ceiling the packet sets COSAT: true CO is >= the value sent.\n",
                coCeilingPpm, MQ7_ADC_MAX_MV, MQ7_R0, MQ7_DIVIDER);
  if (coCeilingPpm < CO_WARNING_PPM)
    Serial.println("WARNING: the CO ceiling is below the 35 ppm P1 limit. Fit the 10k/20k divider and set MQ7_DIVIDER 1.5.");
  else if (coCeilingPpm < CO_CRITICAL_PPM)
    Serial.println("WARNING: the CO ceiling is below the 200 ppm P0 limit. Fit the 10k/20k divider and set MQ7_DIVIDER 1.5.");
  Serial.printf("Battery sense on GPIO %d (divider x%.2f, cal %.3f, load comp %d mV)\n", BATT_PIN, BATT_DIVIDER,
                BATT_CAL, (int)BATT_LOAD_COMP_MV);

  // LoRa — a failure here does not stop the chest: it keeps sensing and retries with backoff
  Serial.printf("LoRa: %u-byte packet = %.1f ms on air (SF%d, BW %ld kHz, CR 4/%d, CRC, preamble %d)\n",
                (unsigned)sizeof(lora_packet_t),
                lora_airtime_ms((int)sizeof(lora_packet_t), LORA_SF, (double)LORA_BW_HZ, LORA_CR_DEN, LORA_PREAMBLE),
                LORA_SF, (long)(LORA_BW_HZ / 1000), LORA_CR_DEN, LORA_PREAMBLE);
  uint32_t now = millis();
  if (radioInit()) {
    radio.up = true;
    LoRa.sleep();
    lastCheckMs = now;
    Serial.println("radio: OK (433 MHz, SF9, BW 125 kHz, CR 4/5, CRC on, 17 dBm; registers verified) ✓");
  } else {
    lora_link_down(&radio, now);
    Serial.printf("radio: DOWN at boot (%s). Check 3.3V, GND, NSS=5, RST=14, SCK=18, MISO=19, MOSI=23. "
                  "Sensing continues; re-init in %lu s\n", radioWhy, (unsigned long)(radio.wait_ms / 1000));
  }

  Serial.println("=== CHEST STRAP READY ===\n");
}

// ─── LOOP ─────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();
  feedGPS(now);                                   // every pass — never blocks
  serviceArm(now);
  serviceRadio(now);

  static uint32_t lastSensorMs = 0;
  if ((uint32_t)(now - lastSensorMs) >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readGasSensors(now);
    priDirty = true;
  }
  serviceBattery(now);

  if (priDirty) {
    priDirty = false;
    updatePriority(now);
  }
  serviceTx(now);
}

