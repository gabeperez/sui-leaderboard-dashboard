const DATA_SOURCE = './leaderboard.json';
const SUI_RPC_URL = 'https://fullnode.mainnet.sui.io:443';

const SAMPLE_DATA = {
  source: 'sample fallback',
  updatedAt: '2026-03-30T07:00:00.000Z',
  window: '24h',
  checkpoints: [
    { checkpoint: 318104220, txCount: 1528, eventCount: 431, finalitySeconds: 0.82 },
    { checkpoint: 318104219, txCount: 1487, eventCount: 409, finalitySeconds: 0.81 },
    { checkpoint: 318104218, txCount: 1511, eventCount: 428, finalitySeconds: 0.84 },
    { checkpoint: 318104217, txCount: 1432, eventCount: 392, finalitySeconds: 0.79 },
    { checkpoint: 318104216, txCount: 1406, eventCount: 377, finalitySeconds: 0.80 }
  ],
  topContracts: [
    { label: '0x2::sui_system::SuiSystem', activity: 1842, wallets: 431 },
    { label: '0x3f4a...::bridge::Bridge', activity: 1468, wallets: 366 },
    { label: '0x8c1d...::dex::Swap', activity: 1310, wallets: 311 },
    { label: '0x77aa...::nft::Mint', activity: 988, wallets: 244 }
  ],
  activeWallets: [
    { label: '0x8f21...caa1', actions: 96, lastSeen: '2m ago' },
    { label: '0x13b0...f07c', actions: 84, lastSeen: '5m ago' },
    { label: '0x5e88...90bf', actions: 73, lastSeen: '8m ago' },
    { label: '0x74d1...1dd9', actions: 69, lastSeen: '11m ago' },
    { label: '0x9a2c...43ab', actions: 61, lastSeen: '17m ago' }
  ]
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

const rpcCache = new Map();
const nameCache = new Map();

const $ = (selector) => document.querySelector(selector);

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value ?? 0);
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(new Date(value));
}

function normalizeData(raw) {
  const payload = raw?.data ?? raw ?? {};
  return {
    source: payload.source || raw?.source || 'jun export',
    updatedAt: payload.updatedAt || raw?.updatedAt || new Date().toISOString(),
    window: payload.window || raw?.window || '24h',
    checkpoints: payload.checkpoints || payload.recentCheckpoints || [],
    topContracts: payload.topContracts || payload.contracts || [],
    activeWallets: payload.activeWallets || payload.wallets || []
  };
}

function isHexAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value);
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function shortAddress(value) {
  if (!value) return '—';
  const address = String(value);
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-4)}`;
}

function humanizeName(value) {
  if (!value) return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function splitContractLabel(label) {
  const text = String(label ?? '');
  const parts = text.split('::');
  if (parts.length >= 2 && isHexAddress(parts[0])) {
    return {
      address: normalizeAddress(parts[0]),
      module: parts.slice(1).join('::')
    };
  }
  return {
    address: null,
    module: text
  };
}

async function rpcCall(method, params) {
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  if (rpcCache.has(cacheKey)) {
    return rpcCache.get(cacheKey);
  }

  const request = fetch(SUI_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'sui-dashboard',
      method,
      params
    })
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`${method} (${response.status})`);
      }
      const json = await response.json();
      if (json.error) {
        throw new Error(json.error.message || `${method} failed`);
      }
      return json.result;
    })
    .catch((error) => {
      rpcCache.delete(cacheKey);
      throw error;
    });

  rpcCache.set(cacheKey, request);
  return request;
}

async function lookupSuinsNames(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return [];
  if (nameCache.has(normalized)) {
    return nameCache.get(normalized);
  }

  const promise = rpcCall('suix_resolveNameServiceNames', [normalized])
    .then((result) => {
      const names = Array.isArray(result?.data)
        ? result.data
        : Array.isArray(result)
          ? result
          : [];
      return names.filter(Boolean).map(String);
    })
    .catch(() => []);

  nameCache.set(normalized, promise);
  return promise;
}

async function resolveWalletLabel(address) {
  const normalized = normalizeAddress(address);
  if (!normalized) return 'Unknown wallet';

  const suinsNames = await lookupSuinsNames(normalized);
  if (suinsNames.length > 0) {
    return suinsNames[0];
  }

  return shortAddress(normalized);
}

async function resolveContractLabel(item) {
  const rawLabel = item.label ?? item.contract ?? item.name ?? '';
  const packageId = normalizeAddress(item.packageId || item.address || splitContractLabel(rawLabel).address);
  const parsed = splitContractLabel(rawLabel);
  const moduleName = humanizeName(item.module || parsed.module.replace(/^.*::/, ''));

  if (!packageId) {
    return rawLabel || 'Unknown contract';
  }

  const known = WELL_KNOWN_CONTRACTS.get(packageId);
  if (known) {
    return moduleName && known.toLowerCase() !== moduleName.toLowerCase() ? `${known} · ${moduleName}` : known;
  }

  const suinsNames = await lookupSuinsNames(packageId);
  const resolvedName = suinsNames[0];
  if (resolvedName) {
    return moduleName && resolvedName.toLowerCase() !== moduleName.toLowerCase() ? `${resolvedName} · ${moduleName}` : resolvedName;
  }

  const fallback = shortAddress(packageId);
  return moduleName ? `${fallback} · ${moduleName}` : fallback;
}

async function enrichData(data) {
  const [topContracts, activeWallets] = await Promise.all([
    Promise.all((data.topContracts || []).map(async (item) => ({
      ...item,
      displayLabel: await resolveContractLabel(item)
    }))),
    Promise.all((data.activeWallets || []).map(async (item) => ({
      ...item,
      displayLabel: await resolveWalletLabel(item.label ?? item.wallet ?? item.address ?? item.owner)
    })))
  ]);

  return {
    ...data,
    topContracts,
    activeWallets
  };
}

async function loadData() {
  const errors = [];

  try {
    const response = await fetch(DATA_SOURCE, { cache: 'no-store' });
    if (!response.ok) {
      errors.push(`${DATA_SOURCE} (${response.status})`);
    } else {
      const json = await response.json();
      return normalizeData(json);
    }
  } catch (error) {
    errors.push(`${DATA_SOURCE} (${error.message})`);
  }

  return { ...SAMPLE_DATA, errors };
}

function renderLoading() {
  const checkpointList = $('#checkpointList');
  const contractList = $('#contractList');
  const walletList = $('#walletList');

  checkpointList.innerHTML = Array.from({ length: 5 })
    .map(() => `
      <div class="checkpoint-row is-loading">
        <div>
          <div class="h-4 w-32 rounded bg-white/10 pulse"></div>
          <div class="mt-2 h-3 w-20 rounded bg-white/5 pulse"></div>
        </div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      </div>
    `)
    .join('');

  contractList.innerHTML = Array.from({ length: 4 })
    .map(() => `
      <div class="contract-row is-loading">
        <div>
          <div class="h-4 w-48 rounded bg-white/10 pulse"></div>
          <div class="mt-2 h-3 w-28 rounded bg-white/5 pulse"></div>
        </div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
      </div>
    `)
    .join('');

  walletList.innerHTML = Array.from({ length: 5 })
    .map(() => `
      <div class="wallet-row is-loading">
        <div>
          <div class="h-4 w-32 rounded bg-white/10 pulse"></div>
          <div class="mt-2 h-3 w-24 rounded bg-white/5 pulse"></div>
        </div>
        <div class="h-4 w-16 rounded bg-white/10 pulse"></div>
        <div class="h-4 w-20 rounded bg-white/10 pulse"></div>
      </div>
    `)
    .join('');
}

function renderCheckpoints(checkpoints) {
  const list = $('#checkpointList');
  if (!checkpoints.length) {
    list.innerHTML = `<div class="px-4 py-6 text-sm text-slate-400">No checkpoint rows found yet.</div>`;
    return;
  }

  list.innerHTML = checkpoints
    .map((item) => `
      <div class="checkpoint-row">
        <div>
          <div class="row-title">#${formatNumber(item.checkpoint ?? item.height ?? item.id)}</div>
          <div class="row-subtitle">${item.timestamp ? formatTime(item.timestamp) : 'Recent checkpoint'}</div>
        </div>
        <div>
          <div class="row-title">${formatNumber(item.txCount ?? item.transactions ?? 0)}</div>
          <div class="row-subtitle">transactions</div>
        </div>
        <div>
          <div class="row-title">${formatNumber(item.eventCount ?? item.events ?? 0)}</div>
          <div class="row-subtitle">events</div>
        </div>
        <div>
          <div class="row-title">${Number(item.finalitySeconds ?? item.finality ?? 0).toFixed(2)}s</div>
          <div class="row-subtitle">finality</div>
        </div>
      </div>
    `)
    .join('');
}

function renderContracts(topContracts) {
  const list = $('#contractList');
  if (!topContracts.length) {
    list.innerHTML = `<div class="px-4 py-6 text-sm text-slate-400">No contract data found yet.</div>`;
    return;
  }

  list.innerHTML = topContracts
    .map((item) => `
      <div class="contract-row">
        <div>
          <div class="row-title">${item.displayLabel ?? item.label ?? item.contract ?? item.name ?? 'Unknown contract'}</div>
          <div class="row-subtitle">Top-ranked by jun activity</div>
        </div>
        <div>
          <div class="row-title">${formatNumber(item.activity ?? item.count ?? 0)}</div>
          <div class="row-subtitle">activity</div>
        </div>
        <div>
          <div class="row-title">${formatNumber(item.wallets ?? item.uniqueWallets ?? 0)}</div>
          <div class="row-subtitle">wallets</div>
        </div>
      </div>
    `)
    .join('');
}

function renderWallets(activeWallets) {
  const list = $('#walletList');
  if (!activeWallets.length) {
    list.innerHTML = `<div class="px-4 py-6 text-sm text-slate-400">No wallet data found yet.</div>`;
    return;
  }

  list.innerHTML = activeWallets
    .map((item) => `
      <div class="wallet-row">
        <div>
          <div class="row-title">${item.displayLabel ?? item.label ?? item.wallet ?? item.address ?? 'Unknown wallet'}</div>
          <div class="row-subtitle">Active in the latest checkpoint window</div>
        </div>
        <div>
          <div class="row-title">${formatNumber(item.actions ?? item.count ?? 0)}</div>
          <div class="row-subtitle">actions</div>
        </div>
        <div>
          <span class="row-pill">${item.lastSeen ?? item.updatedAt ?? 'recent'}</span>
        </div>
      </div>
    `)
    .join('');
}

function updateSummary(data) {
  const checkpoints = data.checkpoints || [];
  const contracts = data.topContracts || [];
  const wallets = data.activeWallets || [];
  const latestCheckpoint = checkpoints[0];

  $('#sourceLabel').textContent = data.source || 'jun export';
  $('#updatedLabel').textContent = formatTime(data.updatedAt);
  $('#checkpointWindow').textContent = data.window ? `${data.window} window` : '24h window';
  $('#contractMeta').textContent = `${formatNumber(contracts.length)} contracts`;
  $('#walletMeta').textContent = `${formatNumber(wallets.length)} wallets`;

  $('#latestCheckpoint').textContent = latestCheckpoint
    ? `#${formatNumber(latestCheckpoint.checkpoint ?? latestCheckpoint.height ?? latestCheckpoint.id)}`
    : '—';

  $('#latestCheckpointNote').textContent = latestCheckpoint
    ? `${formatNumber(latestCheckpoint.txCount ?? latestCheckpoint.transactions ?? 0)} transactions in the latest row`
    : 'Awaiting indexed export';

  $('#checkpointCount').textContent = formatNumber(checkpoints.length);
  $('#contractCount').textContent = formatNumber(contracts.length);
  $('#walletCount').textContent = formatNumber(wallets.length);
}

async function main() {
  renderLoading();
  const data = await loadData();
  const enrichedData = await enrichData(data);
  updateSummary(enrichedData);
  renderCheckpoints(enrichedData.checkpoints || []);
  renderContracts(enrichedData.topContracts || []);
  renderWallets(enrichedData.activeWallets || []);

  if (enrichedData.errors?.length) {
    $('#sourceLabel').textContent = `${enrichedData.source || 'sample fallback'} / offline`;
  }
}

main().catch((error) => {
  console.error(error);
  $('#sourceLabel').textContent = 'render error';
  $('#updatedLabel').textContent = 'check console';
});
