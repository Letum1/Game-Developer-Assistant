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
};

// ─── Which blocks are "machine" components (placeable, special behaviour) ────
// Placing these in the world and connecting them activates the Data Rig miner.
export const MACHINE_BLOCK_TYPES = new Set([
  "machine_core",
  "solar_panel_block",
  "data_cable",
]);

// ─── Miner passive income rates (sat/day per level) ──────────────────────────
// Stored as fractional USD-equivalent per second for precision in the ticker.
// Level is determined by how many solar panels are connected to machine_core(s).
export const MINER_RATES: Record<number, number> = {
  1:  1  / 86400,   // 1 sat/day  — bare minimum (1 solar panel)
  2:  2  / 86400,
  3:  5  / 86400,
  4:  10 / 86400,
  5:  15 / 86400,
  6:  20 / 86400,
  7:  25 / 86400,
  8:  30 / 86400,
  9:  40 / 86400,
  10: 50 / 86400,   // 50 sats/day — max level (10+ solar panels)
};

// ─── Gem cost to upgrade miner via the Miner page ────────────────────────────
// (Alternative path if user doesn't want to place more solar panels)
export const MINER_UPGRADE_COSTS: Record<number, number> = {
  1:  50,
  2:  120,
  3:  280,
  4:  500,
  5:  900,
  6:  1500,
  7:  2500,
  8:  4000,
  9:  6500,
};

// ─── Temperature system ───────────────────────────────────────────────────────
// Miner heats up over time; at 100°C it stops earning until cooled.
export const TEMP_RISE_PER_HOUR = 4.17; // reaches 100°C in ~24 hours
export const MAX_TEMP = 100;

// ─── Store items (buy with gems or real money) ────────────────────────────────
export const STORE_ITEMS = [
  { itemId: "solar_panel",       displayName: "Solar Panel",       gemCost: 100,  realCost: null, category: "energy",     description: "Reduces fuel consumption for your miner." },
  { itemId: "generator",         displayName: "Diesel Generator",  gemCost: 200,  realCost: null, category: "energy",     description: "Provides backup power for your miner." },
  { itemId: "thermal_paste",     displayName: "Thermal Paste",     gemCost: 30,   realCost: null, category: "cooling",    description: "Apply to reduce miner temperature." },
  { itemId: "water_bucket",      displayName: "Water Bucket",      gemCost: 20,   realCost: null, category: "cooling",    description: "Flush cooling water to reset temp gauge." },
  { itemId: "world_lock",        displayName: "World Lock",        gemCost: 500,  realCost: null, category: "locks",      description: "Lock a world to make it yours." },
  { itemId: "diamond_lock",      displayName: "Diamond Lock",      gemCost: 2500, realCost: null, category: "locks",      description: "Premium world lock with extra security." },
  { itemId: "pickaxe_stone",     displayName: "Stone Pickaxe",     gemCost: 80,   realCost: null, category: "tools",      description: "1.8× faster mining than bare hands." },
  { itemId: "pickaxe_iron",      displayName: "Iron Pickaxe",      gemCost: 200,  realCost: null, category: "tools",      description: "2.8× mining speed — breaks iron fast." },
  { itemId: "pickaxe_gold",      displayName: "Gold Pickaxe",      gemCost: 400,  realCost: null, category: "tools",      description: "4.5× mining speed." },
  { itemId: "pickaxe_diamond",   displayName: "Diamond Pickaxe",   gemCost: 800,  realCost: null, category: "tools",      description: "7× mining speed — the ultimate tool." },
];

// ─── Human-readable item names (used in toast messages, inventory UI) ────────
export const ITEM_DISPLAY_NAMES: Record<string, string> = {
  data_center_rig:   "Data Center Rig",
  machine_core:      "Machine Core",
  solar_panel_block: "Solar Panel",
  data_cable:        "Data Cable",
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
  // Store items
  solar_panel:       "Solar Panel (item)",
  generator:         "Generator",
  thermal_paste:     "Thermal Paste",
  water_bucket:      "Water Bucket",
  world_lock:        "World Lock",
  diamond_lock:      "Diamond Lock",
};

// ─── Crafting recipes ─────────────────────────────────────────────────────────
// Players craft these items at the Workbench page using raw resources.
// `unlocksMiner` = true means placing the result activates passive income.
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
    displayName: "Data Cable",
    description: "Extends your machine network — connect Machine Cores to Solar Panels across gaps.",
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
  generator: {
    displayName: "Diesel Generator",
    description: "Backup power for your Data Center.",
    ingredients: [
      { itemId: "raw_iron", quantity: 3 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "generator",
    resultQty: 1,
  },

  solar_panel: {
    displayName: "Solar Panel (item)",
    description: "Inventory item version — install via the Miner page.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "solar_panel",
    resultQty: 1,
  },

  water_bucket: {
    displayName: "Water Bucket",
    description: "Flush cooling water to reset temperature.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "water_bucket",
    resultQty: 1,
  },

  thermal_paste: {
    displayName: "Thermal Paste",
    description: "Apply to reduce miner temperature.",
    ingredients: [
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "thermal_paste",
    resultQty: 1,
  },
};

// ─── Item category lookup (for inventory / store grouping) ───────────────────
export const ITEM_CATEGORIES: Record<string, string> = {
  data_center_rig:   "machines",
  machine_core:      "machines",
  solar_panel_block: "machines",
  data_cable:        "machines",
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
  solar_panel:       "energy",
  generator:         "energy",
  thermal_paste:     "cooling",
  water_bucket:      "cooling",
  world_lock:        "locks",
  diamond_lock:      "locks",
};
