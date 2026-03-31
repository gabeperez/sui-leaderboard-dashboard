# sui-leaderboard-dashboard

Live Sui leaderboard dashboard. Checkpoint stream is fetched directly from the Sui RPC. Top contracts and active wallets are powered by [jun](https://github.com/unconfirmedlabs/jun).

## How it works

- **Checkpoint stream** — fetched live from `fullnode.mainnet.sui.io` every 30 seconds (no local indexing required)
- **Top contracts / active wallets** — aggregated from a jun SQLite snapshot and served as `leaderboard.json`

## Setup

```bash
# 1. Install dependencies (Bun required)
git clone --recurse-submodules https://github.com/gabeperez/sui-leaderboard-dashboard
cd sui-leaderboard-dashboard
bun install           # installs jun from the submodule

# 2. Stream live Sui checkpoints into a SQLite database (keep this running)
bun jun/src/cli.ts stream --output live.sqlite --include events

# 3. Export leaderboard.json from the SQLite (run as often as you want fresh data)
bun generate-leaderboard.ts live.sqlite leaderboard.json
```

Then deploy `index.html`, `script.js`, `styles.css`, and `leaderboard.json` to Cloudflare Pages (or any static host).

## Refreshing leaderboard data

Run the export script on a schedule to keep contracts/wallets fresh. Example with `watch` (macOS/Linux):

```bash
watch -n 60 'bun generate-leaderboard.ts live.sqlite leaderboard.json && echo Refreshed'
```

Or a simple cron:

```
* * * * * cd /path/to/repo && bun generate-leaderboard.ts live.sqlite leaderboard.json
```

After regenerating, redeploy or upload the new `leaderboard.json` to your static host.

## Jun SQLite schema

`generate-leaderboard.ts` expects the tables that jun creates with `--include events`:

| Table | Key columns used |
|---|---|
| `transactions` | `checkpoint`, `digest`, `sender`, `timestamp` |
| `events` | `tx_digest`, `package_id`, `module`, `sender` |
