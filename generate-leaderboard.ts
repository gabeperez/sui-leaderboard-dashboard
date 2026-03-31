/**
 * generate-leaderboard.ts
 *
 * Reads a jun-produced SQLite database and writes leaderboard.json.
 *
 * Usage:
 *   bun generate-leaderboard.ts <path-to-jun.sqlite> [output.json]
 *
 * Jun must be run with --include events:
 *   jun stream --output live.sqlite --include events
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const SUI_RPC = "https://fullnode.mainnet.sui.io:443";

// Checkpoints shown in the live stream panel (latest N)
const STREAM_WINDOW = 20;

// Checkpoints used for leaderboard rankings (contracts, wallets)
// ~1000 checkpoints ≈ 4–5 minutes on Sui mainnet
const LEADERBOARD_WINDOW = 1000;

const TOP_N = 10;

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? "./leaderboard.json";

if (!dbPath) {
  console.error("Usage: bun generate-leaderboard.ts <jun.sqlite> [output.json]");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return db.query(sql).all(...params) as T[];
}

function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
  return (db.query(sql).get(...params) as T) ?? null;
}

/* ── Latest checkpoint ───────────────────────────────── */

const latest = queryOne<{ latest: number; oldest: number }>(
  `SELECT MAX(checkpoint) as latest, MIN(checkpoint) as oldest FROM transactions`
);

if (!latest?.latest) {
  console.error("No transactions found in the database.");
  process.exit(1);
}

const latestCheckpoint = latest.latest;

// Leaderboard window: up to LEADERBOARD_WINDOW checkpoints back
const leaderboardStart = latestCheckpoint - LEADERBOARD_WINDOW + 1;
// Stream window: latest STREAM_WINDOW checkpoints
const streamStart = latestCheckpoint - STREAM_WINDOW + 1;

/* ── Checkpoint stream (latest 20) ──────────────────── */

type CheckpointRow = {
  checkpoint: number;
  txCount: number;
  eventCount: number;
  timestamp: string;
};

const checkpointRows = query<CheckpointRow>(`
  SELECT
    t.checkpoint,
    COUNT(DISTINCT t.digest)   AS txCount,
    COUNT(e.rowid)             AS eventCount,
    MIN(t.timestamp)           AS timestamp
  FROM transactions t
  LEFT JOIN events e ON e.tx_digest = t.digest
  WHERE t.checkpoint >= ?
  GROUP BY t.checkpoint
  ORDER BY t.checkpoint DESC
  LIMIT ?
`, [streamStart, STREAM_WINDOW]);

const checkpoints = checkpointRows.map((row, i) => {
  const next = checkpointRows[i + 1];
  let finalitySeconds: number | null = null;
  if (next) {
    const diffMs =
      new Date(row.timestamp).getTime() - new Date(next.timestamp).getTime();
    if (diffMs > 0) finalitySeconds = parseFloat((diffMs / 1000).toFixed(3));
  }
  return {
    checkpoint: row.checkpoint,
    txCount: row.txCount,
    eventCount: row.eventCount,
    finalitySeconds,
    timestamp: row.timestamp,
  };
});

// Average finality from the stream window
const finalities = checkpoints.map(c => c.finalitySeconds).filter(f => f != null) as number[];
const avgFinalityMs = finalities.length > 0
  ? Math.round(finalities.reduce((a, b) => a + b, 0) / finalities.length * 1000)
  : null;

/* ── Window stats (over the leaderboard window) ──────── */

const windowAgg = queryOne<{ totalTx: number; uniqueWallets: number }>(`
  SELECT COUNT(*) AS totalTx, COUNT(DISTINCT sender) AS uniqueWallets
  FROM transactions
  WHERE checkpoint >= ?
`, [leaderboardStart]);

// New wallets: appear for the first time in this window
const newWalletsRow = queryOne<{ newWallets: number }>(`
  SELECT COUNT(DISTINCT sender) AS newWallets
  FROM transactions t1
  WHERE t1.checkpoint >= ?
    AND t1.sender IS NOT NULL
    AND t1.sender != ''
    AND NOT EXISTS (
      SELECT 1 FROM transactions t2
      WHERE t2.sender = t1.sender
        AND t2.checkpoint < ?
    )
`, [leaderboardStart, leaderboardStart]);

// Window time span
const windowTimeRow = queryOne<{ oldest: string; newest: string }>(`
  SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest
  FROM transactions
  WHERE checkpoint >= ?
`, [leaderboardStart]);

