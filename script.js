const DATA_SOURCE = './leaderboard.json';

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
          <div class="row-title">${item.label ?? item.contract ?? item.name ?? 'Unknown contract'}</div>
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
          <div class="row-title">${item.label ?? item.wallet ?? item.address ?? 'Unknown wallet'}</div>
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
  updateSummary(data);
  renderCheckpoints(data.checkpoints || []);
  renderContracts(data.topContracts || []);
  renderWallets(data.activeWallets || []);

  if (data.errors?.length) {
    $('#sourceLabel').textContent = `${data.source || 'sample fallback'} / offline`;
  }
}

main().catch((error) => {
  console.error(error);
  $('#sourceLabel').textContent = 'render error';
  $('#updatedLabel').textContent = 'check console';
});
