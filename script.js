const DATA_SOURCE = './leaderboard.json';
const SUISCAN_BASE = 'https://suiscan.xyz/mainnet';
const REFRESH_INTERVAL = 30;

const SAMPLE_DATA = {
  source: 'no data — run generate-leaderboard.ts',
  updatedAt: new Date(0).toISOString(),
  window: '—',
  networkStats: null,
  checkpoints: [],
  topContracts: [],
  activeWallets: []
};

const WELL_KNOWN_CONTRACTS = new Map([
  ['0x2', 'Sui Framework'],
  ['0xcaf6ba059d539a97646d47f0b9ddf843e138d215e2a12ca1f4585d386f7aec3a', 'Pool'],
  ['0xe8e485e9339ec1d42ac92350fd3708ba823ad6e813af459fa32c68562e413cda', 'DBKE'],
  ['0x73949528d57ccc07dad6d0eb996bae9ac66cb5c2189f08072104b060190add3d', 'Interface'],
  ['0x5ea2c97771334e4a64216d42e5ba68eb2a9792fe874c8d2bfdf8feb32ec7dc8b', 'Lotus DB Vault'],
  ['0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809', 'Pool'],
  ['0x4979543452f609ff272d504755966ff5e70122256101c17adbe8bd27d35116c3', 'Price Data Pull v2'],
  ['0xa6d0bd2e53216880182395e83f66ca581bb3ece53f154f54b2cc6b2403f66af7', 'Entrypoint'],
  ['0x9f6de0f9c1333cecfafed4fd51ecf445d237a6295bd6ae88754821c8f8189789', 'Campaign'],
  ['0x203728f46eb10d19f8f8081db849c86aa8f2a19341b7fd84d7a0e74f053f6242', 'Oracle Pro'],
  ['0x5209a18e1ae6ac994dd5a188a2d8deb17b2bbab29f63a7b5457bdfe040f69f61', 'Alpha Lending']
]);

// Category detection from module / label text
const CATEGORY_PATTERNS = [
  { re: /\b(swap|dex|amm|clmm|trade|pair)\b/i,            label: 'DEX',      color: '#60a5fa' },
  { re: /\b(pool|liquidity|lp)\b/i,                        label: 'DEX',      color: '#60a5fa' },
  { re: /\b(lend|borrow|collateral|credit|alpha.lend)\b/i, label: 'Lending',  color: '#a78bfa' },
  { re: /\b(vault|yield|farm|earn|stake|reward)\b/i,       label: 'Yield',    color: '#34d399' },
  { re: /\b(oracle|price|feed|pyth|switch|pull)\b/i,       label: 'Oracle',   color: '#fbbf24' },
  { re: /\b(bridge|wormhole|portal|cross.chain)\b/i,       label: 'Bridge',   color: '#f87171' },
  { re: /\b(nft|mint|collection|media|art)\b/i,            label: 'NFT',      color: '#e879f9' },
  { re: /\b(game|quest|hero|battle|play)\b/i,              label: 'Gaming',   color: '#fb923c' },
  { re: /\b(campaign|airdrop|launch|sale)\b/i,             label: 'Campaign', color: '#fb923c' },
  { re: /\b(dbke|interface|entrypoint|router)\b/i,         label: 'Infra',    color: '#94a3b8' },
];

function detectCategory(label) {
  const text = String(label ?? '').toLowerCase();
  for (const { re, label: cat, color } of CATEGORY_PATTERNS) {
    if (re.test(text)) return { label: cat, color };
  }
  return { label: 'Protocol', color: '#64748b' };
}

function categoryBadge(label) {
  const cat = detectCategory(label);
  return `<span class="cat-badge" style="--cat-color:${cat.color}">${cat.label}</span>`;
}

// SUINS name resolution — only browser network call
const rpcCache = new Map();
const nameCache = new Map();

const $ = (selector) => document.querySelector(selector);

let previousContracts = [];
let previousWallets = [];
let refreshTimer = null;
let countdown = REFRESH_INTERVAL;
let isPageVisible = true;
let defiRange = '30d';
let defiCache = null;
let defiTotalTxCache = null;
let customFrom = null;
let customTo = null;

/* ── Utilities ──────────────────────────────────────── */

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric'
  }).format(new Date(value));
}

