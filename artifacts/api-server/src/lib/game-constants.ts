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
export const BLOCK_REWARDS: Record<string, { gems: number; points: number; drop?: string; dropChance?: number }> = {
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
  // Machine blocks return themselves (like grass/dirt) so players can re-arrange rigs
  machine_core:        { gems: 0,  points: 0                                          },
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
  "solar_panel_block",
  "data_cable",
  "lamp_block",        // underground lamp — lights up when powered
  "battery_block",     // energy storage — charges during day, powers rig at night
  "generator_block",   // diesel generator — always-on when fueled
]);

// ─── Miner passive income rates (sat/day per level) ──────────────────────────
// Stored as fractional USD-equivalent per second for precision in the ticker.
// Level is determined by how many solar panels are connected to machine_core(s).
// Rates are stored in sats/second for internal calculation precision.
// IMPORTANT: The platform ceiling is exactly 30 sats/day — NEVER expose this
// number to the player; show only the current rate tier, not the cap.
export const MINER_RATES: Record<number, number> = {
  1:  1  / 86400,   // tier 1 — entry level
  2:  2  / 86400,
  3:  5  / 86400,
  4:  8  / 86400,
  5:  12 / 86400,
  6:  17 / 86400,
  7:  22 / 86400,
  8:  27 / 86400,
  9:  30 / 86400,   // tier 9 — platform ceiling (hidden from player)
};

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
export const TEMP_RISE_PER_HOUR = 8.33; // reaches 100°C in ~12 hours without maintenance
export const MAX_TEMP = 100;

// ─── Diesel fuel system ───────────────────────────────────────────────────────
// Generators and batteries share the `fuel` column in the miners table.
// Generators consume fuel while running; batteries drain at night and recharge
// via solar panels during the day.
// fuel range: 0 – MAX_FUEL (integer units)
export const MAX_FUEL              = 500;   // max stored fuel / charge
export const DIESEL_PER_CAN        = 100;   // fuel units added per diesel_can item
// Drain: each always-on "source unit" burns this many fuel units per second.
// 1 battery_block = 1 source unit; 1 generator_block = 2 source units.
// With 1 generator (2 units): 100 fuel lasts ~1000s ≈ 3 nights of runtime.
export const FUEL_DRAIN_RATE       = 0.05; // units per second per always-on source
// Recharge: solar panels replenish battery fuel during daylight hours.
// With 2 panels: 1.0 unit/sec → fills 500-unit battery in ~8 min of sunshine.
export const BATTERY_CHARGE_RATE   = 0.5;  // units per second per solar panel (day only)

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

  // ── Data Center Rig (the main passive income device) ─────────────────────
  data_center_rig: {
    displayName: "Data Center Rig",
    description: "Unlocks your passive Data Center Miner. Place machine_core + solar panels in the world to activate.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5 },
      { itemId: "raw_gold",    quantity: 3 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "machine_core",  // placing machine_core in-world activates the rig
    resultQty: 1,
    unlocksMiner: true,
  },

  // ── Machine building blocks ──────────────────────────────────────────────
  machine_core: {
    displayName: "Machine Core",
    description: "The CPU brain of your Data Rig. Place in the world, then connect Solar Panels to activate it.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5 },
      { itemId: "raw_gold",    quantity: 2 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "machine_core",
    resultQty: 1,
    unlocksMiner: true,
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
};

// ─── Item category lookup (for inventory / store grouping) ───────────────────
export const ITEM_CATEGORIES: Record<string, string> = {
  data_center_rig:   "machines",
  machine_core:      "machines",
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
