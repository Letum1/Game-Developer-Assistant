---
name: NaN serializes as null in JSON
description: JavaScript NaN is not valid JSON — JSON.stringify(NaN) produces "null", causing null.toFixed() crashes on the client.
---

## The rule
`JSON.stringify(NaN)` → `"null"`. Any server field computed from a missing/undefined constant that yields NaN will arrive at the client as `null`. Calling `.toFixed()` on it then throws: "Cannot read properties of null (reading 'toFixed')".

**Why:** This happened in `admin.ts` which imported `TEMP_RISE_PER_HOUR` from `game-constants.ts` — but that constant was never exported. The file only exports `HEAT_PER_RIG_PER_HOUR`, `HEAT_PER_BATTERY_PER_HOUR`, `HEAT_PER_GENERATOR_PER_HOUR`, `FAN_COOLING_PER_HOUR`, `MIN_HEAT_PER_HOUR`. The undefined import made `effectiveTempRise = NaN`, which serialized as `null`, crashing the Admin page.

**How to apply:**
1. Always compute heat/temp in admin routes using the correct per-appliance constants (same formula as the real passive-tick in miner.ts).
2. Add `?? 0` null guards on every `.toFixed()` call that touches numeric fields returned from the server — they can be null if the server computed NaN.
3. When adding new numeric fields to a server response, verify no arithmetic path yields NaN before serializing.
