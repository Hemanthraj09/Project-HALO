/*
  =============================================
  GATEWAY - ESP32 (LoRa RX → USB Serial)
  Receives LoRa packets from the chest strap
  Forwards each one to backend.py as one text line on USB serial
  =============================================

  CORE: arduino-esp32 >= 3.0 (ESP-IDF 5.x API). Tested with 3.3.11 and 4.0.0,
        board "ESP32 Dev Module".

  LIBRARIES REQUIRED:
  - LoRa 0.8.0 (by Sandeep Mistry)

  POWER: USB from the PC.

  WIRING:
  LoRa RA02  → ESP32   (3.3V ONLY — 5V destroys the module)
    VCC      → 3.3V
    GND      → GND
    SCK      → GPIO 18
    MISO     → GPIO 19
    MOSI     → GPIO 23
    NSS/CS   → GPIO 5
    RST      → GPIO 14
    DIO0     → GPIO 4   (not used: the gateway polls, so it also works with DIO0 still on GPIO 2;
                         GPIO 2 is a boot strapping pin, avoid it for new wiring)

  SERIAL OUTPUT (115200 baud):
    Telemetry, v2 binary packet decoded into one line (a key is left out when its value is unknown):
      ID:HALO-01,FMT:2,PRI:2,SEQ:812,LAT:12.9428900,LNG:77.5682100,ALT:905,GPSAGE:1,GPS:1,GPSU:1,
      SATS:7,HDOP:1.1,ARM:1,HR:72,SPO2:98,PPGQ:86,SKIN:1,MOTION:0,ACT:35,STILL:0,TEMP:29.80,HUM:54.50,
      PRES:913.2,BALT:905,AX:0.12,AY:-0.34,AZ:9.81,ASENS:15,FALL:0,CO:12.4,COR:410,COSAT:0,AQI:66,
      AQR:410,BATC:73,VBC:3.920,BATA:64,VBA:3.870,ARMLOSS:2,REINIT:0,UP:135,RSSI:-57,SNR:9.5
      (shown wrapped here; it is a single line)
    Telemetry, legacy v1 text packet: forwarded unchanged + ,RSSI:-57,SNR:9.5,FMT:1
    Diagnostics: lines starting with '#' (ignored by backend.py)

  SESSION 4 CHANGES
  - Decodes the binary v2 packet (62 bytes) into one text line with the keys above.
    Legacy v1 text packets are still forwarded (tagged FMT:1); anything else is dropped and logged.
  - LoRa register read-back after init, health check every 2 s, re-init with backoff
    1, 2, 4, 8, 16, then 30 s, and a silence watchdog (one re-init per 60 s without a valid packet).
    It no longer restarts the ESP32 when the radio fails.
  - "# alive" line every 30 s with counters.
  - RSSI is the packet strength: below the noise floor (SNR < 0) it now includes the SNR
    (SX127x datasheet 5.5.5), so a weak link no longer shows up to ~12 dB stronger than it is.
*/

#include <LoRa.h>
#include <SPI.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

// >>> HALO_PURE_BEGIN config
// ─── LORA ─────────────────────────────────────────────────────────
#define LORA_SCK  18
#define LORA_MISO 19
#define LORA_MOSI 23
#define LORA_CS   5
#define LORA_RST  14
#define LORA_DIO0 4
#define LORA_FREQ_HZ        433000000L  // radio settings below must match the chest strap
#define LORA_SF             9
#define LORA_BW_HZ          125000L
#define LORA_CR_DEN         5           // coding rate 4/5
#define LORA_TX_DBM         17          // the gateway never transmits; set so both radios are configured alike
#define LORA_PREAMBLE       8
#define LORA_CHECK_MS       2000        // register health check interval

// ─── GATEWAY ──────────────────────────────────────────────────────
#define GW_SILENCE_REINIT_MS 60000      // no valid packet this long (radio healthy) = one soft re-init
#define STATUS_INTERVAL_MS   30000      // "# alive" line
#define LINE_BUF_SIZE        512        // one telemetry line (a v2 line is at most ~400 chars)
#define PACKET_PREFIX        "ID:"      // legacy v1 text packets start with this
// <<< HALO_PURE_END config

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
struct lora_regs;
struct lora_link;

// >>> HALO_PURE_BEGIN lora_decode
// ─── LORA PACKET → TEXT LINE ──────────────────────────────────────
#define ARM_SENS_IMU 0x01         // lora_packet_t.arm_sensors bits (same values as ARM_SENS_* in the
#define ARM_SENS_BME 0x02         // ESP-NOW payload block of arm_strap_v2.ino / chest_strap_v2.ino)

