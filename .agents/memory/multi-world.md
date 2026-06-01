---
name: Multi-world system
description: Architecture for Growtopia-style named worlds with seeded terrain generation and per-player position persistence.
---

## World routing
- `/game` → WorldSelect page (world name input, recent worlds list, active worlds from server)
- `/game/:worldName` → Game component receives `worldName` as prop (not useParams)
- App.tsx uses wouter render-prop pattern: `<Route path="/game/:worldName">{(params) => <Game worldName={...} />}</Route>`

## Seeded world generation
- World names are hashed with FNV-1a → mulberry32 PRNG so same name = identical terrain on any server
- Always hash UPPER-CASE name so "farm" and "FARM" produce the same world
- `generateSeededGrid(worldName)` in `artifacts/api-server/src/routes/world.ts`

## Player positions
- Table: `player_positions` (user_id, world_name, x, y) with UNIQUE on (user_id, world_name)
- Server: `GET /api/world/:name` returns `savedPosition: { x, y } | null` alongside blockData
- Server: `POST /api/world/:name/position` upserts position
- Client: reads savedPosition from world response (cast via `world as unknown as { savedPosition }`)
- Client: autosaves every 10s + on component unmount via useEffect cleanup

**Why:** Separate position fetch would create a race condition (world loads first, player spawns at surface before position arrives). Embedding in world response atomically solves this.

## Expand world removed
- `/api/world/expand` route deleted from world.ts
- `expandBusy` state and `expandWorld` useCallback removed from Game.tsx
- HUD now shows a world-name badge (`🌍 WORLDNAME`) that navigates back on click

## OpenAPI type gap
- `savedPosition` field added to server response but NOT to openapi.yaml/codegen
- Cast approach: `(world as unknown as { savedPosition?: { x,y } | null }).savedPosition`
- **Why:** Avoids regenerating all hooks just for one extra field; position is optional and falls back gracefully

## Recent worlds
- Stored in localStorage under `"recentWorlds"` as string[] (max 10)
- Deduped + prepended on each visit (most recent first)
