#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <Firebase_ESP_Client.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>

#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

// =====================================================
// WIFI
// =====================================================

#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASSWORD ""

// =====================================================
// FIREBASE
// =====================================================

#define API_KEY "c8MIMltru5M9UVZYBicpaeGvhDONJZA5EMpN9uAQ"
#define DATABASE_URL "iot-minggu6-623b2-default-rtdb.asia-southeast1.firebasedatabase.app"

// =====================================================
// PIN KONFIGURASI
// =====================================================

// Aktuator Lingkungan (Suhu & Kelembapan)
#define FAN_PIN 25           // Kipas Ekstraksi Panas
#define HUMIDIFIER_PIN 26    // Humidifier (Saat Kelembapan Rendah / Anti-ESD)
#define DEHUMIDIFIER_PIN 27  // Dehumidifier (Saat Kelembapan Tinggi / Anti-Kondensasi)

// 3 Sensor DHT22
#define DHT_FL_PIN 4    // Depan Kiri (Cold Intake)
#define DHT_FR_PIN 18   // Depan Kanan (Cold Intake)
#define DHT_RC_PIN 19   // Belakang Tengah (Hot Exhaust)
#define DHT_TYPE DHT22

#define I2C_SDA 21
#define I2C_SCL 22

// =====================================================
// OBJECT
// =====================================================

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

LiquidCrystal_I2C lcd(0x27, 16, 2);

DHT dht_fl(DHT_FL_PIN, DHT_TYPE);
DHT dht_fr(DHT_FR_PIN, DHT_TYPE);
DHT dht_rc(DHT_RC_PIN, DHT_TYPE);

// =====================================================
// VARIABLE & STATUS
// =====================================================

unsigned long lastUpdate = 0;

float temp_fl = 24.0, hum_fl = 50.0;
float temp_fr = 24.0, hum_fr = 50.0;
float temp_rc = 28.0, hum_rc = 45.0;

// Batas Threshold (Default)
float threshold_warn = 28.0;      // Suhu waspada kipas (°C)
float threshold_hum_low = 40.0;   // Batas minimum RH (%) -> Trigger Humidifier
float threshold_hum_high = 70.0;  // Batas maksimum RH (%) -> Trigger Dehumidifier

bool status_kipas = false;
bool status_humidifier = false;
bool status_dehumidifier = false;

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  // Inisialisasi Pin Aktuator
  pinMode(FAN_PIN, OUTPUT);
  pinMode(HUMIDIFIER_PIN, OUTPUT);
  pinMode(DEHUMIDIFIER_PIN, OUTPUT);

  digitalWrite(FAN_PIN, LOW);
  digitalWrite(HUMIDIFIER_PIN, LOW);
  digitalWrite(DEHUMIDIFIER_PIN, LOW);

  // Inisialisasi 3 Sensor DHT22
  dht_fl.begin();
  dht_fr.begin();
  dht_rc.begin();

  // I2C & LCD
  Wire.begin(I2C_SDA, I2C_SCL);
  lcd.init();
  lcd.backlight();

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("DC Enviro System");
  lcd.setCursor(0, 1);
  lcd.print("Connecting WiFi");

  // WiFi Connection
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi Connected!");
  Serial.print("IP Address: ");
  Serial.println(WiFi.localIP());

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("WiFi Connected");

  delay(800);

  // Konfigurasi Firebase
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.signer.test_mode = true;

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  Serial.println("Firebase Initialized");

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Firebase OK");

  delay(800);
}

// =====================================================
// LOOP
// =====================================================