// Formats one v2 packet as the newline-terminated text line backend.py reads: KEY:VALUE pairs in a
// fixed order, comma-separated, no spaces; a key is left out when its value is unknown.
// Returns the line length, -1 if buf is not a v2 packet, -2 if the line does not fit in out
// (out is then an empty string, so a partial line can never be printed).
static int lora_decode_line(const uint8_t *buf, int len, int rssi, float snr, char *out, size_t size) {
  if (out == NULL || size == 0) return -2;
  out[0] = '\0';
  if (buf == NULL || len != (int)sizeof(lora_packet_t) || buf[0] != LORA_PKT_MAGIC || buf[1] != LORA_PKT_VERSION)
    return -1;
  lora_packet_t p;
  memcpy(&p, buf, sizeof(p));
  size_t pos = 0;
  int n = 0;
#define LP_PUT(...)                                                     \
  do {                                                                  \
    n = snprintf(out + pos, size - pos, __VA_ARGS__);                   \
    if (n < 0 || (size_t)n >= size - pos) { out[0] = '\0'; return -2; } \
    pos += (size_t)n;                                                   \
  } while (0)

  bool arm = (p.flags & LP_FLAG_ARM_OK) != 0;
  LP_PUT("ID:HALO-%02u,FMT:2,PRI:%u,SEQ:%u", (unsigned)p.unit_id, (unsigned)p.priority, (unsigned)p.seq);
  if (p.flags & LP_FLAG_HAVE_FIX) {
    LP_PUT(",LAT:%.7f,LNG:%.7f,ALT:%d", p.lat_e7 / 1e7, p.lng_e7 / 1e7, (int)p.gps_alt_m);
    if (p.gps_age_s != 65535) LP_PUT(",GPSAGE:%u", (unsigned)p.gps_age_s);
  }
  LP_PUT(",GPS:%d,GPSU:%d", (p.flags & LP_FLAG_GPS_FRESH) ? 1 : 0, (p.flags & LP_FLAG_GPS_UART) ? 1 : 0);
  if (p.gps_sats != 0)       LP_PUT(",SATS:%u", (unsigned)p.gps_sats);
  if (p.gps_hdop_x10 != 255) LP_PUT(",HDOP:%.1f", p.gps_hdop_x10 / 10.0);
  LP_PUT(",ARM:%d", arm ? 1 : 0);
  if (arm) {
    LP_PUT(",HR:%d,SPO2:%d,PPGQ:%u,SKIN:%d,MOTION:%d,ACT:%u,STILL:%u", (int)p.hr, (int)p.spo2,
           (unsigned)p.ppg_quality, (p.flags & LP_FLAG_SKIN) ? 1 : 0, (p.flags & LP_FLAG_PPG_MOTION) ? 1 : 0,
           (unsigned)p.activity_mg, (unsigned)p.still_s);
    if (p.arm_sensors & ARM_SENS_BME)
      LP_PUT(",TEMP:%.2f,HUM:%.2f,PRES:%.1f,BALT:%d", p.temp_c_x100 / 100.0, p.hum_x100 / 100.0,
             p.pres_hpa_x10 / 10.0, (int)p.balt_m);
    if (p.arm_sensors & ARM_SENS_IMU)
      LP_PUT(",AX:%.2f,AY:%.2f,AZ:%.2f", p.ax_cms2 / 100.0, p.ay_cms2 / 100.0, p.az_cms2 / 100.0);
  }
  LP_PUT(",ASENS:%u,FALL:%d", (unsigned)p.arm_sensors, (p.flags & LP_FLAG_FALL) ? 1 : 0);
  LP_PUT(",CO:%.1f,COR:%u,COSAT:%d,AQI:%u,AQR:%u", p.co_ppm_x10 / 10.0, (unsigned)p.co_mv,
         (p.flags & LP_FLAG_CO_SAT) ? 1 : 0, (unsigned)p.aqi, (unsigned)p.aq_mv);
  if (p.batt_chest_pct != 255)
    LP_PUT(",BATC:%u,VBC:%.3f", (unsigned)p.batt_chest_pct, p.vbat_chest_mv / 1000.0);
  if (arm && p.batt_arm_pct != 255)
    LP_PUT(",BATA:%u,VBA:%.3f", (unsigned)p.batt_arm_pct, p.vbat_arm_mv / 1000.0);
  if (p.arm_loss_pct != 255) LP_PUT(",ARMLOSS:%u", (unsigned)p.arm_loss_pct);
  LP_PUT(",REINIT:%u,UP:%u,RSSI:%d,SNR:%.1f\n", (unsigned)p.lora_reinits, (unsigned)p.uptime_min, rssi,
         (double)snr);
#undef LP_PUT
  return (int)pos;
}

