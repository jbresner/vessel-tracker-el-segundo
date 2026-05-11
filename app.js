// ── Constants ──────────────────────────────────────────────────────────────
// Berth coordinates derived from actual vessel positions observed at the terminal
const BERTH3 = { lat: 33.9116, lng: -118.4533, name: "Chevron Berth 3 (CBM)" };
const BERTH4 = { lat: 33.9041, lng: -118.4521, name: "Chevron Berth 4 (CBM)" };

// Center point between the two berths — used for radius circle and bounding box
const TARGET = {
  lat: (BERTH3.lat + BERTH4.lat) / 2,
  lng: (BERTH3.lng + BERTH4.lng) / 2,
};
const TARGET_NAME = "Chevron El Segundo Terminal";

// ── AIS Helpers ────────────────────────────────────────────────────────────

/**
 * Map AIS ship type code to internal category string.
 * @param {number|string} typeCode
 * @returns {string}
 */
function classifyShip(typeCode) {
  const t = parseInt(typeCode);
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 70 && t <= 79) return 'cargo';
  if (t >= 60 && t <= 69) return 'passenger';
  if (t === 30)            return 'fishing';
  if (t >= 20 && t <= 29) return 'tug';
  return 'other';
}

/**
 * Human-readable label for AIS ship type code.
 * @param {number|string} typeCode
 * @returns {string}
 */
function shipTypeLabel(typeCode) {
  const t = parseInt(typeCode);
  if (t >= 80 && t <= 89) return 'TANKER';
  if (t >= 70 && t <= 79) return 'CARGO';
  if (t >= 60 && t <= 69) return 'PASSENGER';
  if (t === 30)            return 'FISHING';
  if (t >= 20 && t <= 29) return 'TUG/SUPPLY';
  if (t === 0)             return 'UNKNOWN';
  return `TYPE ${t}`;
}

/**
 * Human-readable navigational status label.
 * @param {number} s
 * @returns {string}
 */
function navStatusLabel(s) {
  const labels = {
    0:  'Under way (engine)',
    1:  'At anchor',
    2:  'Not under command',
    3:  'Restricted maneuverability',
    4:  'Constrained by draft',
    5:  'Moored',
    6:  'Aground',
    7:  'Engaged in fishing',
    8:  'Under way (sailing)',
    15: 'Undefined',
  };
  return labels[s] || `Status ${s}`;
}

// ── Map Setup ──────────────────────────────────────────────────────────────
// ── Map Setup ──────────────────────────────────────────────────────────────
const isMobile = () => window.innerWidth <= 768;
const mapId    = isMobile() ? 'mobileMap' : 'map';
const map      = L.map(mapId, { zoomControl: true }).setView([TARGET.lat, TARGET.lng], 13);

// Primary: CARTO dark tiles
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19,
}).addTo(map);

// Berth markers
function makeBerthIcon(label) {
  return L.divIcon({
    html: `<div style="
      background: transparent;
      border: 1px dashed #ff6b2b;
      border-radius: 3px;
      font-family:'Share Tech Mono',monospace;font-size:9px;
      color:#ff6b2b;padding:2px 5px;white-space:nowrap;
    ">${label}</div>`,
    iconSize: [60, 20],
    iconAnchor: [30, 10],
    className: 'berth-icon',
  });
}

L.marker([BERTH3.lat, BERTH3.lng], { icon: makeBerthIcon('BERTH 3') })
  .bindPopup(`<b>${BERTH3.name}</b><br>Crude oil & light products<br>~7,200ft offshore`)
  .addTo(map);

L.marker([BERTH4.lat, BERTH4.lng], { icon: makeBerthIcon('BERTH 4') })
  .bindPopup(`<b>${BERTH4.name}</b><br>Crude oil<br>~8,100ft offshore`)
  .addTo(map);

// ── Radius Circle ──────────────────────────────────────────────────────────
let radiusNm = 5;
let radiusCircle = null;

function nmToMeters(nm) { return nm * 1852; }

function drawRadius() {
  if (radiusCircle) map.removeLayer(radiusCircle);
  radiusCircle = L.circle([TARGET.lat, TARGET.lng], {
    radius:      nmToMeters(radiusNm),
    color:       '#00d4ff',
    fillColor:   '#00d4ff',
    fillOpacity: 0.04,
    weight:      1,
    dashArray:   '4 4',
  }).addTo(map);
}
drawRadius();