function timeAgo(value) {
  if (!value) return 'recent';
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  const diff = Date.now() - date.getTime();
  if (diff < 60000)   return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  if (seconds < 60)   return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatUSD(value) {
  if (value == null || isNaN(value)) return '—';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function normalizeData(raw) {
  const payload = raw?.data ?? raw ?? {};
  return {
    source:       payload.source       || 'jun export',
    updatedAt:    payload.updatedAt    || new Date().toISOString(),
    window:       payload.window       || '—',
    networkStats: payload.networkStats ?? null,
    checkpoints:  payload.checkpoints  || payload.recentCheckpoints || [],
    topContracts: payload.topContracts || payload.contracts          || [],
    activeWallets:payload.activeWallets|| payload.wallets            || []
  };
}

/* ── SuiScan ────────────────────────────────────────── */

const EXT_ICON = '<svg class="ext-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10L10 2M6 2h4v4"/></svg>';

function extLink(url, label) {
  return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ext-link">${label}${EXT_ICON}</a>`;
}

function suiscanCheckpointUrl(seq)  { return `${SUISCAN_BASE}/checkpoint/${seq}`; }
function suiscanAccountUrl(address) { return `${SUISCAN_BASE}/account/${address}`; }
function suiscanObjectUrl(address)  { return `${SUISCAN_BASE}/object/${address}`; }

/* ── Address helpers ────────────────────────────────── */

function isHexAddress(v) { return typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v); }
function normalizeAddress(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function isZeroAddress(v) {
  const n = normalizeAddress(v);
  return n === '0x' + '0'.repeat(64) || n === '0x0';
}
function shortAddress(v) {
  if (!v) return '—';
  const a = String(v);
  return a.length <= 14 ? a : `${a.slice(0, 8)}…${a.slice(-4)}`;
}
function humanizeName(v) {
  return String(v || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase()).trim();
}
function splitContractLabel(label) {
  const parts = String(label ?? '').split('::');
  if (parts.length >= 2 && isHexAddress(parts[0])) {
    return { address: normalizeAddress(parts[0]), module: parts.slice(1).join('::') };
  }
  return { address: null, module: String(label ?? '') };
}

/* ── SUINS (only RPC the browser makes) ─────────────── */

async function suinsRpcCall(method, params) {
  const key = `${method}:${JSON.stringify(params)}`;
  if (rpcCache.has(key)) return rpcCache.get(key);
  const p = fetch('https://fullnode.mainnet.sui.io:443', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'dashboard', method, params })
  }).then(async r => {
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }).catch(e => { rpcCache.delete(key); throw e; });
  rpcCache.set(key, p);
  return p;
}

async function lookupSuinsNames(address) {
  const norm = normalizeAddress(address);
  if (!norm) return [];
  if (nameCache.has(norm)) return nameCache.get(norm);
  const p = suinsRpcCall('suix_resolveNameServiceNames', [norm])
    .then(r => (Array.isArray(r?.data) ? r.data : Array.isArray(r) ? r : []).filter(Boolean).map(String))
    .catch(() => []);
  nameCache.set(norm, p);
  return p;
}

async function resolveWalletLabel(address) {
  const norm = normalizeAddress(address);
  if (!norm) return 'Unknown';
  const names = await lookupSuinsNames(norm);
  return names[0] ?? shortAddress(norm);
}

async function resolveContractLabel(item) {
  const rawLabel = item.label ?? item.contract ?? item.name ?? '';
  const packageId = normalizeAddress(item.packageId || item.address || splitContractLabel(rawLabel).address);
  const parsed = splitContractLabel(rawLabel);
  const moduleName = humanizeName(item.module || parsed.module.replace(/^.*::/, ''));

  if (!packageId) return rawLabel || 'Unknown contract';

  const known = WELL_KNOWN_CONTRACTS.get(packageId);
  if (known) return moduleName && known.toLowerCase() !== moduleName.toLowerCase()
    ? `${known} · ${moduleName}` : known;

  const names = await lookupSuinsNames(packageId);
  const resolved = names[0];
  if (resolved) return moduleName && resolved.toLowerCase() !== moduleName.toLowerCase()
    ? `${resolved} · ${moduleName}` : resolved;

  return moduleName ? `${shortAddress(packageId)} · ${moduleName}` : shortAddress(packageId);
}

async function enrichData(data) {
  const wallets = (data.activeWallets || []).filter(
    w => !isZeroAddress(w.label ?? w.wallet ?? w.address ?? w.owner ?? '')
  );
  const [topContracts, activeWallets] = await Promise.all([
    Promise.all((data.topContracts || []).map(async item => ({
      ...item, displayLabel: await resolveContractLabel(item)
    }))),
    Promise.all(wallets.map(async item => ({
      ...item, displayLabel: await resolveWalletLabel(
        item.label ?? item.wallet ?? item.address ?? item.owner
      )
    })))
  ]);
  return { ...data, topContracts, activeWallets };
}

/* ── Clipboard ──────────────────────────────────────── */

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M3 11V3.5A1.5 1.5 0 014.5 2H11"/></svg>';

function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => showToast('Copied'))
    .catch(() => showToast('Copy failed'));
}

