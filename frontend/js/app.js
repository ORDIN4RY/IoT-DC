import { initializeApp } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js";
import { getDatabase, ref, onValue, set, query, orderByChild, startAt } from "https://www.gstatic.com/firebasejs/10.4.0/firebase-database.js";

// =====================================================
// FIREBASE CONFIG
// =====================================================
const firebaseConfig = {
  apiKey: "c8MIMltru5M9UVZYBicpaeGvhDONJZA5EMpN9uAQ",
  databaseURL: "https://iot-minggu6-623b2-default-rtdb.asia-southeast1.firebasedatabase.app"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const $ = id => document.getElementById(id);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// =====================================================
// THEME TOGGLE (light / dark / auto)
// =====================================================
function applyTheme(theme) {
  const root = document.documentElement;
  const btn = $('theme-btn');
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
    btn.textContent = '☾ Dark';
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
    btn.textContent = '☀ Light';
  } else {
    root.removeAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    btn.textContent = prefersDark ? '☾ Auto' : '☀ Auto';
  }
}

window.toggleTheme = function() {
  const current = localStorage.getItem('theme');
  let next;
  if (current === 'light') next = 'dark';
  else if (current === 'dark') next = 'auto';
  else next = 'light';
  localStorage.setItem('theme', next);
  applyTheme(next === 'auto' ? null : next);
};

// Apply saved theme on load
const savedTheme = localStorage.getItem('theme');
applyTheme(savedTheme === 'light' ? 'light' : savedTheme === 'dark' ? 'dark' : null);

// =====================================================
// NAVIGATION TABS
// =====================================================
const navLinks = $('nav').querySelectorAll('a');
const pages = document.querySelectorAll('.page');
const headings = {
  '#dash': 'Dashboard',
  '#hist': 'Riwayat & Grafik',
  '#set': 'Pengaturan Lingkungan'
};

navLinks.forEach(a => {
  a.onclick = e => {
    e.preventDefault();
    navLinks.forEach(n => n.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));
    
    a.classList.add('active');
    const targetId = a.getAttribute('href');
    $(targetId.slice(1)).classList.add('active');
    $('page-heading').textContent = headings[targetId] || 'Dashboard';
  };
});

// =====================================================
// SETTINGS
// =====================================================
let currentSettings = {
  warn: 28,
  bad: 32,
  hum_low: 40,
  hum_high: 70
};

onValue(ref(db, 'monitoring/settings'), snapshot => {
  const data = snapshot.val();
  if (data) {
    currentSettings = {
      warn: Number(data.warn) || 28,
      bad: Number(data.bad) || 32,
      hum_low: Number(data.hum_low) || 40,
      hum_high: Number(data.hum_high) || 70
    };
    if ($('t-warn')) $('t-warn').value = currentSettings.warn;
    if ($('t-bad')) $('t-bad').value = currentSettings.bad;
    if ($('t-hum-low')) $('t-hum-low').value = currentSettings.hum_low;
    if ($('t-hum-high')) $('t-hum-high').value = currentSettings.hum_high;
  }
});

window.saveThresh = function() {
  const warn = Number($('t-warn').value);
  const bad = Number($('t-bad').value);
  const hum_low = Number($('t-hum-low').value);
  const hum_high = Number($('t-hum-high').value);

  if (warn >= bad) {
    alert('Batas waspada suhu harus lebih kecil dari batas bahaya');
    return;
  }
  if (hum_low >= hum_high) {
    alert('Batas minimum kelembapan harus lebih kecil dari batas maksimum');
    return;
  }

  const feedback = $('save-msg');
  feedback.textContent = 'Menyimpan...';

  set(ref(db, 'monitoring/settings'), { warn, bad, hum_low, hum_high })
    .then(() => {
      feedback.textContent = 'Tersimpan';
      setTimeout(() => { feedback.textContent = ''; }, 2500);
    })
    .catch(err => {
      feedback.textContent = 'Gagal: ' + err.message;
    });
};