function updateRadius(val) {
  radiusNm = parseInt(val);
  const label = `${radiusNm} nm`;
  document.getElementById('radiusVal').textContent  = label;
  const mRV = document.getElementById('mRadiusVal');
  if (mRV) mRV.textContent = label;
  drawRadius();
  if (ws && ws.readyState === WebSocket.OPEN) reconnect();
}

/** Return [[minLat, minLng], [maxLat, maxLng]] bounding box around the terminal. */
function getBBox() {
  const latDelta = radiusNm / 60;
  const lngDelta = radiusNm / (60 * Math.cos(TARGET.lat * Math.PI / 180));
  return [
    [TARGET.lat - latDelta, TARGET.lng - lngDelta],
    [TARGET.lat + latDelta, TARGET.lng + lngDelta],
  ];
}

// ── API Key — paste yours here ─────────────────────────────────────────────
const API_KEY = '10080153f843a89b71fe420464f47ba9d5b123e1';

// ── Application State ──────────────────────────────────────────────────────
let ws           = null;      // active WebSocket
let vessels      = {};        // mmsi → vessel data object
let markers      = {};        // mmsi → Leaflet marker
let selectedMmsi = null;      // currently selected vessel
let logEntries   = [];        // activity log entries

// ── WebSocket Connection ───────────────────────────────────────────────────
function toggleConnection() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    disconnect();
  } else {
    connect();
  }
}

function reconnect() {
  disconnect();
  setTimeout(connect, 500);
}

function connect() {
  const key = API_KEY;
  if (!key || key === 'YOUR_API_KEY_HERE') {
    alert('Please set your API key in app.js (API_KEY constant near the top).');
    return;
  }

  setStatus('connecting');
  const bbox = getBBox();
  console.log('[AIS] Connecting with bounding box:', JSON.stringify(bbox));

  ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

  ws.onopen = () => {
    const sub = {
      APIKey: key,
      BoundingBoxes: [bbox],
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    };
    ws.send(JSON.stringify(sub));
    console.log('[AIS] Subscribed:', JSON.stringify(sub));
    setStatus('live');
    document.getElementById('connectBtn').textContent = 'STOP';
    document.getElementById('connectBtn').classList.add('stop');
    addLog('Connected to AISStream', false);
  };

  ws.onmessage = async (evt) => {
    try {
      let text;
      if (evt.data instanceof Blob) {
        text = await evt.data.text();
      } else {
        text = evt.data;
      }
      console.log('[AIS] Raw data type:', typeof evt.data, evt.data instanceof Blob ? 'Blob' : 'not Blob');
      console.log('[AIS] Raw text:', text.substring(0, 200));
      const msg = JSON.parse(text);
      console.log('[AIS] Message received:', msg.MessageType, msg.MetaData?.ShipName, msg.MetaData?.MMSI);
      handleMessage(msg);
    } catch (e) {
      console.error('Parse error:', e, typeof evt.data);
    }
  };

  ws.onerror = (e) => {
    console.error('[AIS] WebSocket error:', e);
    setStatus('error');
    addLog('Connection error', true);
  };

  ws.onclose = () => {
    if (document.getElementById('statusText').textContent === 'LIVE') {
      setStatus('disconnected');
    } else {
      setStatus('disconnected');
    }
  };
}

function disconnect() {
  if (ws) { ws.close(); ws = null; }
  setStatus('disconnected');
  document.getElementById('connectBtn').textContent = 'CONNECT';
  document.getElementById('connectBtn').classList.remove('stop');
}

