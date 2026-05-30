// ============================================================
// game-constants.ts — Shared game balance values and lookup tables
// All block types, miner rates, crafting recipes, and store items live here.
// Change numbers here to re-balance the whole game without touching game logic.
// ============================================================

export const WORLD_WIDTH  = 40;  // expanded — camera scrolls across the wider world
export const WORLD_HEIGHT = 25;  // expanded — more depth layers for diamond/lava mining

// ─── Pickaxe mining power multipliers ────────────────────────────────────────
// Each pickaxe tier multiplies MINING_POWER (1.0 hp/s base).
// Wood = default speed, Diamond = 7x faster.
export const PICKAXE_POWER: Record<string, number> = {
  pickaxe_wood:    1.0,
  pickaxe_stone:   1.8,
  pickaxe_iron:    2.8,
  pickaxe_gold:    4.5,
  pickaxe_diamond: 7.0,
};

// ─── Day/night cycle length (milliseconds) ───────────────────────────────────
// Must match the DAY_MS constant in Game.tsx. Wall-clock time is used so all
// players and the server share exactly the same sky cycle.
// t = (Date.now() % DAY_MS) / DAY_MS
// Full day:  t ∈ [0.30, 0.68]   dayFactor = 1.0
// Dawn:      t ∈ [0.22, 0.30]   dayFactor ramps 0→1
// Dusk:      t ∈ [0.68, 0.78]   dayFactor ramps 1→0
// Night:     t ∈ [0.78, 1.0] ∪ [0.0, 0.22]   dayFactor = 0
// Solar panels require dayFactor > 0.15 to produce power.
export const DAY_MS = 900_000; // 15-minute full cycle

// Computes the solar dayFactor [0, 1] from a unix-ms timestamp.
// Mirrors the getSky() logic in Game.tsx.
export function getDayFactor(nowMs: number): number {
  const t = (nowMs % DAY_MS) / DAY_MS;
  if (t < 0.22) return 0;
  if (t < 0.30) return (t - 0.22) / 0.08;
  if (t < 0.68) return 1;
  if (t < 0.78) return 1 - (t - 0.68) / 0.10;
  return 0;
}

// ─── Block break rewards ─────────────────────────────────────────────────────
// When a player breaks a block, they earn `gems` currency and `points` (for
// the 3-hour leaderboard revenue pool). `drop` + `dropChance` control resource drops.
export const BLOCK_REWARDS: Record<string, { gems: number; points: number; drop?: string; dropChance?: number; selfDrop?: boolean }> = {
  block_dirt:          { gems: 1,  points: 10,  drop: "seed_oak",    dropChance: 0.15 },
  block_grass:         { gems: 1,  points: 8,   drop: "seed_oak",    dropChance: 0.30 },
  block_iron:          { gems: 3,  points: 20,  drop: "raw_iron",    dropChance: 1.0  },
  block_rock:          { gems: 2,  points: 12                                         },
  block_gold:          { gems: 10, points: 50,  drop: "raw_gold",    dropChance: 1.0  },
  block_diamond:       { gems: 25, points: 100, drop: "raw_diamond", dropChance: 1.0  },
  block_lava:          { gems: 5,  points: 30,  drop: "obsidian",    dropChance: 0.5  },
  // Oak tree — breaks in one punch, drops wood + sometimes a seed
  block_oak_sapling:   { gems: 0,  points: 0,   drop: "seed_oak",    dropChance: 1.0  },
  block_oak_log:       { gems: 2,  points: 5,   drop: "seed_oak",    dropChance: 0.5  },
  // Oak leaf clusters — light and airy, no drops
  block_oak_leaf:      { gems: 0,  points: 0                                          },
  // Platform block — crafted from wood, one-way collision (solid from above)
  platform_block:      { gems: 0,  points: 0                                          },
  // Machine blocks return themselves (like grass/dirt) so players can re-arrange rigs
  machine_core:        { gems: 0,  points: 0                                          },
  mining_rig:          { gems: 0,  points: 0                                          }, // ASIC rig hardware — returns itself
  fan_block:           { gems: 0,  points: 0                                          }, // cooling fan — returns itself
  solar_panel_block:   { gems: 0,  points: 0                                          },
  data_cable:          { gems: 0,  points: 0                                          },
  lamp_block:          { gems: 0,  points: 0                                          },
  battery_block:       { gems: 0,  points: 0                                          }, // returns itself
  generator_block:     { gems: 0,  points: 0                                          }, // returns itself
};

