# MineVault — 2D Sandbox Mining & Passive Earning Game

A multiplayer 2D sandbox mining game where players break blocks, earn gems, and run passive "Data Center Miners" that generate real-time balance.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/game run dev` — run the game frontend (port 24631)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 with `pg` pool for raw SQL game queries
- DB: PostgreSQL + Drizzle ORM
- Frontend: React + Vite + HTML5 Canvas
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/` — DB schema (users, wallets, miners, inventories, worlds, active_tasks)
- `artifacts/api-server/src/routes/` — All game API routes
- `artifacts/api-server/src/lib/game-constants.ts` — Block rewards, miner rates, store items
- `artifacts/game/src/pages/` — React pages (Game, Miner, Inventory, Store, Leaderboard, Auth)
- `artifacts/game/src/components/Layout.tsx` — Navigation sidebar/bottom tabs

## Architecture decisions

- Authentication uses simple SHA256 hash + userId stored in localStorage, passed via `x-user-id` header on every API call (auto-injected by custom-fetch.ts)
- Game actions are fully server-validated with a fatigue system (50/100 action thresholds) and a rolling 2-minute rapid-fire detector for wizard challenge
- The 3-hour revenue pool payout runs via `setInterval` in the leaderboard router — distributes 70% of simulated ad pool to users by window_points share
- Miner balance ticks locally every 100ms using `ratePerSecond * elapsed` math for visual dopamine; server sync happens every 30 seconds
- Block-breaking uses PostgreSQL row-level locking (`FOR UPDATE`) to prevent race conditions

## Product

- **2D Canvas World**: 20×15 grid, 7 block types, player character with physics and touch/keyboard controls
- **Mining Loop**: Break blocks → earn gems + window_points + item drops, with anti-cheat fatigue scaling
- **Data Center Miner**: Level 1-10, 1-50 sats/day, temperature rises over 24h, requires water_bucket or thermal_paste to cool
- **Monetization Tasks**: 15-second verified ad tasks (drill_boost, cool_down) with server-side timestamp verification
- **Revenue Pool**: 3-hour cycle distributes 70% of simulated ad pool by player activity score
- **Store**: Buy pickaxes, solar panels, generators, cooling items, world locks with gems

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after modifying `openapi.yaml` before starting the API server
- The `pg` Pool in `artifacts/api-server/src/lib/db-pool.ts` is used for game routes (raw SQL with transactions); Drizzle ORM is used by the `@workspace/db` lib
- The revenue pool state (`simulatedAdPool`, `lastCycleTime`) is in-memory in `leaderboard.ts` — restarting the server resets the cycle timer

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