// ── Message Handling ───────────────────────────────────────────────────────
function handleMessage(msg) {
  const type = msg.MessageType;
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;

  if (type === 'PositionReport') {
    const p   = msg.Message?.PositionReport || {};
    const lat = p.Latitude  ?? meta.latitude_degrees;
    const lng = p.Longitude ?? meta.longitude_degrees;
    if (!lat || !lng) return;

    vessels[mmsi] = {
      ...(vessels[mmsi] || {}),
      mmsi,
      lat,
      lng,
      sog:       p.Sog,
      cog:       p.Cog,
      heading:   p.TrueHeading,
      navStatus: p.NavigationalStatus,
      name:      meta.ShipName?.trim() || vessels[mmsi]?.name || `MMSI ${mmsi}`,
      lastSeen:  new Date(),
    };
    updateMarker(mmsi);
    updateList();
    if (mmsi === selectedMmsi) showDetail(mmsi);
  }

  if (type === 'ShipStaticData') {
    const s        = msg.Message?.ShipStaticData || {};
    const existing = vessels[mmsi] || {};
    const name     = (s.Name || meta.ShipName || existing.name || `MMSI ${mmsi}`).trim();
    const cat      = classifyShip(s.Type || 0);
    const wasNew   = !existing.name || existing.name.startsWith('MMSI');

    vessels[mmsi] = {
      ...existing,
      mmsi,
      name,
      callsign:    s.CallSign?.trim(),
      shipType:    s.Type,
      category:    cat,
      destination: s.Destination?.trim(),
      imo:         s.ImoNumber,
      flag:        s.Flag,
      dimA:        s.Dimension?.A,
      dimB:        s.Dimension?.B,
      dimC:        s.Dimension?.C,
      dimD:        s.Dimension?.D,
      lastSeen:    existing.lastSeen || new Date(),
    };

    if (wasNew && cat === 'tanker') {
      addLog(`TANKER: ${name} (MMSI ${mmsi})`, true);
    } else if (wasNew) {
      addLog(`New vessel: ${name}`, false);
    }

    updateMarker(mmsi);
    updateList();
    if (mmsi === selectedMmsi) showDetail(mmsi);
  }
}

// ── Map Markers ────────────────────────────────────────────────────────────

/**
 * Build an SVG arrow icon rotated to the vessel's heading.
 * @param {number} heading  True heading (0-359) or COG fallback
 * @param {string} category vessel category string
 * @returns {string} SVG markup
 */
function vesselSVG(heading, category) {
  const colors = {
    tanker:    '#ff6b2b',
    cargo:     '#00d4ff',
    other:     '#88aacc',
    passenger: '#88ff88',
    fishing:   '#ffdd44',
    tug:       '#cc88ff',
  };
  const c   = colors[category] || colors.other;
  const rot = (heading && heading < 360) ? heading : 0;
  return `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"
    style="transform:rotate(${rot}deg);transform-origin:center">
    <polygon points="11,2 17,20 11,16 5,20"
      fill="${c}" stroke="#0a0e14" stroke-width="1.5" opacity="0.95"/>
  </svg>`;
}

function updateMarker(mmsi) {
  const v = vessels[mmsi];
  if (!v || !v.lat) return;

  const icon = L.divIcon({
    html:       vesselSVG(v.heading || v.cog, v.category || 'other'),
    iconSize:   [22, 22],
    iconAnchor: [11, 11],
    className:  'vessel-icon',
  });

  if (markers[mmsi]) {
    markers[mmsi].setLatLng([v.lat, v.lng]);
    markers[mmsi].setIcon(icon);
  } else {
    markers[mmsi] = L.marker([v.lat, v.lng], { icon })
      .addTo(map)
      .on('click', () => selectVessel(mmsi));
  }
}

// ── Mobile Sheet ───────────────────────────────────────────────────────────
const isMobile = () => window.innerWidth <= 768;

function toggleSheet() {
  const sheet = document.getElementById('mSheet');
  if (!sheet) return;
  if (sheet.classList.contains('full')) {
    sheet.classList.remove('full');
  } else if (sheet.classList.contains('open')) {
    sheet.classList.add('full');
  } else {
    sheet.classList.add('open');
  }
}

function openSheet() {
  const sheet = document.getElementById('mSheet');
  if (sheet && !sheet.classList.contains('open')) sheet.classList.add('open');
}

function showMobileList() {
  const lv = document.getElementById('mListView');
  const dv = document.getElementById('mDetailView');
  if (lv) lv.style.display = 'flex';
  if (dv) dv.style.display = 'none';
}

function showMobileDetail() {
  const lv = document.getElementById('mListView');
  const dv = document.getElementById('mDetailView');
  if (lv) lv.style.display = 'none';
  if (dv) dv.style.display = 'flex';
  openSheet();
}

function vesselItemHTML(v, onClickFn) {
  const cat   = v.category || 'other';
  const badge = cat === 'tanker' ? 'badge-tanker' : cat === 'cargo' ? 'badge-cargo' : 'badge-other';
  const label = shipTypeLabel(v.shipType || 0);
  const sog   = v.sog != null ? `${v.sog.toFixed(1)}kn` : '—';
  const sel   = v.mmsi === selectedMmsi ? ' selected' : '';
  const dest  = v.destination ? `<span title="${v.destination}">${v.destination.substring(0,10)}</span>` : '';
  return `<div class="vessel-item ${cat}${sel}" onclick="${onClickFn}('${v.mmsi}')">
    <div class="vessel-name">${v.name}</div>
    <div class="vessel-meta">
      <span class="vessel-type-badge ${badge}">${label}</span>
      <span>${sog}</span>${dest}
    </div>
  </div>`;
}