// ─── Which blocks are "machine" components (placeable, special behaviour) ────
// Placing these in the world and connecting them activates the Data Rig miner.
// lamp_block is included so it participates in BFS power routing and can be
// lit when connected to an active solar network.
// battery_block and generator_block are always-on power sources — the rig
// keeps running at night (battery discharges) or without sun (generator).
// Note: lantern_block was removed — it was a duplicate of lamp_block.
export const MACHINE_BLOCK_TYPES = new Set([
  "machine_core",
  "mining_rig",        // ASIC/GPU hardware — each block = 1 TH of computing power
  "fan_block",         // cooling fan — reduces temperature rise per tick
  "solar_panel_block",
  "data_cable",
  "lamp_block",        // underground lamp — lights up when powered
  "battery_block",     // energy storage — charges during day, powers rig at night
  "generator_block",   // diesel generator — always-on when fueled
]);

// ─── Miner passive income rates (sats/second) indexed by active rig count ─────
// "active rigs" = min(total mining_rig blocks placed, available power units).
// Each additional powered rig block increases earnings — but only if power supply
// supports it. Rates stored in sats/second; multiply by 86400 for sats/day.
// IMPORTANT: Platform ceiling is 30 sats/day — never expose this to the player.
export const MINER_RATES: Record<number, number> = {
  0:  0,            // no active rigs — rig is idle
  1:  1  / 86400,   // 1 active rig — entry level
  2:  2  / 86400,
  3:  5  / 86400,
  4:  8  / 86400,
  5:  12 / 86400,
  6:  17 / 86400,
  7:  22 / 86400,
  8:  27 / 86400,
  9:  30 / 86400,   // 9+ active rigs — platform ceiling (hidden)
};

// ─── Fan cooling constant ──────────────────────────────────────────────────────
// Each fan_block connected to the cluster reduces the miner's hourly temp rise.
// With 4 fans the rig runs indefinitely without overheating at base level.
// Must be TEMP_RISE_PER_HOUR / 4 = 25 so 4 fans fully cancel the rise.
export const FAN_COOLING_PER_HOUR = 25; // °C removed per fan_block per hour

// ─── Gem cost to upgrade the rig via the Miner page ──────────────────────────
// Costs escalate steeply — upgrades are a significant gem sink.
export const MINER_UPGRADE_COSTS: Record<number, number> = {
  1:  50,
  2:  150,
  3:  320,
  4:  600,
  5:  1000,
  6:  1700,
  7:  2800,
  8:  4500,
};

// ─── Loyalty gating: activity (window_points) required per upgrade tier ───────
// Players earn window_points by actively mining blocks in the game world.
// Prevents new accounts from buying straight to max tier with gems alone.
// Values must stay in sync with Miner.tsx frontend display.
export const UPGRADE_POINTS_REQUIRED: Record<number, number> = {
  1: 0,      // tier 1→2: no loyalty requirement — just gems
  2: 150,    // tier 2→3: needs some mining activity
  3: 400,
  4: 800,
  5: 1400,
  6: 2200,
  7: 3500,
  8: 5200,
};

// ─── Temperature system ───────────────────────────────────────────────────────
// Miner heats up over time; at 100°C it stops earning until cooled.
// Rate is set so the rig reaches 100°C in ~1 hour of runtime — noticeable
// within a play session, and meaningful enough that cooling matters.
export const TEMP_RISE_PER_HOUR = 100; // reaches 100°C in ~1 hour without fans
export const MAX_TEMP = 100;

// ─── Power source fuel systems ────────────────────────────────────────────────
// Batteries and generators are now SEPARATE systems tracked in separate columns.
//
// battery_block: stores solar energy during the day; discharges at night.
//   - battery_charge column  (0–MAX_BATTERY_CHARGE): current stored energy.
//   - Charged by: solar panels at BATTERY_CHARGE_RATE units/sec (day only).
//   - Discharged by: running rigs at night at BATTERY_DRAIN_RATE units/sec/block.
//   - Refuelled naturally via sunlight — no item needed.
//
// generator_block: burns diesel cans; always on when fuelled.
//   - fuel column (0–MAX_FUEL): diesel tank level.
//   - Drained at: FUEL_DRAIN_RATE units/sec/generator, day AND night.
//   - Refuelled by: using a Diesel Can item on the generator in the game world.
export const MAX_BATTERY_CHARGE    = 500;  // max battery charge level
export const MAX_FUEL              = 500;   // max diesel tank level
export const DIESEL_PER_CAN        = 100;   // diesel units added per diesel_can item