// Packet signal strength (dBm) for the RSSI key. LoRa 0.8.0's packetRssi() is PacketRssi - 164 at
// 433 MHz, the power in the channel. Below the noise floor (SNR < 0) the packet is weaker than that:
// SX1276/77/78 datasheet 5.5.5 gives -164 + PacketRssi + PacketSnr × 0.25 (= packetSnr() in dB).
static int lora_packet_dbm(int pkt_rssi, float snr) {
  return snr < 0.0f ? pkt_rssi + (int)lroundf(snr) : pkt_rssi;
}

// Legacy v1 packet: starts with "ID:" and is printable ASCII only.
static bool lora_is_v1_text(const uint8_t *buf, int len) {
  const int plen = (int)strlen(PACKET_PREFIX);
  if (buf == NULL || len < plen || memcmp(buf, PACKET_PREFIX, (size_t)plen) != 0) return false;
  for (int i = 0; i < len; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7E) return false;
  }
  return true;
}
// <<< HALO_PURE_END lora_decode

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

// ─── STATE ────────────────────────────────────────────────────────
static lora_link radio;                    // up/down state machine + backoff
static char      radioWhy[112];            // reason of the last failed check / init
static uint32_t  lastCheckMs    = 0;
static uint32_t  silenceStartMs = 0;       // last valid packet or last silence re-init
static uint32_t  lastAliveMs    = 0;
static uint32_t  lastRxMs       = 0;
static uint32_t  rxV2 = 0, rxV1 = 0, dropCount = 0;
static int       lastRssi       = 0;
static char      lineBuf[LINE_BUF_SIZE];   // one telemetry line, written with a single Serial.write()

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
  LoRa.enableCrc();                                     // packets failing CRC are discarded by parsePacket()
  LoRa.setTxPower(LORA_TX_DBM);
  LoRa.setPreambleLength(LORA_PREAMBLE);
  return radioRegsOk();
}

static void radioGoDown(uint32_t now, const char *why) {
  lora_link_down(&radio, now);
  Serial.printf("# radio: OK -> DOWN (%s); re-init in %lu s\n", why, (unsigned long)(radio.wait_ms / 1000));
}

// Health check, silence watchdog and backoff re-init.
static void serviceRadio(uint32_t now) {
  if (radio.up) {
    if ((uint32_t)(now - lastCheckMs) >= LORA_CHECK_MS) {
      lastCheckMs = now;
      if (!radioRegsOk()) {
        radioGoDown(now, radioWhy);
        return;
      }
    }
    if ((uint32_t)(now - silenceStartMs) >= GW_SILENCE_REINIT_MS) {
      silenceStartMs = now;                             // at most one soft re-init per window
      Serial.printf("# radio: silence %us, re-initialising\n", (unsigned)(GW_SILENCE_REINIT_MS / 1000));
      bool ok = radioInit();
      lora_link_result(&radio, ok, now);
      lastCheckMs = now;
      if (ok) {
        Serial.printf("# radio: re-init #%lu OK, listening\n", (unsigned long)radio.reinits);
      } else {
        Serial.printf("# radio: OK -> DOWN (silence re-init failed: %s); re-init in %lu s\n", radioWhy,
                      (unsigned long)(radio.wait_ms / 1000));
      }
    }
    return;
  }

  if (!lora_link_retry_due(&radio, now)) return;
  bool ok = radioInit();
  lora_link_result(&radio, ok, now);
  if (!ok) {
    Serial.printf("# radio: re-init #%lu failed (%s); next try in %lu s\n", (unsigned long)radio.reinits,
                  radioWhy, (unsigned long)(radio.wait_ms / 1000));
    return;
  }
  lastCheckMs    = now;
  silenceStartMs = now;
  Serial.printf("# radio: DOWN -> OK after %lu s (re-init #%lu), listening\n",
                (unsigned long)((uint32_t)(now - radio.down_since_ms) / 1000), (unsigned long)radio.reinits);
}

// ─── RX ───────────────────────────────────────────────────────────
static void writeLine(int n, uint32_t now, int rssi) {
  Serial.write((const uint8_t *)lineBuf, (size_t)n);  // the whole line in one call
  lastRxMs       = now;
  silenceStartMs = now;
  lastRssi       = rssi;
}