// =====================================================
// REALTIME DATA & CLIENT-SIDE CALCULATION
// =====================================================
onValue(ref(db, 'monitoring/latest'), snapshot => {
  const data = snapshot.val();
  const connPill = $('conn-pill');

  if (!data) {
    connPill.className = 'badge b-off';
    connPill.textContent = 'No Data';
    return;
  }

  const t_fl = Number(data.temp_fl ?? data.temp ?? 0);
  const h_fl = Number(data.hum_fl ?? data.hum ?? 0);
  const t_fr = Number(data.temp_fr ?? data.temp ?? 0);
  const h_fr = Number(data.hum_fr ?? data.hum ?? 0);
  const t_rc = Number(data.temp_rc ?? data.temp ?? 0);
  const h_rc = Number(data.hum_rc ?? data.hum ?? 0);

  // Status Aktuator
  const fanActive = Boolean(data.fan);
  const humActive = Boolean(data.humidifier);
  const dehumActive = Boolean(data.dehumidifier);
  const timestamp = Number(data.ts) || Date.now();

  // Kalkulasi di Frontend
  const intakeAvg = (t_fl + t_fr) / 2;
  const tempMax = Math.max(t_fl, t_fr, t_rc);
  const deltaT = t_rc - intakeAvg;

  // Evaluasi Kelembapan Berdasarkan Intake Depan (Cold Aisle Sesuai ASHRAE)
  const humIntake = (h_fl + h_fr) / 2;
  let rhStatus = `Optimal (${humIntake.toFixed(0)}%)`;
  if (humIntake < currentSettings.hum_low) {
    rhStatus = `Kering (${humIntake.toFixed(0)}%) - ESD Risk`;
  } else if (humIntake > currentSettings.hum_high) {
    rhStatus = `Lembap (${humIntake.toFixed(0)}%) - Kondensasi`;
  }

  // Evaluasi Status Sistem
  let sysState = 'NORMAL';
  let sysBadge = 'b-ok';
  if (tempMax >= currentSettings.bad || rhStatus.includes('Kondensasi')) {
    sysState = 'BAHAYA';
    sysBadge = 'b-bad';
  } else if (tempMax >= currentSettings.warn || rhStatus.includes('ESD Risk')) {
    sysState = 'WASPADA';
    sysBadge = 'b-warn';
  }

  const isOnline = (Date.now() - timestamp) < 180000;
  if (!isOnline) {
    sysState = 'OFFLINE';
    sysBadge = 'b-off';
  }

  connPill.className = `badge ${isOnline ? 'b-ok' : 'b-off'}`;
  connPill.textContent = isOnline ? 'Online' : 'Offline';

  $('upd').textContent = new Date(timestamp).toLocaleTimeString('id-ID');

  // KPI Card 1: Intake
  $('intake-avg').textContent = intakeAvg.toFixed(1);
  $('m-tfl').textContent = t_fl.toFixed(1);
  $('m-hfl').textContent = h_fl.toFixed(0);
  $('m-tfr').textContent = t_fr.toFixed(1);
  $('m-hfr').textContent = h_fr.toFixed(0);

  // KPI Card 2: Exhaust
  $('m-trc').textContent = t_rc.toFixed(1);
  $('m-hrc').textContent = h_rc.toFixed(0);
  $('m-delta').textContent = `+${deltaT.toFixed(1)}`;

  // KPI Card 3: Aktuator Status
  $('d-st').className = `badge ${sysBadge}`;
  $('d-st').textContent = sysState;
  $('m-tmax').textContent = tempMax.toFixed(1);
  $('rh-status-text').textContent = rhStatus;

  // Aktuator Badges
  const elFan = $('val-act-fan');
  elFan.className = fanActive ? 'badge b-bad' : 'badge b-off';
  elFan.textContent = fanActive ? 'ON' : 'OFF';

  const elHum = $('val-act-hum');
  elHum.className = humActive ? 'badge b-cold' : 'badge b-off';
  elHum.textContent = humActive ? 'ON' : 'OFF';

  const elDehum = $('val-act-dehum');
  elDehum.className = dehumActive ? 'badge b-warn' : 'badge b-off';
  elDehum.textContent = dehumActive ? 'ON' : 'OFF';

  // Denah Visual
  $('v-tfl').textContent = t_fl.toFixed(1);
  $('v-hfl').textContent = h_fl.toFixed(0);
  $('node-fl').className = `sensor-box ${t_fl >= currentSettings.bad ? 'bad' : (t_fl >= currentSettings.warn ? 'warn' : '')}`;

  $('v-tfr').textContent = t_fr.toFixed(1);
  $('v-hfr').textContent = h_fr.toFixed(0);
  $('node-fr').className = `sensor-box ${t_fr >= currentSettings.bad ? 'bad' : (t_fr >= currentSettings.warn ? 'warn' : '')}`;

  $('v-trc').textContent = t_rc.toFixed(1);
  $('v-hrc').textContent = h_rc.toFixed(0);
  $('node-rc').className = `sensor-box ${t_rc >= currentSettings.bad ? 'bad' : (t_rc >= currentSettings.warn ? 'warn' : '')}`;

  $('v-delta-val').textContent = `+${deltaT.toFixed(1)} °C`;

  // Aktuator Sub-Boxes di Denah
  const vTxtHum = $('v-txt-hum');
  vTxtHum.className = humActive ? 'badge b-cold' : 'badge b-off';
  vTxtHum.textContent = humActive ? 'ON (MIST)' : 'OFF';

  const vTxtFan = $('v-txt-fan');
  vTxtFan.className = fanActive ? 'badge b-bad' : 'badge b-off';
  vTxtFan.textContent = fanActive ? 'ON' : 'OFF';

  const vTxtDehum = $('v-txt-dehum');
  vTxtDehum.className = dehumActive ? 'badge b-warn' : 'badge b-off';
  vTxtDehum.textContent = dehumActive ? 'ON (DRY)' : 'OFF';
});