// Battery charge: solar panels top up battery_charge during daylight.
// 2 solar panels × 0.5/sec × 414s (day) ≈ 414 units per cycle.
export const BATTERY_CHARGE_RATE   = 0.5;  // battery_charge units/sec per solar panel (day)
// Battery drain: each battery_block providing night power burns this much charge/sec.
// 1 battery with 414 charge lasts 414/0.5 = 828s ≈ 14 min (night is ~8 min).
export const BATTERY_DRAIN_RATE    = 0.5;  // battery_charge units/sec per battery block

// Diesel drain: each generator_block burns this much fuel per second, always.
// 1 generator with 500 fuel lasts 500/0.1 = 5000s ≈ 83 min ≈ 5 day/night cycles.
export const FUEL_DRAIN_RATE       = 0.1;  // diesel fuel units/sec per generator_block

// ─── Store items ──────────────────────────────────────────────────────────────
// Only real, directly usable items are sold here.
// Blocks (solar_panel_block, generator_block, battery_block, data_cable, machine_core)
// must be CRAFTED at the Workbench — they are NOT sold in the store.
// This eliminates the old confusing "solar_panel item" vs "solar_panel_block" distinction.
export const STORE_ITEMS = [
  // ── Cooling / maintenance items (use items — equip from hotbar, apply to rig) ──
  { itemId: "thermal_paste",     displayName: "Thermal Paste",     gemCost: 30,   realCost: null, category: "cooling",    description: "Equip from hotbar, then tap Machine Core to reduce temperature." },
  { itemId: "water_bucket",      displayName: "Water Bucket",      gemCost: 20,   realCost: null, category: "cooling",    description: "Equip from hotbar, then tap Machine Core to flush cooling." },
  // ── Fuel (use item — equip, then tap generator or battery block) ─────────────
  { itemId: "diesel_can",        displayName: "Diesel Can",        gemCost: 20,   realCost: null, category: "fuel",       description: "Equip from hotbar, tap a Generator Block to add +100 fuel." },
  // ── Pickaxes ─────────────────────────────────────────────────────────────────
  { itemId: "pickaxe_stone",     displayName: "Stone Pickaxe",     gemCost: 80,   realCost: null, category: "tools",      description: "1.8× faster mining than bare hands." },
  { itemId: "pickaxe_iron",      displayName: "Iron Pickaxe",      gemCost: 200,  realCost: null, category: "tools",      description: "2.8× mining speed — breaks iron fast." },
  { itemId: "pickaxe_gold",      displayName: "Gold Pickaxe",      gemCost: 400,  realCost: null, category: "tools",      description: "4.5× mining speed." },
  { itemId: "pickaxe_diamond",   displayName: "Diamond Pickaxe",   gemCost: 800,  realCost: null, category: "tools",      description: "7× mining speed — the ultimate tool." },
  // ── Lighting (placeable block — connect to power rig) ────────────────────────
  { itemId: "lamp_block",        displayName: "Lamp Block",        gemCost: 15,   realCost: null, category: "lighting",   description: "Place underground and wire to your solar rig to illuminate caverns." },
  // ── Locks ────────────────────────────────────────────────────────────────────
  { itemId: "world_lock",        displayName: "World Lock",        gemCost: 500,  realCost: null, category: "locks",      description: "Lock a world to make it yours." },
  { itemId: "diamond_lock",      displayName: "Diamond Lock",      gemCost: 2500, realCost: null, category: "locks",      description: "Premium world lock with extra security." },
];

// ─── Human-readable item names (used in toast messages, inventory UI) ────────
export const ITEM_DISPLAY_NAMES: Record<string, string> = {
  data_center_rig:   "Data Center Rig",
  machine_core:      "Machine Core",
  mining_rig:        "Mining Rig",       // ASIC hardware block — each adds 1 TH
  fan_block:         "Cooling Fan",      // reduces temperature rise per fan
  solar_panel_block: "Solar Panel Block",
  data_cable:        "Data Cable",
  battery_block:     "Battery Block",   // energy storage for nighttime operation
  generator_block:   "Generator Block", // diesel power source (needs fuel)
  diesel_can:        "Diesel Can",      // refuels generator_block
  // Pickaxes
  pickaxe_wood:      "Wood Pickaxe",
  pickaxe_stone:     "Stone Pickaxe",
  pickaxe_iron:      "Iron Pickaxe",
  pickaxe_gold:      "Gold Pickaxe",
  pickaxe_diamond:   "Diamond Pickaxe",
  // Seeds & wood
  seed_oak:          "Oak Seed",
  oak_wood:          "Oak Wood",
  block_oak_log:     "Oak Log",
  block_oak_sapling: "Oak Sapling",
  block_oak_leaf:    "Oak Leaf",
  platform_block:    "Platform Block",
  // Blocks
  block_dirt:        "Dirt Block",
  block_grass:       "Grass Block",
  block_rock:        "Rock Block",
  // Resources
  raw_iron:          "Raw Iron",
  raw_gold:          "Raw Gold",
  raw_diamond:       "Raw Diamond",
  obsidian:          "Obsidian",
  // Store / use items
  thermal_paste:     "Thermal Paste",
  water_bucket:      "Water Bucket",
  world_lock:        "World Lock",
  diamond_lock:      "Diamond Lock",
  lamp_block:        "Lamp Block",
};