static void dropPacket(int len, const uint8_t *buf, int rssi, float snr, const char *why) {
  dropCount++;
  Serial.printf("# dropped len=%d first=0x%02X rssi=%d snr=%.1f (%s)\n", len, (unsigned)(len > 0 ? buf[0] : 0),
                rssi, (double)snr, why);
}

static void handlePacket(uint32_t now) {
  uint8_t buf[256];
  int len = 0;
  while (len < 255 && LoRa.available()) {
    int c = LoRa.read();
    if (c < 0) break;
    buf[len++] = (uint8_t)c;
  }
  buf[len] = 0;
  int   rssi = LoRa.packetRssi();
  float snr  = LoRa.packetSnr();
  rssi = lora_packet_dbm(rssi, snr);                    // weak packets (SNR < 0) are below the channel power

  if (len == (int)sizeof(lora_packet_t) && buf[0] == LORA_PKT_MAGIC && buf[1] == LORA_PKT_VERSION) {
    int n = lora_decode_line(buf, len, rssi, snr, lineBuf, sizeof(lineBuf));
    if (n > 0) {
      rxV2++;
      writeLine(n, now, rssi);
    } else {
      dropPacket(len, buf, rssi, snr, "v2 line did not fit the buffer");
    }
    return;
  }
  if (lora_is_v1_text(buf, len)) {
    int n = snprintf(lineBuf, sizeof(lineBuf), "%s,RSSI:%d,SNR:%.1f,FMT:1\n", (const char *)buf, rssi, (double)snr);
    if (n > 0 && (size_t)n < sizeof(lineBuf)) {
      rxV1++;
      writeLine(n, now, rssi);
    } else {
      dropPacket(len, buf, rssi, snr, "v1 line did not fit the buffer");
    }
    return;
  }
  const char *why = "not a HALO packet";
  if (len > 0 && buf[0] == LORA_PKT_MAGIC)
    why = (len != (int)sizeof(lora_packet_t)) ? "v2 magic but wrong length" : "unknown packet version";
  else if (len == 0)
    why = "empty";
  dropPacket(len, buf, rssi, snr, why);
}

static void printAlive(uint32_t now) {
  uint32_t rx = rxV2 + rxV1;
  char last[16], rssi[12];
  if (rx == 0) {
    snprintf(last, sizeof(last), "never");
    snprintf(rssi, sizeof(rssi), "n/a");
  } else {
    snprintf(last, sizeof(last), "%lus", (unsigned long)((uint32_t)(now - lastRxMs) / 1000));
    snprintf(rssi, sizeof(rssi), "%d", lastRssi);
  }
  Serial.printf("# alive rx=%lu (v2 %lu, v1 %lu) dropped=%lu last=%s radio=%s reinits=%lu lastRSSI=%s\n",
                (unsigned long)rx, (unsigned long)rxV2, (unsigned long)rxV1, (unsigned long)dropCount, last,
                radio.up ? "ok" : "down", (unsigned long)radio.reinits, rssi);
}

// ─── SETUP ────────────────────────────────────────────────────────
void setup() {
  Serial.setTxBufferSize(1024);                    // printing a line does not stall the RX polling
  Serial.begin(115200);
  delay(500);
  Serial.println("# === GATEWAY STARTING (Session 4) ===");

  uint32_t now = millis();
  if (radioInit()) {
    radio.up = true;
    Serial.println("# radio: OK (433 MHz, SF9, BW 125 kHz, CR 4/5, CRC on; registers verified)");
  } else {
    lora_link_down(&radio, now);
    Serial.printf("# radio: DOWN at boot (%s). Check 3.3V, GND, NSS=5, RST=14, SCK=18, MISO=19, MOSI=23. "
                  "Re-init in %lu s\n", radioWhy, (unsigned long)(radio.wait_ms / 1000));
  }
  lastCheckMs    = now;
  silenceStartMs = now;
  lastAliveMs    = now;
  Serial.printf("# LoRa Gateway ready, waiting for packets (v2 binary %u bytes, legacy v1 text)\n",
                (unsigned)sizeof(lora_packet_t));
}

// ─── LOOP ─────────────────────────────────────────────────────────
void loop() {
  uint32_t now = millis();
  if (radio.up) {
    int packetSize = LoRa.parsePacket();           // polls; re-arms RX automatically
    if (packetSize > 0) handlePacket(now);
  }
  serviceRadio(now);

  if ((uint32_t)(now - lastAliveMs) >= STATUS_INTERVAL_MS) {
    lastAliveMs = now;
    printAlive(now);
  }
}