function selectVesselMobile(mmsi) {
  selectedMmsi = mmsi;
  updateList();
  showDetail(mmsi);
  const mBody = document.getElementById('mDetailBody');
  const dBody = document.getElementById('detailBody');
  if (mBody && dBody) mBody.innerHTML = dBody.innerHTML;
  showMobileDetail();
  const v = vessels[mmsi];
  if (v && v.lat) map.panTo([v.lat, v.lng]);
}

// ── Vessel List ────────────────────────────────────────────────────────────
function updateList() {
  const arr = Object.values(vessels)
    .filter(v => v.lat)
    .sort((a,b) => {
      const order = ['tanker','cargo','passenger','fishing','tug','other'];
      return order.indexOf(a.category||'other') - order.indexOf(b.category||'other');
    });

  const count     = arr.length;
  const countText = `${count} VESSEL${count !== 1 ? 'S' : ''}`;
  const emptyHTML = '<div class="no-vessels">Listening for vessels…<br>May take a moment<br>for traffic to appear</div>';

  ['listCount','mListCount'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = count; });
  ['vesselCount','mVesselCount'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = countText; });

  const dList = document.getElementById('vesselList');
  if (dList) dList.innerHTML = count === 0 ? emptyHTML : arr.map(v => vesselItemHTML(v, 'selectVessel')).join('');

  const mList = document.getElementById('mVesselList');
  if (mList) {
    mList.innerHTML = count === 0 ? emptyHTML : arr.map(v => vesselItemHTML(v, 'selectVesselMobile')).join('');
    if (count > 0 && isMobile()) openSheet();
  }
}

// ── Detail Panel ───────────────────────────────────────────────────────────
function selectVessel(mmsi) {
  selectedMmsi = mmsi;
  updateList();
  showDetail(mmsi);
  const v = vessels[mmsi];
  if (v && v.lat) map.panTo([v.lat, v.lng]);
}

function showDetail(mmsi) {
  const v = vessels[mmsi];
  if (!v) return;

  const body      = document.getElementById('detailBody');
  const cat       = v.category || 'other';
  const catColor  = cat === 'tanker' ? 'var(--tanker)' : cat === 'cargo' ? 'var(--accent)' : 'var(--other)';
  const len       = (v.dimA && v.dimB) ? `${parseInt(v.dimA || 0) + parseInt(v.dimB || 0)}m` : '—';
  const wid       = (v.dimC && v.dimD) ? `${parseInt(v.dimC || 0) + parseInt(v.dimD || 0)}m` : '—';
  const navStat   = v.navStatus != null ? navStatusLabel(v.navStatus) : '—';
  const lastSeen  = v.lastSeen ? v.lastSeen.toLocaleTimeString() : '—';
  const moorColor = v.navStatus === 5 ? 'var(--tanker)' : 'var(--text)';

  body.innerHTML = `
    <div style="margin-bottom:14px">
      <div style="font-size:9px;font-family:'Share Tech Mono',monospace;color:${catColor};letter-spacing:2px;margin-bottom:4px">
        ${shipTypeLabel(v.shipType || 0)}
      </div>
      <div class="detail-vessel-name">${v.name}</div>
    </div>

    <div class="detail-field">
      <div class="detail-field-label">MMSI</div>
      <div class="detail-field-value mono">${v.mmsi}</div>
    </div>
    ${v.imo       ? `<div class="detail-field"><div class="detail-field-label">IMO</div><div class="detail-field-value mono">${v.imo}</div></div>` : ''}
    ${v.callsign  ? `<div class="detail-field"><div class="detail-field-label">CALLSIGN</div><div class="detail-field-value mono">${v.callsign}</div></div>` : ''}
    ${v.flag      ? `<div class="detail-field"><div class="detail-field-label">FLAG</div><div class="detail-field-value">${v.flag}</div></div>` : ''}

    <hr class="divider"/>

    <div class="detail-field">
      <div class="detail-field-label">POSITION</div>
      <div class="detail-field-value mono">
        ${v.lat ? v.lat.toFixed(4) : '—'}°N &nbsp;${v.lng ? Math.abs(v.lng).toFixed(4) : '—'}°W
      </div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">SPEED / COURSE</div>
      <div class="detail-field-value mono">
        ${v.sog != null ? v.sog.toFixed(1) + 'kn' : '—'} /
        ${v.cog != null ? Math.round(v.cog) + '°'  : '—'}
      </div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">NAV STATUS</div>
      <div class="detail-field-value" style="color:${moorColor}">${navStat}</div>
    </div>
    ${v.destination ? `<div class="detail-field"><div class="detail-field-label">DESTINATION</div><div class="detail-field-value">${v.destination}</div></div>` : ''}

    <hr class="divider"/>

    <div class="detail-field">
      <div class="detail-field-label">DIMENSIONS</div>
      <div class="detail-field-value mono">${len} × ${wid}</div>
    </div>
    <div class="detail-field">
      <div class="detail-field-label">LAST UPDATED</div>
      <div class="detail-field-value mono">${lastSeen}</div>
    </div>
    <div style="margin-top:12px">
      <a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}"
         target="_blank"
         style="color:var(--accent);font-family:'Share Tech Mono',monospace;font-size:10px;text-decoration:none;letter-spacing:1px">
        ↗ VIEW ON MARINETRAFFIC
      </a>
    </div>
  `;
}

