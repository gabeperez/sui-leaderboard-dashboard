/**
 * generate-leaderboard.ts
 *
 * Reads a jun-produced SQLite database and writes leaderboard.json.
 * Makes one server-side RPC call for network stats (no browser RPC needed).
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
const CHECKPOINT_WINDOW = 20;
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

const latest = queryOne<{ latest: number }>(
  `SELECT MAX(checkpoint) as latest FROM transactions`
);

if (!latest?.latest) {
  console.error("No transactions found in the database.");
  process.exit(1);
}

const latestCheckpoint = latest.latest;
const windowStart = latestCheckpoint - CHECKPOINT_WINDOW + 1;

/* ── Checkpoint rows ─────────────────────────────────── */

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
`, [windowStart, CHECKPOINT_WINDOW]);

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

/* ── Top contracts ───────────────────────────────────── */

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
`, [windowStart, TOP_N]);

/* ── Active wallets ──────────────────────────────────── */

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
`, [windowStart, TOP_N]);

/* ── TPS from SQLite ─────────────────────────────────── */

let tps: number | null = null;
if (checkpoints.length >= 2) {
  const newest = checkpoints[0];
  const oldest = checkpoints[checkpoints.length - 1];
  const totalTx = checkpoints.reduce((sum, cp) => sum + cp.txCount, 0);
  const spanMs =
    new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime();
  if (spanMs > 0) tps = parseFloat((totalTx / (spanMs / 1000)).toFixed(1));
}

/* ── Network stats (one server-side RPC call) ────────── */

type NetworkStats = {
  epoch: number | null;
  validatorCount: number;
  tps: number | null;
};

async function fetchNetworkStats(): Promise<NetworkStats> {
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
    const json = (await res.json()) as { result?: { epoch?: string; activeValidators?: unknown[] } };
    const state = json.result;
    if (!state) return { epoch: null, validatorCount: 0, tps };
    return {
      epoch: state.epoch != null ? parseInt(state.epoch) : null,
      validatorCount: state.activeValidators?.length ?? 0,
      tps,
    };
  } catch (e) {
    console.warn("Network stats RPC failed:", (e as Error).message);
    return { epoch: null, validatorCount: 0, tps };
  }
}

const networkStats = await fetchNetworkStats();

/* ── Assemble & write ────────────────────────────────── */

const output = {
  source: "jun sqlite snapshot",
  updatedAt: new Date().toISOString(),
  window: `${checkpoints.length} checkpoints`,
  checkpointRange: { latestCheckpoint },
  networkStats,
  checkpoints,
  topContracts,
  activeWallets,
};

writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

console.log(`Wrote ${outPath}`);
console.log(`  Latest checkpoint : ${latestCheckpoint}`);
console.log(`  Window            : ${checkpoints.length} checkpoints`);
console.log(`  Top contracts     : ${topContracts.length}`);
console.log(`  Active wallets    : ${activeWallets.length}`);
console.log(`  Epoch             : ${networkStats.epoch ?? "unavailable"}`);
console.log(`  Validators        : ${networkStats.validatorCount}`);
console.log(`  TPS               : ${networkStats.tps ?? "unavailable"}`);

db.close();
