---
name: pg PoolClient typing
description: How to correctly type pg PoolClient parameters in TypeScript to avoid "Property 'query' does not exist on type 'void'" errors
---

## The Rule

Always import `PoolClient` from `"pg"` and use it directly as the parameter type for functions that accept a pool client.

```typescript
import type { PoolClient } from "pg";

async function myFunction(client: PoolClient, ...) { ... }
```

**Never** use:
```typescript
client: Awaited<ReturnType<typeof pool.connect>>
```

**Why:** `pool.connect` is overloaded in the `pg` types — it has both `() => Promise<PoolClient>` and `(callback) => void` signatures. TypeScript's `typeof` + `ReturnType` picks the **last** overload, which is the callback form returning `void`. So `Awaited<ReturnType<typeof pool.connect>>` resolves to `void` instead of `PoolClient`, causing all `.query()` calls to fail typechecking and call-sites to get "PoolClient not assignable to void" errors.

**How to apply:** Any time a helper function accepts a `pg` pool client passed in from a route handler, import `PoolClient` directly and use it as the parameter type.