// ─── Crafting recipes ─────────────────────────────────────────────────────────
// Players craft these items at the Workbench page using raw resources.
// `unlocksMiner` = true means placing the result activates passive income.
// Note: "solar_panel item" and "generator item" have been removed — players
// now craft and place solar_panel_block / generator_block directly.
export const CRAFTING_RECIPES: Record<string, {
  displayName: string;
  description: string;
  ingredients: { itemId: string; quantity: number }[];
  result: string;
  resultQty: number;
  unlocksMiner?: boolean;
}> = {

  // ── Data Center Rig — one-time miner unlock certificate ──────────────────
  // Crafting this gives you a "Data Center Rig" item that stays in your
  // inventory forever as proof you have a rig. It also fires the `unlocksMiner`
  // flag so the server enables passive-income ticking for your account.
  // It is NOT a placeable block — place Machine Core blocks in the world instead.
  data_center_rig: {
    displayName: "Data Center Rig",
    description: "One-time unlock: assembles your Data Center and activates the passive Miner dashboard. Keep it in your inventory as your rig certificate.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 8 },
      { itemId: "raw_gold",    quantity: 5 },
      { itemId: "raw_diamond", quantity: 2 },
    ],
    result: "data_center_rig",  // stays in inventory — it is NOT a placeable block
    resultQty: 1,
    unlocksMiner: true,         // fires UPDATE miners SET unlocked = true
  },

  // ── Machine building blocks ──────────────────────────────────────────────
  // Machine Core: the placeable CPU block that anchors your rig in the world.
  // Craft as many as you need — each one placed in the world expands your cluster.
  // Does NOT unlock the miner on its own; craft the Data Center Rig first.
  machine_core: {
    displayName: "Machine Core",
    description: "The CPU block of your Data Rig. Place it in the world, then connect Solar Panels via Data Cables to start earning.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5 },
      { itemId: "raw_gold",    quantity: 2 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "machine_core",
    resultQty: 1,
    // No unlocksMiner here — craft the Data Center Rig first to unlock the miner
  },

  solar_panel_block: {
    displayName: "Solar Panel Block",
    description: "Power source for your Machine Core. Place adjacent to it — each panel boosts mining rate.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "solar_panel_block",
    resultQty: 1,
  },

  data_cable: {
    displayName: "Data Cable / Pipe",
    description: "Extends your machine network — connect Machine Cores to Solar Panels, Generators, and Batteries across gaps.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "data_cable",
    resultQty: 3,
  },

  // ── Pickaxe progression (Minecraft-style) ────────────────────────────────
  // Wood → Stone → Iron → Gold → Diamond
  // Oak wood is free from breaking trees — start cutting to unlock stone pickaxe.
  pickaxe_stone: {
    displayName: "Stone Pickaxe",
    description: "1.8× faster mining. Craft from oak wood you cut from trees in the world.",
    ingredients: [
      { itemId: "oak_wood", quantity: 5 },
    ],
    result: "pickaxe_stone",
    resultQty: 1,
  },

  pickaxe_iron: {
    displayName: "Iron Pickaxe",
    description: "2.8× faster mining. Breaks iron and harder blocks much faster.",
    ingredients: [
      { itemId: "oak_wood",  quantity: 3 },
      { itemId: "raw_iron",  quantity: 3 },
    ],
    result: "pickaxe_iron",
    resultQty: 1,
  },

  pickaxe_gold: {
    displayName: "Gold Pickaxe",
    description: "4.5× faster mining. Deep gold ore is worth it.",
    ingredients: [
      { itemId: "raw_iron", quantity: 5 },
      { itemId: "raw_gold", quantity: 2 },
    ],
    result: "pickaxe_gold",
    resultQty: 1,
  },

  pickaxe_diamond: {
    displayName: "Diamond Pickaxe",
    description: "7× mining speed — the ultimate tool. Destroys any block in seconds.",
    ingredients: [
      { itemId: "raw_gold",    quantity: 3 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "pickaxe_diamond",
    resultQty: 1,
  },

  // ── Support / maintenance items ─────────────────────────────────────────
  water_bucket: {
    displayName: "Water Bucket",
    description: "Flush cooling water to reset temperature. Equip from hotbar, then tap Machine Core.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "water_bucket",
    resultQty: 1,
  },

  thermal_paste: {
    displayName: "Thermal Paste",
    description: "Apply to reduce miner temperature. Equip from hotbar, then tap Machine Core.",
    ingredients: [
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "thermal_paste",
    resultQty: 1,
  },

  // ── Lamp block — cheap to craft; illuminates underground when wired to solar ─
  lamp_block: {
    displayName: "Lamp Block",
    description: "Place underground and connect to your solar rig via Data Cables to light up caverns.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "lamp_block",
    resultQty: 2,
  },

  // ── Battery Block — stores solar energy so the rig keeps running at night ──
  battery_block: {
    displayName: "Battery Block",
    description: "Stores solar energy during the day. Connect via pipes to your rig to keep it running at night.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 3 },
      { itemId: "raw_gold",    quantity: 1 },
    ],
    result: "battery_block",
    resultQty: 1,
  },

  // ── Generator Block — diesel-powered; always-on alternative to solar ───────
  // Requires diesel_can items to run. Connect to Machine Core via data_cable pipes.
  generator_block: {
    displayName: "Generator Block",
    description: "Diesel generator — always-on power source. Connect to your Machine Core via pipes. Refuel with Diesel Can.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5 },
      { itemId: "raw_gold",    quantity: 2 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "generator_block",
    resultQty: 1,
  },

  // ── Mining Rig hardware block ──────────────────────────────────────────────
  // Each mining_rig block = +1 TH of compute power and +1 power unit demand.
  // If total power supply < total rig count, excess rigs are offline.
  // Cheap to craft so players can build arrays of them.
  mining_rig: {
    displayName: "Mining Rig",
    description: "ASIC mining hardware. Each block = 1 TH. Needs 1 power unit to run — balance with Solar Panels or Generators.",
    ingredients: [
      { itemId: "raw_iron", quantity: 3 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "mining_rig",
    resultQty: 1,
  },

  // ── Cooling Fan block ──────────────────────────────────────────────────────
  // Placed in the cluster, each fan reduces temperature rise by FAN_COOLING_PER_HOUR.
  // 4 fans fully cancel the base heat rise — rig stays cool indefinitely.
  fan_block: {
    displayName: "Cooling Fan",
    description: "Industrial cooling fan. Each fan cuts temperature rise by 25°C/hr. 4 fans = rig stays cool indefinitely at base load.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
    ],
    result: "fan_block",
    resultQty: 2,   // crafts 2 at once since you need several
  },

  // ── Platform Block — one-way collision platform ────────────────────────────
  // Players can jump through from below but land on top (like Terraria platforms).
  // Cheap to craft from oak wood — encourages tree cutting early game.
  platform_block: {
    displayName: "Platform Block",
    description: "One-way wooden platform. Jump through from below, land on top. Great for building multi-level bases.",
    ingredients: [
      { itemId: "oak_wood", quantity: 3 },
    ],
    result: "platform_block",
    resultQty: 2,   // crafts 2 at once
  },
};

// ─── Item category lookup (for inventory / store grouping) ───────────────────
export const ITEM_CATEGORIES: Record<string, string> = {
  data_center_rig:   "machines",
  machine_core:      "machines",
  mining_rig:        "machines",   // ASIC hardware — each block = 1 TH
  fan_block:         "machines",   // cooling fan block
  solar_panel_block: "machines",
  data_cable:        "machines",
  battery_block:     "machines",   // energy storage block
  generator_block:   "machines",   // diesel power block
  diesel_can:        "fuel",       // generator refuel item
  pickaxe_wood:      "tools",
  pickaxe_stone:     "tools",
  pickaxe_iron:      "tools",
  pickaxe_gold:      "tools",
  pickaxe_diamond:   "tools",
  seed_oak:          "seeds",
  oak_wood:          "resources",
  block_oak_log:     "blocks",
  block_oak_sapling: "blocks",
  block_oak_leaf:    "blocks",
  platform_block:    "blocks",
  block_dirt:        "blocks",
  block_grass:       "blocks",
  block_rock:        "blocks",
  raw_iron:          "resources",
  raw_gold:          "resources",
  raw_diamond:       "resources",
  obsidian:          "resources",
  thermal_paste:     "cooling",
  water_bucket:      "cooling",
  world_lock:        "locks",
  diamond_lock:      "locks",
  lamp_block:        "lighting",
};