// ── Activity Log ───────────────────────────────────────────────────────────
function addLog(msg, highlight) {
  const time = new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  logEntries.unshift({ time, msg, highlight });
  if (logEntries.length > 50) logEntries.pop();
  const html = logEntries.map(e =>
    `<div class="log-entry${e.highlight?' highlight':''}"><span class="log-time">${e.time}</span>${e.msg}</div>`
  ).join('');
  ['logEntries','mLogEntries'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = html; });
}

// ── Status Indicator ───────────────────────────────────────────────────────
function setStatus(state) {
  const dot  = document.getElementById('statusDot');
  const txt  = document.getElementById('statusText');
  const mDot = document.getElementById('mStatusDot');
  const mTxt = document.getElementById('mStatusText');
  const mBtn = document.getElementById('mConnectBtn');
  const dBtn = document.getElementById('connectBtn');

  if (dot) dot.className = 'status-dot';
  if (mDot) mDot.className = 'status-dot';

  if (state === 'live') {
    [dot, mDot].forEach(d => d && d.classList.add('live'));
    if (txt) txt.textContent = 'LIVE';
    if (mTxt) mTxt.textContent = 'LIVE';
    if (dBtn) { dBtn.textContent = 'STOP'; dBtn.classList.add('stop'); }
    if (mBtn) { mBtn.textContent = 'STOP'; mBtn.classList.add('stop'); }
  } else if (state === 'connecting') {
    if (txt) txt.textContent = 'CONNECTING…';
    if (mTxt) mTxt.textContent = 'CONNECTING…';
  } else if (state === 'error') {
    [dot, mDot].forEach(d => d && d.classList.add('error'));
    if (txt) txt.textContent = 'ERROR';
    if (mTxt) mTxt.textContent = 'ERROR';
  } else {
    if (txt) txt.textContent = 'DISCONNECTED';
    if (mTxt) mTxt.textContent = 'DISCONNECTED';
    if (dBtn) { dBtn.textContent = 'CONNECT'; dBtn.classList.remove('stop'); }
    if (mBtn) { mBtn.textContent = 'CONNECT'; mBtn.classList.remove('stop'); }
  }
}

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  document.getElementById('clockEl').textContent =
    new Date().toLocaleTimeString('en-US', {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' PT';
}
updateClock();
setInterval(updateClock, 1000);

// ── Auto-connect on page load ──────────────────────────────────────────────
window.addEventListener('load', () => {
  // Force Leaflet to recalculate map size (fixes Safari blank map)
  setTimeout(() => map.invalidateSize(), 100);
  connect();
});

// ── Stale Vessel Cleanup ───────────────────────────────────────────────────
// Remove vessels not seen in the last 30 minutes (moored ships ping infrequently)
setInterval(() => {
  const now    = new Date();
  const cutoff = 30 * 60 * 1000;
  Object.keys(vessels).forEach(mmsi => {
    const v = vessels[mmsi];
    if (v.lastSeen && (now - v.lastSeen) > cutoff) {
      if (markers[mmsi]) { map.removeLayer(markers[mmsi]); delete markers[mmsi]; }
      delete vessels[mmsi];
    }
  });
  updateList();
}, 60_000);
