# MineVault — 2D Sandbox Mining & Passive Earning Game

A multiplayer 2D sandbox mining game where players break blocks, earn gems, and run passive "Data Center Miners" that generate real-time balance.

## Run & Operate

```bash
# Development
pnpm --filter @workspace/api-server run dev      # API server on port 8080
pnpm --filter @workspace/mining-game run dev     # Game frontend (Vite dev server)

# Production build + start
PORT=23242 BASE_PATH=/ pnpm --filter @workspace/mining-game run build
pnpm --filter @workspace/api-server run build
PORT=8080 NODE_ENV=production pnpm --filter @workspace/api-server run start

# Database
pnpm --filter @workspace/db run push             # push Drizzle schema changes (dev only)

# API codegen (run after editing openapi.yaml)
pnpm --filter @workspace/api-spec run codegen    # regenerates hooks + Zod schemas

# Typecheck
pnpm run typecheck                               # full typecheck across all packages
```

**Required env var:** `DATABASE_URL` — Postgres connection string (set in Replit Secrets)

## Stack

| Layer | Tech |
|-------|------|
| Monorepo | pnpm workspaces, Node.js 24, TypeScript 5.9 |
| Frontend | React 18 + Vite + HTML5 Canvas (800×600 logical) |
| Backend | Express 5 (wildcard syntax: `/{*path}` not bare `*`) |
| Database | PostgreSQL + Drizzle ORM + raw `pg` Pool for game routes |
| Validation | Zod v4, drizzle-zod |
| API codegen | Orval (from OpenAPI spec at `lib/api-spec/openapi.yaml`) |
| Build | esbuild (CJS bundle for server) |

## Project Layout

```
artifacts/
  api-server/        Express 5 API server (game backend)
    src/
      app.ts          Express app entry — SPA fallback uses /{*path}
      routes/         One file per API domain:
        auth.ts         POST /api/auth/login  (SHA256 + localStorage userId)
        world.ts        GET  /api/world/:name  (block grid), POST /api/world/:name/action
        inventory.ts    GET  /api/inventory
        wallet.ts       GET  /api/wallet
        miner.ts        GET/POST /api/miner  (passive income, temperature, cooling)
        store.ts        GET/POST /api/store  (buy items with gems)
        leaderboard.ts  GET  /api/leaderboard + 3h revenue pool timer
        chat.ts         GET/POST /api/chat
      lib/
        game-constants.ts  Block rewards, miner rates, store catalogue, DAY_MS
        db-pool.ts         pg Pool (raw SQL with row-level locking)

  mining-game/       React + Vite frontend
    src/
      pages/
        Game.tsx       Main 2D canvas game (1988 lines — see section below)
        Miner.tsx      Passive miner dashboard
        Inventory.tsx  Item list
        Store.tsx      Gem shop
        Leaderboard.tsx Revenue pool standings
        Auth.tsx       Login / register
      components/
        Layout.tsx     Navigation sidebar / bottom tabs
      lib/
        custom-fetch.ts  Injects x-user-id header on every API call

lib/
  api-spec/openapi.yaml   API contract (source of truth for codegen)
  db/src/schema/          Drizzle schema: users, wallets, miners, inventories,
                          worlds, active_tasks
```

## Game.tsx Architecture (the big file)

`artifacts/mining-game/src/pages/Game.tsx` (~2000 lines) is the heart of the game.
Key sections (in order):

