/**
 * generate-leaderboard.ts
 *
 * Reads a jun-produced SQLite database and writes leaderboard.json
 * in the format expected by the dashboard.
 *
 * Usage:
 *   bun generate-leaderboard.ts <path-to-jun.sqlite> [output.json]
 *
 * If no output path is given, writes to ./leaderboard.json.
 *
 * Jun must be run with --include events to populate the events table:
 *   jun stream --output live.sqlite --include events
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";

const CHECKPOINT_WINDOW = 20; // how many recent checkpoints to summarise
const TOP_N = 10; // contracts and wallets to show

const dbPath = process.argv[2];
const outPath = process.argv[3] ?? "./leaderboard.json";

if (!dbPath) {
  console.error("Usage: bun generate-leaderboard.ts <jun.sqlite> [output.json]");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

/* ── Helpers ─────────────────────────────────────────── */

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

// Transactions table has per-checkpoint timestamp — grab MIN (all same within a checkpoint)
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

// Compute finality as the gap between consecutive checkpoint timestamps (ms → s)
const checkpoints = checkpointRows.map((row, i) => {
  const next = checkpointRows[i + 1]; // older checkpoint
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

// Uses the events table: package_id + module identify the contract
// Falls back gracefully if the events table is empty (--include events not set)
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

// Uses the transactions table: sender = wallet address
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

/* ── Assemble & write ────────────────────────────────── */

const output = {
  source: "jun live sqlite snapshot",
  updatedAt: new Date().toISOString(),
  window: `${checkpoints.length} checkpoints`,
  checkpointRange: { latestCheckpoint },
  checkpoints,
  topContracts,
  activeWallets,
};

const json = JSON.stringify(output, null, 2);
writeFileSync(outPath, json, "utf-8");

console.log(`Wrote ${outPath}`);
console.log(`  Latest checkpoint : ${latestCheckpoint}`);
console.log(`  Window            : ${checkpoints.length} checkpoints`);
console.log(`  Top contracts     : ${topContracts.length}`);
console.log(`  Active wallets    : ${activeWallets.length}`);

db.close();