/* ── Toast ──────────────────────────────────────────── */

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>${msg}`;
  $('#toast-container').appendChild(t);
  setTimeout(() => {
    t.classList.add('toast-out');
    t.addEventListener('animationend', () => t.remove());
  }, 1800);
}

/* ── Count-up ───────────────────────────────────────── */

function animateValue(el, targetText) {
  const digits = targetText.replace(/[^0-9]/g, '');
  const prefix = targetText.match(/^[^0-9]*/)?.[0] || '';
  const suffix = targetText.match(/[^0-9]*$/)?.[0] || '';
  if (!digits || isNaN(Number(digits))) { el.textContent = targetText; return; }
  const target = Number(digits);
  const start = performance.now();
  (function tick(now) {
    const p = Math.min((now - start) / 600, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + new Intl.NumberFormat('en-US').format(Math.round(target * eased)) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}

/* ── Sparkline ──────────────────────────────────────── */

function drawSparkline(canvasId, values, color = '#60a5fa') {
  const canvas = $(`#${canvasId}`);
  if (!canvas || !values.length) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const w = canvas.offsetWidth, h = canvas.offsetHeight, p = 2;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color.replace(')', ', 0.2)').replace('rgb', 'rgba'));
  grad.addColorStop(1, 'transparent');
  const path = () => { ctx.beginPath(); values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * (w - p * 2) + p;
    const y = h - p - ((v - min) / range) * (h - p * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }); };
  path(); ctx.lineTo(w - p, h); ctx.lineTo(p, h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  path(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  const lx = w - p, ly = h - p - ((values[values.length-1] - min) / range) * (h - p * 2);
  ctx.beginPath(); ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

/* ── DeFiLlama integration ──────────────────────────── */

async function loadDefiLlamaData() {
  try {
    const [tvlRes, dexRes] = await Promise.allSettled([
      fetch('https://api.llama.fi/v2/historicalChainTvl/Sui').then(r => r.ok ? r.json() : null),
      fetch('https://api.llama.fi/overview/dexs/Sui?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true&dataType=dailyVolume')
        .then(r => r.ok ? r.json() : null),
    ]);
    const tvlRaw = tvlRes.status === 'fulfilled' ? tvlRes.value : null;
    const dexRaw = dexRes.status === 'fulfilled' ? dexRes.value : null;

    // Keep full history — filtering happens client-side in renderDefiSection
    const tvlAll = Array.isArray(tvlRaw)
      ? tvlRaw.map(d => ({ date: d.date * 1000, value: d.tvl }))
      : [];
    const dexAll = Array.isArray(dexRaw?.totalDataChart)
      ? dexRaw.totalDataChart.map(([d, v]) => ({ date: d * 1000, value: v }))
      : [];

    return { tvlAll, dexAll, currentTvl: tvlAll.at(-1)?.value ?? null };
  } catch {
    return { tvlAll: [], dexAll: [], currentTvl: null };
  }
}

const RANGE_DAYS = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, 'all': Infinity, 'custom': null };
const RANGE_LABELS = { '1d': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', 'all': 'All time', 'custom': 'Custom range' };

function sliceByRange(arr, range) {
  if (range === 'custom') {
    if (!customFrom || !customTo) return arr.slice(-30); // fallback to 30d if not set
    return arr.filter(d => d.date >= customFrom && d.date <= customTo);
  }
  const days = RANGE_DAYS[range] ?? 30;
  if (days === Infinity) return arr;
  const cutoff = Date.now() - days * 86400 * 1000;
  return arr.filter(d => d.date >= cutoff);
}

function setDefiRange(range) {
  defiRange = range;
  document.querySelectorAll('.range-tab').forEach(el => {
    el.classList.toggle('range-tab--active', el.dataset.range === range);
  });
  const picker = $('#customRangePicker');
  if (picker) {
    picker.hidden = range !== 'custom';
    if (range === 'custom') {
      // Pre-fill with sensible defaults the first time
      const toEl = $('#customTo'), fromEl = $('#customFrom');
      if (toEl && !toEl.value) toEl.value = new Date().toISOString().slice(0, 10);
      if (fromEl && !fromEl.value) {
        const d = new Date(); d.setDate(d.getDate() - 30);
        fromEl.value = d.toISOString().slice(0, 10);
      }
    }
  }
  if (range !== 'custom' && defiCache) renderDefiSection(defiCache, defiTotalTxCache);
}

function applyCustomRange() {
  const fromEl = $('#customFrom'), toEl = $('#customTo');
  if (!fromEl?.value || !toEl?.value) return;
  customFrom = new Date(fromEl.value).getTime();
  customTo   = new Date(toEl.value).getTime() + 86400 * 1000 - 1; // end of that day
  if (defiCache) renderDefiSection(defiCache, defiTotalTxCache);
}

function renderTrendChart(containerId, data, color) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (data.length < 2) { container.innerHTML = ''; return; }

  const values = data.map(d => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 100, H = 40;

  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - 4 - ((d.value - min) / range) * (H - 8);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const area = `0,${H} ${pts} ${W},${H}`;
  const uid = containerId.replace(/[^a-z0-9]/gi, '');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
    xmlns="http://www.w3.org/2000/svg" class="trend-chart-svg">
    <defs>
      <linearGradient id="tg-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <polygon points="${area}" fill="url(#tg-${uid})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"
      stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderDefiSection(defi, totalTx) {
  defiCache = defi;
  defiTotalTxCache = totalTx;

  const tvlSlice = sliceByRange(defi.tvlAll, defiRange);
  const dexSlice = sliceByRange(defi.dexAll, defiRange);
  const rangeLabel = RANGE_LABELS[defiRange] ?? 'Last 30 days';

  const tvlEl = $('#metricTVL');
  // TVL: show current (latest) value regardless of range; chart shows the window
  if (tvlEl) tvlEl.textContent = formatUSD(defi.currentTvl);
  const tvlNote = $('#tvlNote');
  if (tvlNote) tvlNote.textContent = `Current · ${rangeLabel} trend`;
  renderTrendChart('chartTVL', tvlSlice, '#7dd3fc');

  const dexTotal = dexSlice.reduce((s, d) => s + d.value, 0);
  const dexEl = $('#metricDexVol');
  if (dexEl) dexEl.textContent = formatUSD(dexTotal);
  const dexNote = $('#dexNote');
  if (dexNote) dexNote.textContent = `${rangeLabel} · All Sui DEXes`;
  renderTrendChart('chartDexVol', dexSlice, '#34d399');

  const txEl = $('#metricTotalTx');
  if (txEl && totalTx) {
    const billions = totalTx / 1e9;
    txEl.textContent = billions >= 1
      ? `${billions.toFixed(2)}B`
      : `${(totalTx / 1e6).toFixed(0)}M`;
  }
}

/* ── Rank helpers ───────────────────────────────────── */

function rankBadge(i) {
  const r = i + 1;
  return `<span class="rank-badge${r <= 3 ? ` rank-${r}` : ''}">${r}</span>`;
}
function getRankChange(label, prev) {
  if (!prev.length) return '';
  return prev.findIndex(p => p === label) === -1
    ? '<span class="rank-change rank-new">NEW</span>' : '';
}

/* ── Activity bar ───────────────────────────────────── */

function activityBar(value, maxValue) {
  const pct = maxValue > 0 ? Math.round((value / maxValue) * 100) : 0;
  return `<div class="activity-bar-wrap">
    <span class="row-title">${formatNumber(value)}</span>
    <div class="activity-bar"><div class="activity-bar-fill" style="width:${pct}%"></div></div>
  </div>`;
}

function copyButton(text) {
  const esc = text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
  return `<button class="copy-btn" onclick="copyToClipboard('${esc}')" title="Copy">${COPY_ICON}</button>`;
}

/* ── Status ─────────────────────────────────────────── */

function setStatus(data) {
  const dot = $('#statusDot'), text = $('#statusText');
  dot.classList.remove('is-live', 'is-stale', 'is-offline');

  if (data._liveOk) {
    dot.classList.add('is-live');
    const indexedAge = data._indexedAt
      ? Date.now() - new Date(data._indexedAt).getTime()
      : null;
    const indexedStr = indexedAge
      ? ` · protocols ${timeAgo(new Date(data._indexedAt))}`
      : '';
    text.textContent = `Live checkpoints${indexedStr}`;
  } else if (data._indexedAt) {
    const age = Date.now() - new Date(data._indexedAt).getTime();
    dot.classList.add('is-stale');
    text.textContent = `Checkpoints unavailable · data from ${timeAgo(new Date(data._indexedAt))}`;
  } else {
    dot.classList.add('is-offline');
    text.textContent = 'No data — deploy leaderboard.json and check /api/leaderboard';
  }
}

/* ── Stale banner ───────────────────────────────────── */

function updateStaleBanner(data) {
  const banner = $('#staleBanner');
  if (!banner) return;
  if (!data._indexedAt) {
    banner.textContent = 'Protocol & wallet data not yet available — run generate-leaderboard.ts to populate.';
    banner.hidden = false;
    return;
  }
  const age = Date.now() - new Date(data._indexedAt).getTime();
  if (age > 3600000) {
    banner.textContent = `Protocol & wallet data is ${Math.floor(age / 3600000)}h old — GitHub Actions should refresh this automatically.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

/* ── Data loading ───────────────────────────────────── */

async function loadData() {
  // Live: checkpoints + network stats from the edge function (always fresh)
  // Indexed: topContracts + activeWallets from leaderboard.json (updated by jun/GitHub Actions)
  const [liveResult, indexedResult] = await Promise.allSettled([
    fetch('/api/leaderboard').then(r => r.ok ? r.json() : Promise.reject(r.status)),
    fetch(DATA_SOURCE, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
  ]);

  const live    = liveResult.status    === 'fulfilled' ? liveResult.value    : null;
  const indexed = indexedResult.status === 'fulfilled' ? indexedResult.value : null;
  const norm    = indexed ? normalizeData(indexed) : null;

  // Merge live (fresh RPC) + indexed (jun window aggregates) smartly
  const liveStats = live?.networkStats ?? {};
  const normStats = norm?.networkStats ?? {};
  const networkStats = (live || norm) ? {
    // From live RPC — always the freshest values
    epoch:             liveStats.epoch             ?? normStats.epoch             ?? null,
    validatorCount:    liveStats.validatorCount     ?? normStats.validatorCount    ?? 0,
    avgFinalityMs:     liveStats.avgFinalityMs      ?? normStats.avgFinalityMs     ?? null,
    tps:               liveStats.tps               ?? null,
    totalTransactions: liveStats.totalTransactions  ?? null,
    // From indexed (jun) — window-specific aggregates over 1,000 checkpoints
    totalTx:           normStats.totalTx            ?? liveStats.totalTx           ?? 0,
    uniqueWallets:     normStats.uniqueWallets       ?? null,
    newWallets:        normStats.newWallets          ?? null,
    windowDurationSeconds: normStats.windowDurationSeconds ?? null,
    windowCheckpoints: normStats.windowCheckpoints   ?? null,
  } : null;

  return {
    source:       live ? 'sui rpc · live'   : (norm?.source || 'sample data'),
    updatedAt:    norm?.updatedAt            || new Date().toISOString(),
    window:       norm?.window               || '—',
    networkStats,
    checkpoints:  live?.checkpoints          || norm?.checkpoints  || [],
    topContracts: norm?.topContracts         || [],
    activeWallets:norm?.activeWallets        || [],
    _liveOk:      !!live,
    _indexedAt:   norm?.updatedAt            || null,
  };
}

/* ── Loading skeleton ───────────────────────────────── */

function renderLoading() {
  $('#checkpointList').innerHTML = Array.from({ length: 5 }).map(() => `
    <div class="checkpoint-row is-loading">
      <div><div class="h-4 w-32 rounded bg-white/10 pulse"></div><div class="mt-2 h-3 w-20 rounded bg-white/5 pulse"></div></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
    </div>`).join('');
  $('#contractList').innerHTML = Array.from({ length: 4 }).map(() => `
    <div class="contract-row is-loading">
      <div><div class="h-4 w-48 rounded bg-white/10 pulse"></div><div class="mt-2 h-3 w-28 rounded bg-white/5 pulse"></div></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
    </div>`).join('');
  $('#walletList').innerHTML = Array.from({ length: 5 }).map(() => `
    <div class="wallet-row is-loading">
      <div><div class="h-4 w-32 rounded bg-white/10 pulse"></div><div class="mt-2 h-3 w-24 rounded bg-white/5 pulse"></div></div>
      <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      <div class="h-4 w-20 rounded bg-white/10 pulse"></div>
    </div>`).join('');
}

/* ── Hero summary cards ─────────────────────────────── */

function updateSummary(data, animate = true) {
  const stats = data.networkStats;
  const checkpoints = data.checkpoints || [];
  const contracts = data.topContracts || [];
  const wallets = data.activeWallets || [];

  $('#sourceLabel').textContent = data.source || 'jun export';
  $('#updatedLabel').textContent = formatTime(data.updatedAt);

  // Window badge on checkpoint stream section
  const winEl = $('#checkpointWindow');
  if (winEl) {
    const ncp = stats?.windowCheckpoints;
    const winStr = data.window || '—';
    winEl.textContent = ncp ? `${winStr} · ${formatNumber(ncp)} checkpoints` : winStr;
  }

  // Contract / wallet badges
  const cMeta = $('#contractMeta'), wMeta = $('#walletMeta');
  if (cMeta) cMeta.textContent = `${formatNumber(contracts.length)} protocols`;
  if (wMeta) wMeta.textContent = `${formatNumber(wallets.length)} wallets`;

  // Hero card 1: avg finality
  const fEl = $('#metricFinality'), fNote = $('#metricFinalityNote');
  const fMs = stats?.avgFinalityMs;
  if (fEl) {
    if (animate && fMs) animateValue(fEl, `${fMs}ms`);
    else fEl.textContent = fMs ? `${fMs}ms` : '—';
  }
  if (fNote) fNote.textContent = fMs ? 'avg across last 20 checkpoints' : 'Run generate-leaderboard.ts';

  // Hero card 2: total transactions in window
  const txEl = $('#metricTx'), txNote = $('#metricTxNote');
  const totalTx = stats?.totalTx ?? 0;
  if (txEl) {
    if (animate && totalTx) animateValue(txEl, formatNumber(totalTx));
    else txEl.textContent = totalTx ? formatNumber(totalTx) : '—';
  }
  if (txNote) {
    const ncp = stats?.windowCheckpoints;
    const w = data.window || '—';
    txNote.textContent = ncp ? `${w} · ${formatNumber(ncp)} checkpoints` : w;
  }

  // Hero card 3: unique wallets
  const uwEl = $('#metricWallets'), uwNote = $('#metricWalletsNote');
  const uniqueWallets = stats?.uniqueWallets ?? 0;
  if (uwEl) {
    if (animate && uniqueWallets) animateValue(uwEl, formatNumber(uniqueWallets));
    else uwEl.textContent = uniqueWallets ? formatNumber(uniqueWallets) : '—';
  }
  if (uwNote) {
    const newW = stats?.newWallets;
    const w = data.window;
    uwNote.textContent = newW ? `${formatNumber(newW)} new · ${w || 'this window'}` : (w ? `in the last ${w}` : 'Unique senders');
  }

  // Hero card 4: active protocols
  const prEl = $('#metricProtocols'), prNote = $('#metricProtocolsNote');
  if (prEl) {
    if (animate && contracts.length) animateValue(prEl, String(contracts.length));
    else prEl.textContent = contracts.length ? String(contracts.length) : '—';
  }
  if (prNote) prNote.textContent = contracts.length ? 'competing for activity' : 'No contract data';

  // Sparklines
  const txVals = checkpoints.map(c => c.txCount ?? 0).reverse();
  const contractActs = contracts.map(c => c.activity ?? 0);
  const walletActs = wallets.map(w => w.actions ?? 0);
  const finalityVals = checkpoints.map(c => c.finalitySeconds ?? 0).reverse().filter(Boolean);
  const pad = (arr, min) => arr.length >= min ? arr : [...Array(min - arr.length).fill(arr[0] ?? 0), ...arr];

  drawSparkline('sparkFinality', pad(finalityVals.map(f => f * 1000), 6), '#7dd3fc');
  drawSparkline('sparkTx', pad(txVals, 6), '#60a5fa');
  drawSparkline('sparkWallets', pad(new Array(Math.min(wallets.length, 6)).fill(uniqueWallets / 6), 6), '#34d399');
  drawSparkline('sparkProtocols', pad(contractActs.slice(0, 6), 6), '#a78bfa');
}

/* ── Network health panel ───────────────────────────── */

function renderNetworkHealth(data) {
  const container = $('#networkHealthGrid');
  if (!container) return;
  const stats = data.networkStats;

  if (!stats) {
    container.innerHTML = `<div class="net-stat-item" style="grid-column:span 2">
      <span class="net-stat-label">No data</span>
      <span class="net-stat-value" style="font-size:0.95rem;color:rgba(203,213,225,0.5)">Run generate-leaderboard.ts</span>
    </div>`;
    return;
  }

  const dur = stats.windowDurationSeconds;
  const durStr = dur ? formatDuration(dur) : data.window || '—';

  container.innerHTML = `
    <div class="net-stat-item">
      <span class="net-stat-label">Epoch</span>
      <span class="net-stat-value">${stats.epoch ?? '—'}</span>
    </div>
    <div class="net-stat-item">
      <span class="net-stat-label">Validators</span>
      <span class="net-stat-value">${stats.validatorCount || '—'}</span>
    </div>
    <div class="net-stat-item">
      <span class="net-stat-label">Window</span>
      <span class="net-stat-value" style="font-size:1.1rem">${durStr}</span>
    </div>
    <div class="net-stat-item">
      <span class="net-stat-label">New wallets</span>
      <span class="net-stat-value" style="font-size:1.1rem">${stats.newWallets ? formatNumber(stats.newWallets) : '—'}</span>
    </div>
  `;
}

/* ── Checkpoint modal ───────────────────────────────── */

function openCheckpointModal() {
  const modal = $('#checkpointModal');
  if (modal) { modal.hidden = false; document.body.style.overflow = 'hidden'; }
}

function closeCheckpointModal() {
  const modal = $('#checkpointModal');
  if (modal) { modal.hidden = true; document.body.style.overflow = ''; }
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCheckpointModal(); });
document.addEventListener('click', e => {
  if (e.target?.id === 'checkpointModal') closeCheckpointModal();
});

/* ── Checkpoint stream ──────────────────────────────── */

function renderCheckpoints(checkpoints) {
  const list = $('#checkpointList');
  const modalList = $('#checkpointModalList');
  const btn = $('#viewAllCheckpointsBtn');

  if (!checkpoints.length) {
    if (list) list.innerHTML = `<div class="px-4 py-8 text-center text-sm text-slate-400">No checkpoint data — run generate-leaderboard.ts.</div>`;
    if (btn) btn.hidden = true;
    return;
  }

  if (btn) btn.hidden = false;

  const buildRow = (item, i) => {
    const seq = item.checkpoint ?? item.height ?? item.id;
    const finality = item.finalitySeconds != null
      ? `${(item.finalitySeconds * 1000).toFixed(0)}ms` : '—';
    const finalityClass = item.finalitySeconds != null && item.finalitySeconds < 0.4
      ? 'finality-fast' : '';
    return `
    <div class="checkpoint-row row-enter" style="animation-delay:${i * 40}ms">
      <div>
        <div class="row-title">${extLink(suiscanCheckpointUrl(seq), `#${formatNumber(seq)}`)}</div>
        <div class="row-subtitle">${item.timestamp ? formatTime(item.timestamp) : ''}</div>
      </div>
      <div>
        <div class="row-title">${formatNumber(item.txCount ?? 0)}</div>
        <div class="row-subtitle">txs</div>
      </div>
      <div>
        <div class="row-title">${formatNumber(item.eventCount ?? 0)}</div>
        <div class="row-subtitle">events</div>
      </div>
      <div>
        <div class="row-title ${finalityClass}">${finality}</div>
        <div class="row-subtitle">finality</div>
      </div>
    </div>`;
  };

  if (list) list.innerHTML = checkpoints.slice(0, 5).map(buildRow).join('');
  if (modalList) modalList.innerHTML = checkpoints.map(buildRow).join('');
}

/* ── Protocol activity ──────────────────────────────── */

function renderContracts(topContracts) {
  const list = $('#contractList');
  if (!topContracts.length) {
    list.innerHTML = `<div class="px-4 py-8 text-center text-sm text-slate-400">No protocol data — run generate-leaderboard.ts.</div>`;
    return;
  }
  const maxAct = Math.max(...topContracts.map(c => c.activity ?? 0));
  const prevLabels = previousContracts.map(c => c.displayLabel ?? c.label ?? '');

  list.innerHTML = topContracts.map((item, i) => {
    const label = item.displayLabel ?? item.label ?? 'Unknown';
    const activity = item.activity ?? 0;
    const wallets = item.wallets ?? 0;
    const change = getRankChange(label, prevLabels);
    const { address } = splitContractLabel(item.label ?? item.contract ?? '');
    const rawForLabel = item.displayLabel ?? shortAddress(address) ?? label;

    return `
    <div class="contract-row row-enter" style="animation-delay:${i * 40}ms">
      <div style="display:flex;align-items:center;gap:0.6rem">
        ${rankBadge(i)}
        <div style="min-width:0">
          <div class="row-title" style="display:flex;align-items:center;gap:0.3rem;flex-wrap:wrap">
            ${address
              ? extLink(suiscanObjectUrl(address), rawForLabel)
              : `<span>${rawForLabel}</span>`}
            ${categoryBadge(label)}
            ${copyButton(address || label)}
            ${change}
          </div>
          <div class="row-subtitle">${address ? shortAddress(address) : 'Unknown package'}</div>
        </div>
      </div>
      <div>${activityBar(activity, maxAct)}</div>
      <div>
        <div class="row-title">${formatNumber(wallets)}</div>
        <div class="row-subtitle">wallets</div>
      </div>
    </div>`;
  }).join('');

  previousContracts = topContracts.map(c => ({ ...c }));
}

/* ── Power users ────────────────────────────────────── */

function renderWallets(activeWallets) {
  const list = $('#walletList');
  if (!activeWallets.length) {
    list.innerHTML = `<div class="px-4 py-8 text-center text-sm text-slate-400">No wallet data — run generate-leaderboard.ts.</div>`;
    return;
  }
  const maxAct = Math.max(...activeWallets.map(w => w.actions ?? 0));
  const prevLabels = previousWallets.map(w => w.displayLabel ?? w.label ?? '');

  list.innerHTML = activeWallets.map((item, i) => {
    const rawAddr = normalizeAddress(item.label ?? item.wallet ?? item.address ?? item.owner ?? '');
    const label = item.displayLabel ?? shortAddress(rawAddr) ?? 'Unknown';
    const actions = item.actions ?? 0;
    const lastSeenText = timeAgo(item.lastSeen ?? item.updatedAt ?? null);
    const change = getRankChange(label, prevLabels);

    return `
    <div class="wallet-row row-enter" style="animation-delay:${i * 40}ms">
      <div style="display:flex;align-items:center;gap:0.6rem">
        ${rankBadge(i)}
        <div style="min-width:0">
          <div class="row-title" style="display:flex;align-items:center;gap:0.25rem">
            ${rawAddr ? extLink(suiscanAccountUrl(rawAddr), label) : `<span>${label}</span>`}
            ${rawAddr ? copyButton(rawAddr) : ''}
            ${change}
          </div>
          <div class="row-subtitle">${rawAddr ? shortAddress(rawAddr) : ''}</div>
        </div>
      </div>
      <div>${activityBar(actions, maxAct)}</div>
      <div><span class="row-pill">${lastSeenText}</span></div>
    </div>`;
  }).join('');

  previousWallets = activeWallets.map(w => ({ ...w }));
}

/* ── Refresh timer ──────────────────────────────────── */

function startRefreshTimer() {
  countdown = REFRESH_INTERVAL;
  updateCountdownDisplay();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!isPageVisible) return;
    countdown--;
    updateCountdownDisplay();
    if (countdown <= 0) refresh();
  }, 1000);
}

function updateCountdownDisplay() {
  const el = $('#refreshCountdown');
  if (el) el.textContent = `${countdown}s`;
}

async function manualRefresh() {
  const btn  = $('#refreshBtn');
  const icon = $('#refreshIcon');
  if (btn?.disabled) return;
  if (btn)  btn.disabled = true;
  if (icon) icon.classList.add('is-spinning');
  try {
    await refresh();
  } finally {
    if (icon) icon.classList.remove('is-spinning');
    if (btn)  btn.disabled = false;
  }
}

async function refresh() {
  countdown = REFRESH_INTERVAL;
  updateCountdownDisplay();
  const [data, defi] = await Promise.all([loadData(), loadDefiLlamaData()]);
  const enriched = await enrichData(data);
  updateSummary(enriched, true);
  renderCheckpoints(enriched.checkpoints || []);
  renderContracts(enriched.topContracts || []);
  renderWallets(enriched.activeWallets || []);
  renderNetworkHealth(enriched);
  renderDefiSection(defi, enriched.networkStats?.totalTransactions ?? null);
  updateStaleBanner(enriched);
  setStatus(enriched);
}

document.addEventListener('visibilitychange', () => { isPageVisible = !document.hidden; });

/* ── Tooltip system (body-appended, escapes overflow) ── */

(function () {
  let bubble = null;

  function getOrCreateBubble() {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'tooltip-bubble';
      document.body.appendChild(bubble);
    }
    return bubble;
  }

  function showTip(el) {
    const tip = el.getAttribute('data-tip');
    if (!tip) return;
    const b = getOrCreateBubble();
    b.textContent = tip;
    b.style.opacity = '0';
    b.style.display = 'block';

    const rect = el.getBoundingClientRect();
    const bw = b.offsetWidth || 220;
    const bh = b.offsetHeight || 60;
    const gap = 8;

    // prefer above, fall back to below
    let top = rect.top - bh - gap;
    if (top < 8) top = rect.bottom + gap;

    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));

    b.style.top  = `${top}px`;
    b.style.left = `${left}px`;
    requestAnimationFrame(() => { b.style.opacity = '1'; });
  }

  function hideTip() {
    if (bubble) { bubble.style.opacity = '0'; }
  }

  document.addEventListener('mouseover', e => {
    const tip = e.target.closest('.info-tip');
    if (tip) showTip(tip);
  });
  document.addEventListener('mouseout', e => {
    if (e.target.closest?.('.info-tip')) hideTip();
  });
  document.addEventListener('scroll', hideTip, true);
})();

/* ── Main ───────────────────────────────────────────── */

async function main() {
  renderLoading();
  const [data, defi] = await Promise.all([loadData(), loadDefiLlamaData()]);
  const enriched = await enrichData(data);
  updateSummary(enriched, true);
  renderCheckpoints(enriched.checkpoints || []);
  renderContracts(enriched.topContracts || []);
  renderWallets(enriched.activeWallets || []);
  renderNetworkHealth(enriched);
  renderDefiSection(defi, enriched.networkStats?.totalTransactions ?? null);
  updateStaleBanner(enriched);
  setStatus(enriched);
  startRefreshTimer();
}

main().catch(err => {
  console.error(err);
  $('#statusDot')?.classList.add('is-offline');
  $('#sourceLabel').textContent = 'render error — check console';
});