// =====================================================
// HISTORY CHART & ALERT LOG
// =====================================================
function updateHistory() {
  const hrs = Number($('rng').value) || 24;
  const timeLimit = Date.now() - hrs * 3600000;

  const historyQuery = query(
    ref(db, 'monitoring/history'),
    orderByChild('ts'),
    startAt(timeLimit)
  );

  onValue(historyQuery, snapshot => {
    const records = [];
    snapshot.forEach(child => {
      records.push(child.val());
    });

    const chart = $('chart');
    if (records.length < 2) {
      chart.innerHTML = '<text x="400" y="110" text-anchor="middle" fill="var(--mute)" font-size="12">Belum cukup data</text>';
      return;
    }

    const t0 = records[0].ts;
    const t1 = records[records.length - 1].ts;
    const coordX = v => ((v - t0) / (t1 - t0 || 1)) * 770 + 15;

    const minT = 15;
    const maxT = 45;
    const coordY = temp => 180 - clamp((temp - minT) / (maxT - minT), 0, 1) * 160;

    const buildPath = (key, fallbackKey) => {
      const pts = records.map(r => {
        const val = Number(r[key] ?? r[fallbackKey] ?? 0);
        return `${coordX(r.ts).toFixed(1)},${coordY(val).toFixed(1)}`;
      });
      return pts.join(' ');
    };

    const gridLevels = [20, 30, 40];
    const gridLines = gridLevels.map(temp => {
      const y = coordY(temp);
      return `
        <line x1="15" x2="785" y1="${y}" y2="${y}" stroke="var(--line)" stroke-width="1"/>
        <text x="18" y="${y - 4}" fill="var(--mute)" font-size="9">${temp}°C</text>
      `;
    }).join('');

    const polyFL = `<polyline fill="none" stroke="var(--cold)" stroke-width="2" vector-effect="non-scaling-stroke" points="${buildPath('temp_fl', 'temp')}"/>`;
    const polyFR = `<polyline fill="none" stroke="#818cf8" stroke-width="2" vector-effect="non-scaling-stroke" points="${buildPath('temp_fr', 'temp')}"/>`;
    const polyRC = `<polyline fill="none" stroke="var(--hot)" stroke-width="2" vector-effect="non-scaling-stroke" points="${buildPath('temp_rc', 'temp')}"/>`;

    chart.innerHTML = gridLines + polyFL + polyFR + polyRC;

    // Log Peringatan Suhu & Kelembapan
    const alerts = [];
    records.forEach(r => {
      const t_fl = Number(r.temp_fl ?? r.temp ?? 0);
      const t_fr = Number(r.temp_fr ?? r.temp ?? 0);
      const t_rc = Number(r.temp_rc ?? r.temp ?? 0);
      const h_fl = Number(r.hum_fl ?? r.hum ?? 0);
      const h_fr = Number(r.hum_fr ?? r.hum ?? 0);
      const h_rc = Number(r.hum_rc ?? r.hum ?? 0);
      const maxT = Math.max(t_fl, t_fr, t_rc);

      if (maxT >= currentSettings.warn) {
        alerts.push({
          ts: r.ts,
          type: 'Suhu Panas',
          pos: maxT === t_fl ? 'FL (Kiri)' : (maxT === t_fr ? 'FR (Kanan)' : 'RC (Belakang)'),
          val: `${maxT.toFixed(1)}°C`,
          status: maxT >= currentSettings.bad ? 'BAHAYA' : 'WASPADA'
        });
      }

      const h_intake = (h_fl + h_fr) / 2;
      if (h_intake < currentSettings.hum_low) {
        alerts.push({
          ts: r.ts,
          type: 'RH Rendah (ESD)',
          pos: 'Intake Depan',
          val: `${h_intake.toFixed(0)}%`,
          status: 'WASPADA'
        });
      } else if (h_intake > currentSettings.hum_high) {
        alerts.push({
          ts: r.ts,
          type: 'RH Tinggi (Kondensasi)',
          pos: 'Intake Depan',
          val: `${h_intake.toFixed(0)}%`,
          status: 'BAHAYA'
        });
      }
    });

    const alertLog = $('alert-log');
    if (alerts.length > 0) {
      alertLog.innerHTML = alerts.slice(-10).reverse().map(a => `
        <tr>
          <td>${new Date(a.ts).toLocaleTimeString('id-ID')}</td>
          <td>${a.type}</td>
          <td>${a.pos}</td>
          <td><strong>${a.val}</strong></td>
          <td><span class="badge ${a.status === 'BAHAYA' ? 'b-bad' : 'b-warn'}">${a.status}</span></td>
        </tr>
      `).join('');
    } else {
      alertLog.innerHTML = '<tr><td colspan="5" class="empty">Semua kondisi lingkungan normal</td></tr>';
    }

    // CSV Export
    $('csv').onclick = e => {
      e.preventDefault();
      let csv = "Timestamp,FL_T,FL_RH,FR_T,FR_RH,RC_T,RC_RH,Delta_T,Fan,Humidifier,Dehumidifier\n";
      records.forEach(r => {
        const t_fl = Number(r.temp_fl ?? r.temp ?? 0);
        const h_fl = Number(r.hum_fl ?? r.hum ?? 0);
        const t_fr = Number(r.temp_fr ?? r.temp ?? 0);
        const h_fr = Number(r.hum_fr ?? r.hum ?? 0);
        const t_rc = Number(r.temp_rc ?? r.temp ?? 0);
        const h_rc = Number(r.hum_rc ?? r.hum ?? 0);
        const delta = t_rc - ((t_fl + t_fr) / 2);
        csv += `${new Date(r.ts).toISOString()},${t_fl.toFixed(1)},${h_fl.toFixed(1)},${t_fr.toFixed(1)},${h_fr.toFixed(1)},${t_rc.toFixed(1)},${h_rc.toFixed(1)},${delta.toFixed(1)},${r.fan ? 'ON' : 'OFF'},${r.humidifier ? 'ON' : 'OFF'},${r.dehumidifier ? 'ON' : 'OFF'}\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `datacenter_environment_log_${hrs}h.csv`;
      a.click();
    };
  });
}

$('rng').onchange = updateHistory;
updateHistory();