1. **Constants** — WW/WH (800×600 canvas), BS (block size), MOVE_SPEED, JUMP_VY, DAY_MS (15 min cycle), REACH
2. **Block data** — BLOCK_COLORS, BLOCK_TINTS, BLOCK_HITS, BLOCK_LABELS, PLACEABLE set, MACHINE_BLOCKS set
3. **`getSky(now)`** — Returns sky gradient + overlay alpha for day/night cycle. Takes `Date.now()` (wall-clock) so all players share the same sky. Full day: t=0.30–0.68 (38% of cycle ≈ 5.7 min). Returns `{ r, g, b, alpha, stars }`.
4. **Pixel-art renderers** — `drawMachineCore`, `drawSolarPanel`, `drawPipe`, `drawLampBlock`, `drawCracks`, `drawPunchFlash`, `drawWaterSplash`
5. **Solar network BFS** — `isSolarPanelExposed`, `isSolarPanelWired`, `isCoreConnectedToPower` — determines whether machine blocks are powered
6. **Light map** — `buildLightMap(bd)` computes per-block sunlight exposure (0.0–1.0) via flood fill
7. **React component** — `Game()` with:
   - Refs: `canvasRef`, `physRef` (player physics), `worldRef`, `camRef`, `zoomRef`, `rafRef`, `breakingRef`, `flashRef`, `waterSplashRef`, `lightMapRef`, `starsRef`
   - State: `mode` (punch/place), `selectedBlock`, `wizard`, `chatOpen`, `isDay` (solar badge, 3s poll)
   - **`drawFrame`** — `useCallback` rAF loop: clear → sky → stars → sun/moon → camera transform → blocks → player → lamp halos → restore → night overlay → scanlines
   - Physics: gravity, velocity, collision detection against solid blocks, camera follow
   - Joystick: pointer capture on a 90×90 div overlay; horizontal = move, drag up 40% = jump
   - Canvas click: normalizes coords via `getBoundingClientRect` → world coords → mine/place/water-bucket

## API Routes Reference

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login or register (returns userId + username) |
| GET | `/api/world/:name` | Fetch block grid + metadata |
| POST | `/api/world/:name/action` | Break / place / maintain a block |
| POST | `/api/world/:name/expand` | Spend 200 gems to add 5 columns |
| GET | `/api/inventory` | Player item list |
| GET | `/api/wallet` | Gems + action count |
| GET | `/api/miner` | Passive miner state (level, temp, balance) |
| POST | `/api/miner/upgrade` | Level up miner (costs gems) |
| POST | `/api/miner/collect` | Collect accumulated miner balance |
| POST | `/api/miner/task` | Start a 15s ad task (drill_boost / cool_down) |
| POST | `/api/miner/task/complete` | Complete task + claim reward |
| GET | `/api/store` | Store catalogue |
| POST | `/api/store/buy` | Buy an item with gems |
| GET | `/api/leaderboard` | Top players + revenue pool state |
| GET | `/api/chat` | Last 50 chat messages |
| POST | `/api/chat` | Send a chat message |

## Key Architecture Decisions

- **Auth**: SHA256 hash + userId stored in `localStorage`, sent as `x-user-id` header on every request (injected by `custom-fetch.ts`). No session cookies.
- **Game actions**: Server-validated with fatigue system (warn at 50, cap at 100 actions/window). Rolling 2-min rapid-fire detector triggers `wizardChallenge` anti-bot CAPTCHA.
- **Block breaking**: PostgreSQL row-level locking (`SELECT … FOR UPDATE`) prevents race conditions in multiplayer.
- **Passive miner balance**: Ticks locally every 100ms for visual dopamine (`ratePerSecond × elapsed`); syncs with server every 30s.
- **Revenue pool**: 3-hour cycle distributes 70% of simulated ad pool to players by `window_points` share. Timer lives in-memory in `leaderboard.ts` — restarting server resets the clock.
- **Day/night cycle**: `getSky(Date.now())` — uses wall-clock time so all players share the same sky. 15-minute full cycle (`DAY_MS = 900_000`). Solar panels only generate power when `dayFactor > 0.15`.
- **Express 5 wildcard**: SPA fallback must use `app.get("/{*path}", ...)` — bare `"*"` fails in Express 5.
- **Canvas aspect ratio**: Canvas is 800×600 (4:3). CSS uses `maxWidth/maxHeight: 100%, width/height: auto, aspectRatio` so portrait mobile letterboxes rather than stretches. Click coords always normalised via `getBoundingClientRect`.

## Gotchas

- Always run `pnpm --filter @workspace/api-spec run codegen` after editing `openapi.yaml`
- The `pg` Pool (`db-pool.ts`) is for game routes (raw SQL + transactions); Drizzle ORM is used by the `@workspace/db` lib for schema management
- Revenue pool state is in-memory — server restart resets the 3h cycle timer
- `DAY_MS` is defined in `game-constants.ts` on the server AND duplicated as a constant in `Game.tsx` — keep them in sync if you change the cycle length
- Block type strings (e.g. `"stone"`, `"machine_core"`) must match between `BLOCK_COLORS` in Game.tsx and the server's block validation whitelist

## User preferences

- Add developer comments to code files so the codebase is readable for future developers
