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
const map = L.map('map', { zoomControl: true }).setView([TARGET.lat, TARGET.lng], 13);

// Primary: CARTO dark tiles; fallback keeps working if CARTO is slow
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
  document.getElementById('radiusVal').textContent = `${radiusNm} nm`;
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
let visitHistory = [];        // persistent vessel visit log for CSV export

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
    }
    document.getElementById('connectBtn').textContent = 'CONNECT';
    document.getElementById('connectBtn').classList.remove('stop');
    const mobileBtn = document.getElementById('mobileConnectBtn');
    if (mobileBtn) { mobileBtn.textContent = 'CONNECT'; mobileBtn.classList.remove('stop'); }
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
      logVisit(vessels[mmsi]);
    } else if (wasNew) {
      addLog(`New vessel: ${name}`, false);
      logVisit(vessels[mmsi]);
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

const SNAP_PEEK = 52;
const SNAP_HALF = Math.round(window.innerHeight * 0.50);
const SNAP_FULL = Math.round(window.innerHeight * 0.88);

function snapSheet(targetH, animate = true) {
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  if (animate) sheet.classList.remove('dragging');
  else         sheet.classList.add('dragging');
  sheet.style.height = targetH + 'px';
}

function expandSheet() {
  snapSheet(SNAP_HALF);
}

// Drag-to-snap logic on the handle
window.addEventListener('load', () => {
  const handle = document.getElementById('sheetHandle');
  const sheet  = document.getElementById('sheet');
  if (!handle || !sheet) return;

  let startY      = 0;
  let startH      = 0;
  let dragging    = false;

  function onStart(e) {
    startY   = e.touches ? e.touches[0].clientY : e.clientY;
    startH   = sheet.offsetHeight;
    dragging = true;
    sheet.classList.add('dragging');
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const y      = e.touches ? e.touches[0].clientY : e.clientY;
    const delta  = startY - y;
    const newH   = Math.max(SNAP_PEEK, Math.min(SNAP_FULL, startH + delta));
    sheet.style.height = newH + 'px';
    e.preventDefault();
  }

  function onEnd(e) {
    if (!dragging) return;
    dragging = false;
    const currentH = sheet.offsetHeight;
    // Snap to nearest position
    const distances = [
      { h: SNAP_PEEK, d: Math.abs(currentH - SNAP_PEEK) },
      { h: SNAP_HALF, d: Math.abs(currentH - SNAP_HALF) },
      { h: SNAP_FULL, d: Math.abs(currentH - SNAP_FULL) },
    ];
    const snap = distances.reduce((a, b) => a.d < b.d ? a : b);
    snapSheet(snap.h, true);
  }

  handle.addEventListener('touchstart', onStart, { passive: false });
  handle.addEventListener('touchmove',  onMove,  { passive: false });
  handle.addEventListener('touchend',   onEnd);
  handle.addEventListener('mousedown',  onStart);
  window.addEventListener('mousemove',  onMove);
  window.addEventListener('mouseup',    onEnd);

  // Tap (without drag) cycles peek → half → full → peek
  handle.addEventListener('click', () => {
    const h = sheet.offsetHeight;
    if      (h <= SNAP_PEEK + 10) snapSheet(SNAP_HALF);
    else if (h <= SNAP_HALF + 10) snapSheet(SNAP_FULL);
    else                          snapSheet(SNAP_PEEK);
  });
});

function showMobileList() {
  document.getElementById('sheetListView').style.display = 'flex';
  document.getElementById('sheetDetailView').style.display = 'none';
}

function showMobileDetail() {
  document.getElementById('sheetListView').style.display = 'none';
  document.getElementById('sheetDetailView').style.display = 'flex';
  snapSheet(SNAP_HALF);
}

function vesselItemHTML(v, isMobileList) {
  const cat   = v.category || 'other';
  const badge = cat === 'tanker' ? 'badge-tanker' : cat === 'cargo' ? 'badge-cargo' : 'badge-other';
  const label = shipTypeLabel(v.shipType || 0);
  const sog   = v.sog != null ? `${v.sog.toFixed(1)}kn` : '—';
  const sel   = v.mmsi === selectedMmsi ? ' selected' : '';
  const dest  = v.destination ? `<span title="${v.destination}">${v.destination.substring(0, 10)}</span>` : '';
  const fn    = isMobileList ? `selectVesselMobile('${v.mmsi}')` : `selectVessel('${v.mmsi}')`;
  return `<div class="vessel-item ${cat}${sel}" onclick="${fn}">
    <div class="vessel-name">${v.name}</div>
    <div class="vessel-meta">
      <span class="vessel-type-badge ${badge}">${label}</span>
      <span>${sog}</span>
      ${dest}
    </div>
  </div>`;
}

function selectVesselMobile(mmsi) {
  selectedMmsi = mmsi;
  updateList();
  showMobileDetail();
  const v = vessels[mmsi];
  const mobileBody = document.getElementById('mobileDetailBody');
  if (v) {
    const desktopBody = document.getElementById('detailBody');
    showDetail(mmsi); // populates desktopBody
    mobileBody.innerHTML = desktopBody.innerHTML;
  }
  if (v && v.lat) map.panTo([v.lat, v.lng]);
}

// ── Vessel List ────────────────────────────────────────────────────────────
function updateList() {
  const arr = Object.values(vessels)
    .filter(v => v.lat)
    .sort((a, b) => {
      const order = ['tanker', 'cargo', 'passenger', 'fishing', 'tug', 'other'];
      return order.indexOf(a.category || 'other') - order.indexOf(b.category || 'other');
    });

  const count = arr.length;
  document.getElementById('listCount').textContent      = count;
  document.getElementById('sheetListCount').textContent = count;
  document.getElementById('vesselCount').textContent    = `${count} VESSEL${count !== 1 ? 'S' : ''}`;

  const emptyHTML = '<div class="no-vessels">Listening for vessels…<br>May take a moment<br>for traffic to appear</div>';

  // Desktop list
  const list = document.getElementById('vesselList');
  list.innerHTML = count === 0 ? emptyHTML : arr.map(v => vesselItemHTML(v, false)).join('');

  // Mobile list — update silently, never force open
  const mobileList = document.getElementById('mobileVesselList');
  if (mobileList) {
    mobileList.innerHTML = count === 0 ? emptyHTML : arr.map(v => vesselItemHTML(v, true)).join('');
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
  const time = new Date().toLocaleTimeString('en-US', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  logEntries.unshift({ time, msg, highlight });
  if (logEntries.length > 50) logEntries.pop();

  const html = logEntries
    .map(e => `<div class="log-entry${e.highlight ? ' highlight' : ''}">
      <span class="log-time">${e.time}</span>${e.msg}
    </div>`)
    .join('');

  document.getElementById('logEntries').innerHTML = html;
  const mobileLog = document.getElementById('mobileLogEntries');
  if (mobileLog) mobileLog.innerHTML = html;
}

// ── Status Indicator ───────────────────────────────────────────────────────
function setStatus(state) {
  const dot      = document.getElementById('statusDot');
  const txt      = document.getElementById('statusText');
  const mobileBtn = document.getElementById('mobileConnectBtn');
  dot.className  = 'status-dot';

  if (state === 'live') {
    dot.classList.add('live');
    txt.textContent = 'LIVE';
    if (mobileBtn) { mobileBtn.textContent = 'STOP'; mobileBtn.classList.add('stop'); }
  } else if (state === 'connecting') {
    txt.textContent = 'CONNECTING…';
  } else if (state === 'error') {
    dot.classList.add('error');
    txt.textContent = 'ERROR';
  } else {
    txt.textContent = 'DISCONNECTED';
    if (mobileBtn) { mobileBtn.textContent = 'CONNECT'; mobileBtn.classList.remove('stop'); }
  }
}

// ── Vessel Visit History ───────────────────────────────────────────────────
function logVisit(v) {
  visitHistory.push({
    timestamp:   new Date().toISOString(),
    name:        v.name || '',
    mmsi:        v.mmsi || '',
    imo:         v.imo || '',
    type:        shipTypeLabel(v.shipType || 0),
    category:    v.category || '',
    flag:        v.flag || '',
    callsign:    v.callsign || '',
    destination: v.destination || '',
    speed:       v.sog != null ? v.sog.toFixed(1) : '',
    navStatus:   v.navStatus != null ? navStatusLabel(v.navStatus) : '',
    lat:         v.lat != null ? v.lat.toFixed(6) : '',
    lng:         v.lng != null ? v.lng.toFixed(6) : '',
  });
}

function downloadCSV() {
  if (visitHistory.length === 0) {
    alert('No vessel history to export yet.');
    return;
  }
  const headers = ['Timestamp','Name','MMSI','IMO','Type','Category','Flag','Callsign','Destination','Speed (kn)','Nav Status','Latitude','Longitude'];
  const rows = visitHistory.map(r => [
    r.timestamp, r.name, r.mmsi, r.imo, r.type, r.category,
    r.flag, r.callsign, r.destination, r.speed, r.navStatus, r.lat, r.lng
  ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));

  const csv  = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `vessel-history-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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
  const header   = document.querySelector('header');
  const controls = document.querySelector('.mobile-controls');
  if (header && controls) {
    controls.style.top = header.offsetHeight + 'px';
  }
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