void loop() {
  // Sampling setiap 5 detik
  if (millis() - lastUpdate < 5000) {
    return;
  }
  lastUpdate = millis();

  // ===================================================
  // BACA DATA SENSOR (RAW ACQUISITION)
  // ===================================================
  float t_fl = dht_fl.readTemperature();
  float h_fl = dht_fl.readHumidity();

  float t_fr = dht_fr.readTemperature();
  float h_fr = dht_fr.readHumidity();

  float t_rc = dht_rc.readTemperature();
  float h_rc = dht_rc.readHumidity();

  if (!isnan(t_fl) && !isnan(h_fl)) {
    temp_fl = t_fl;
    hum_fl = h_fl;
  }
  if (!isnan(t_fr) && !isnan(h_fr)) {
    temp_fr = t_fr;
    hum_fr = h_fr;
  }
  if (!isnan(t_rc) && !isnan(h_rc)) {
    temp_rc = t_rc;
    hum_rc = h_rc;
  }

  // ===================================================
  // KONTROL AKTUATOR SUHU & KELEMBAPAN
  // ===================================================
  if (Firebase.ready()) {
    // Sinkronisasi threshold dari Firebase (jika tersedia)
    if (Firebase.RTDB.getFloat(&fbdo, "monitoring/settings/warn")) {
      threshold_warn = fbdo.floatData();
    }
    if (Firebase.RTDB.getFloat(&fbdo, "monitoring/settings/hum_low")) {
      threshold_hum_low = fbdo.floatData();
    }
    if (Firebase.RTDB.getFloat(&fbdo, "monitoring/settings/hum_high")) {
      threshold_hum_high = fbdo.floatData();
    }

    // 1. Kontrol Kipas (Pemicu Suhu Tinggi: Kipas aktif jika salah satu sensor >= threshold)
    status_kipas = (temp_fl >= threshold_warn || temp_fr >= threshold_warn || temp_rc >= threshold_warn);
    digitalWrite(FAN_PIN, status_kipas ? HIGH : LOW);

    // 2 & 3. Kontrol Kelembapan Berdasarkan Asupan Dingin Depan (Intake Average: Cold Aisle)
    // Sesuai standar ASHRAE, kelembapan diukur pada udara masuk ke server.
    // Diberi logika mutually exclusive agar Humidifier dan Dehumidifier TIDAK PERNAH aktif bersamaan.
    float hum_intake = (hum_fl + hum_fr) / 2.0;

    if (hum_intake < threshold_hum_low) {
      status_humidifier = true;    // Terlalu kering -> aktifkan penyemprot uap (Anti-ESD)
      status_dehumidifier = false; // Matikan pengering
    } else if (hum_intake > threshold_hum_high) {
      status_humidifier = false;   // Matikan penyemprot uap
      status_dehumidifier = true;  // Terlalu lembap -> aktifkan pengering udara (Anti-Kondensasi)
    } else {
      // Kondisi ideal (40% - 70% RH): Kedua aktuator mati
      status_humidifier = false;
      status_dehumidifier = false;
    }

    digitalWrite(HUMIDIFIER_PIN, status_humidifier ? HIGH : LOW);
    digitalWrite(DEHUMIDIFIER_PIN, status_dehumidifier ? HIGH : LOW);

    // ================================================
    // DISPLAY LCD
    // ================================================
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.printf("L:%.0f R:%.0f B:%.0fC", temp_fl, temp_fr, temp_rc);

    lcd.setCursor(0, 1);
    // Tampilkan status aktuator: F:Fan, H:Humidifier, D:Dehumidifier
    lcd.printf("F:%s H:%s D:%s", 
      status_kipas ? "ON" : "--", 
      status_humidifier ? "ON" : "--", 
      status_dehumidifier ? "ON" : "--"
    );

    // ================================================
    // LOG SERIAL MONITOR
    // ================================================
    Serial.println("-------------------------------------");
    Serial.printf("FL: %.1f C | %.1f %%\n", temp_fl, hum_fl);
    Serial.printf("FR: %.1f C | %.1f %%\n", temp_fr, hum_fr);
    Serial.printf("RC: %.1f C | %.1f %%\n", temp_rc, hum_rc);
    Serial.printf("Kipas: %s | Humidifier: %s | Dehumidifier: %s\n",
      status_kipas ? "ON" : "OFF",
      status_humidifier ? "ON" : "OFF",
      status_dehumidifier ? "ON" : "OFF"
    );

    // ================================================
    // KIRIM RAW DATA & STATUS AKTUATOR KE FIREBASE
    // ================================================
    FirebaseJson json;
    json.set("device", "WEMOS_ESP32_RakUtama");
    json.set("temp_fl", temp_fl);
    json.set("hum_fl", hum_fl);
    json.set("temp_fr", temp_fr);
    json.set("hum_fr", hum_fr);
    json.set("temp_rc", temp_rc);
    json.set("hum_rc", hum_rc);
    
    // Status aktuator
    json.set("fan", status_kipas);
    json.set("humidifier", status_humidifier);
    json.set("dehumidifier", status_dehumidifier);

    // Threshold acuan
    json.set("threshold", threshold_warn);
    json.set("threshold_hum_low", threshold_hum_low);
    json.set("threshold_hum_high", threshold_hum_high);

    json.set("ts/.sv", "timestamp");

    Firebase.RTDB.setJSON(&fbdo, "monitoring/latest", &json);
    Firebase.RTDB.pushJSON(&fbdo, "monitoring/history", &json);
  }
}
