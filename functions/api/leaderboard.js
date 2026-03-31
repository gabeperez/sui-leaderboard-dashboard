/**
 * Cloudflare Pages Function — /api/leaderboard
 *
 * Returns live checkpoint stream + network stats on every request.
 * Cloudflare edge caches the response for 30 seconds, so the RPC is
 * called at most once per 30s per PoP regardless of traffic.
 *
 * The dashboard merges this with /leaderboard.json (updated by GitHub
 * Actions via jun) for top protocols and power users.
 */

const SUI_RPC = 'https://fullnode.mainnet.sui.io:443';

export async function onRequest() {
  try {
    const data = await fetchLiveData();
    return new Response(JSON.stringify(data), {
      headers: {
        'content-type': 'application/json',
        // Cloudflare edge caches for 30s; browser re-validates after 15s
        'cache-control': 'public, s-maxage=30, max-age=15',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err.message) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function rpc(method, params = []) {
  const res = await fetch(SUI_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || `${method} RPC error`);
  return json.result;
}

async function fetchLiveData() {
  // Two RPC calls, run in parallel
  const [cpPage, sysState] = await Promise.all([
    rpc('sui_getCheckpoints', [null, 20, true]),
    rpc('suix_getLatestSuiSystemState'),
  ]);

  const cpData = cpPage?.data ?? [];

  const checkpoints = cpData.map((cp, i) => {
    const prev = cpData[i + 1];
    // transactions is an array of digests — its length is the tx count
    const txCount = Array.isArray(cp.transactions)
      ? cp.transactions.length
      : parseInt(cp.numTransactionBlocks ?? '0');
    const ms = parseInt(cp.timestampMs);
    const prevMs = prev ? parseInt(prev.timestampMs) : null;
    const finalitySeconds = prevMs != null && ms > prevMs
      ? (ms - prevMs) / 1000
      : null;
    return {
      checkpoint: parseInt(cp.sequenceNumber),
      txCount,
      eventCount: 0,          // events need an indexer
      finalitySeconds,
      timestamp: new Date(ms).toISOString(),
    };
  });

  // Avg finality across available checkpoint gaps
  const fins = checkpoints.map(c => c.finalitySeconds).filter(f => f != null && f > 0);
  const avgFinalityMs = fins.length
    ? Math.round(fins.reduce((a, b) => a + b, 0) / fins.length * 1000)
    : null;

  // TPS over the stream window
  let tps = null;
  if (checkpoints.length >= 2) {
    const totalTx = checkpoints.reduce((s, c) => s + c.txCount, 0);
    const spanMs =
      new Date(checkpoints[0].timestamp) - new Date(checkpoints.at(-1).timestamp);
    if (spanMs > 0) tps = parseFloat((totalTx / (spanMs / 1000)).toFixed(1));
  }

  return {
    source: 'sui rpc · live',
    updatedAt: new Date().toISOString(),
    window: '20 checkpoints',
    networkStats: {
      epoch: sysState?.epoch != null ? parseInt(sysState.epoch) : null,
      validatorCount: sysState?.activeValidators?.length ?? 0,
      avgFinalityMs,
      tps,
      totalTx: checkpoints.reduce((s, c) => s + c.txCount, 0),
      // These come from the indexed leaderboard.json, not live RPC:
      uniqueWallets: null,
      newWallets: null,
      windowDurationSeconds: checkpoints.length >= 2
        ? Math.round(
            (new Date(checkpoints[0].timestamp) - new Date(checkpoints.at(-1).timestamp)) / 1000
          )
        : null,
      windowCheckpoints: checkpoints.length,
    },
    checkpoints,
    // Populated client-side by merging with /leaderboard.json
    topContracts: [],
    activeWallets: [],
  };
}