const windowDurationSeconds = windowTimeRow?.oldest && windowTimeRow?.newest
  ? Math.round(
      (new Date(windowTimeRow.newest).getTime() - new Date(windowTimeRow.oldest).getTime()) / 1000
    )
  : null;

/* ── Top contracts (leaderboard window) ──────────────── */

type ContractRow = {
  label: string;
  activity: number;
  wallets: number;
};

const topContracts = query<ContractRow>(`
  SELECT
    e.package_id || '::' || e.module AS label,
    COUNT(*)                          AS activity,
    COUNT(DISTINCT e.sender)          AS wallets
  FROM events e
  JOIN transactions t ON t.digest = e.tx_digest
  WHERE t.checkpoint >= ?
    AND e.package_id IS NOT NULL
    AND e.package_id != ''
  GROUP BY e.package_id, e.module
  ORDER BY activity DESC
  LIMIT ?
`, [leaderboardStart, TOP_N]);

/* ── Active wallets (leaderboard window) ─────────────── */

type WalletRow = {
  label: string;
  actions: number;
  lastSeen: string;
};

const activeWallets = query<WalletRow>(`
  SELECT
    sender          AS label,
    COUNT(*)        AS actions,
    MAX(timestamp)  AS lastSeen
  FROM transactions
  WHERE checkpoint >= ?
    AND sender IS NOT NULL
    AND sender != ''
    AND sender != '0x0000000000000000000000000000000000000000000000000000000000000000'
  GROUP BY sender
  ORDER BY actions DESC
  LIMIT ?
`, [leaderboardStart, TOP_N]);

/* ── Network stats (one server-side RPC call) ────────── */

type NetworkStats = {
  epoch: number | null;
  validatorCount: number;
  avgFinalityMs: number | null;
  totalTx: number;
  uniqueWallets: number;
  newWallets: number;
  windowDurationSeconds: number | null;
  windowCheckpoints: number;
};

async function fetchNetworkStats(): Promise<NetworkStats> {
  let epoch: number | null = null;
  let validatorCount = 0;

  try {
    const res = await fetch(SUI_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "system-state",
        method: "suix_getLatestSuiSystemState",
        params: [],
      }),
    });
    const json = (await res.json()) as {
      result?: { epoch?: string; activeValidators?: unknown[] };
    };
    const state = json.result;
    if (state) {
      epoch = state.epoch != null ? parseInt(state.epoch) : null;
      validatorCount = state.activeValidators?.length ?? 0;
    }
  } catch (e) {
    console.warn("Network stats RPC failed:", (e as Error).message);
  }

  return {
    epoch,
    validatorCount,
    avgFinalityMs,
    totalTx: windowAgg?.totalTx ?? 0,
    uniqueWallets: windowAgg?.uniqueWallets ?? 0,
    newWallets: newWalletsRow?.newWallets ?? 0,
    windowDurationSeconds,
    windowCheckpoints: Math.min(LEADERBOARD_WINDOW, latestCheckpoint - (latest.oldest ?? 0) + 1),
  };
}

const networkStats = await fetchNetworkStats();

/* ── Assemble & write ────────────────────────────────── */

const output = {
  source: "jun sqlite snapshot",
  updatedAt: new Date().toISOString(),
  window: windowDurationSeconds != null
    ? `~${Math.round(windowDurationSeconds / 60)} min`
    : `${LEADERBOARD_WINDOW} checkpoints`,
  checkpointRange: { latestCheckpoint },
  networkStats,
  checkpoints,
  topContracts,
  activeWallets,
};

writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

const mins = windowDurationSeconds ? `${Math.round(windowDurationSeconds / 60)}min` : "unknown";
console.log(`Wrote ${outPath}`);
console.log(`  Latest checkpoint  : ${latestCheckpoint}`);
console.log(`  Leaderboard window : ${LEADERBOARD_WINDOW} checkpoints (${mins})`);
console.log(`  Total txs          : ${networkStats.totalTx}`);
console.log(`  Unique wallets     : ${networkStats.uniqueWallets}`);
console.log(`  New wallets        : ${networkStats.newWallets}`);
console.log(`  Avg finality       : ${avgFinalityMs != null ? `${avgFinalityMs}ms` : "N/A"}`);
console.log(`  Epoch              : ${networkStats.epoch ?? "N/A"}`);
console.log(`  Validators         : ${networkStats.validatorCount}`);
console.log(`  Top contracts      : ${topContracts.length}`);
console.log(`  Top wallets        : ${activeWallets.length}`);

db.close();
