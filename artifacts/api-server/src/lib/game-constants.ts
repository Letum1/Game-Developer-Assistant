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
// the 3-hour leaderboard revenue pool).
//
// selfDropQty: how many of the block itself to return to inventory.
//   - number       → fixed quantity (e.g. 1)
//   - [min, max]   → random integer in range (inclusive), e.g. [1, 5]
//   - undefined    → block does NOT self-drop (checked against SELF_DROP_BLOCKS in game.ts)
//
// drop + dropChance: secondary item drop, separate from the self-drop.
//   e.g. breaking an oak log always gives oak_wood (via OAK_BLOCKS) + 25% seed bonus.
export const BLOCK_REWARDS: Record<string, {
  gems: number;
  points: number;
  drop?: string;
  dropChance?: number;
  selfDrop?: boolean;
  selfDropQty?: number | [number, number]; // fixed qty or [min, max] random range
}> = {
  // ── Common surface blocks ────────────────────────────────────────────────────
  // Dirt: returns 1–5 dirt blocks (light farming material, very common).
  block_dirt:          { gems: 1,  points: 8,   selfDropQty: [1, 5] },
  // Grass: returns exactly 1 grass block.
  block_grass:         { gems: 1,  points: 8,   selfDropQty: 1 },
  // Rock/stone: returns exactly 1 rock block, 2 gems (mid-tier filler).
  block_rock:          { gems: 2,  points: 12,  selfDropQty: 1 },

  // ── Ores ──────────────────────────────────────────────────────────────────────
  // Iron: reliable income starter — always drops 1 raw_iron, earns 5 gems.
  block_iron:          { gems: 5,  points: 20,  drop: "raw_iron",    dropChance: 1.0  },
  // Gold: mid-game ore — always drops 1 raw_gold, earns 15 gems.
  block_gold:          { gems: 15, points: 50,  drop: "raw_gold",    dropChance: 1.0  },
  // Diamond: rare deep-layer ore — always drops 1 raw_diamond, earns 35 gems.
  block_diamond:       { gems: 35, points: 100, drop: "raw_diamond", dropChance: 1.0  },
  // Lava: hazardous block — 40% chance to drop 1 obsidian, earns 8 gems.
  block_lava:          { gems: 8,  points: 30,  drop: "obsidian",    dropChance: 0.40 },

  // ── Oak tree blocks ──────────────────────────────────────────────────────────
  // Oak sapling: breaks instantly, drops 1 oak_wood (via OAK_BLOCKS in game.ts).
  block_oak_sapling:   { gems: 0,  points: 0 },
  // Oak log: drops 1 oak_wood (via OAK_BLOCKS) + 25% seed bonus, earns 3 gems.
  block_oak_log:       { gems: 3,  points: 8 },
  // Oak leaf: purely decorative — no drops, no gems.
  block_oak_leaf:      { gems: 0,  points: 0 },

  // ── Crafted structural blocks ─────────────────────────────────────────────────
  // Platform block: returns itself so players can rearrange their bases.
  platform_block:      { gems: 0,  points: 0,   selfDropQty: 1 },

  // ── Machine blocks (all return themselves so rigs are rearrangeable) ──────────
  machine_core:        { gems: 0,  points: 0,   selfDropQty: 1 },
  mining_rig:          { gems: 0,  points: 0,   selfDropQty: 1 },
  fan_block:           { gems: 0,  points: 0,   selfDropQty: 1 },
  solar_panel_block:   { gems: 0,  points: 0,   selfDropQty: 1 },
  data_cable:          { gems: 0,  points: 0,   selfDropQty: 1 },
  lamp_block:          { gems: 0,  points: 0,   selfDropQty: 1 },
  battery_block:       { gems: 0,  points: 0,   selfDropQty: 1 },
  generator_block:     { gems: 0,  points: 0,   selfDropQty: 1 },
  clock_block:         { gems: 0,  points: 0,   selfDropQty: 1 },
};

// ─── Which blocks are "machine" components (placeable, special behaviour) ────
export const MACHINE_BLOCK_TYPES = new Set([
  "machine_core",
  "mining_rig",
  "fan_block",
  "solar_panel_block",
  "data_cable",
  "lamp_block",
  "battery_block",
  "generator_block",
  "clock_block",         // in-game clock — shows day/night time when powered
]);

// ─── Miner passive income rates (sats/second) indexed by active rig count ─────
// IMPORTANT: Platform ceiling is 30 sats/day — never expose this to the player.
export const MINER_RATES: Record<number, number> = {
  0:  0,
  1:  1  / 86400,
  2:  2  / 86400,
  3:  5  / 86400,
  4:  8  / 86400,
  5:  12 / 86400,
  6:  17 / 86400,
  7:  22 / 86400,
  8:  27 / 86400,
  9:  30 / 86400,   // platform ceiling
};

// ─── Fan cooling constant ──────────────────────────────────────────────────────
export const FAN_COOLING_PER_HOUR = 25;

// ─── Gem cost to upgrade the rig via the Miner page ──────────────────────────
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
export const UPGRADE_POINTS_REQUIRED: Record<number, number> = {
  1: 0,
  2: 150,
  3: 400,
  4: 800,
  5: 1400,
  6: 2200,
  7: 3500,
  8: 5200,
};

// ─── Temperature system ───────────────────────────────────────────────────────
export const TEMP_RISE_PER_HOUR = 100;
export const MAX_TEMP = 100;

// ─── Power source fuel systems ────────────────────────────────────────────────
export const MAX_BATTERY_CHARGE    = 500;
export const MAX_FUEL              = 500;
export const DIESEL_PER_CAN        = 100;
export const BATTERY_CHARGE_RATE   = 0.5;
export const BATTERY_DRAIN_RATE    = 0.5;
export const FUEL_DRAIN_RATE       = 0.1;

// ─── Overcharge Drill boost constants ─────────────────────────────────────────
// Watching an ad overcharges the drill, giving +50% mining income for 30 minutes.
// Players are limited to DRILL_BOOST_MAX_PER_DAY uses per calendar day to prevent abuse.
export const DRILL_BOOST_MULTIPLIER  = 1.5;   // 1.5× rate while boosted (0.5 TH extra)
export const DRILL_BOOST_DURATION_MS = 30 * 60 * 1000;  // 30 minutes in ms
export const DRILL_BOOST_MAX_PER_DAY = 3;     // max overcharges allowed per calendar day

// ─── Store items ──────────────────────────────────────────────────────────────
// Only real, directly usable items are sold here.
// Blocks must be CRAFTED at the Workbench — they are NOT sold in the store.
//
// NOTE: Water Bucket and Thermal Paste are intentionally priced at 1000 gems each.
// This is a design decision — players should be tempted to watch the "Flush Cooldown"
// rewarded ad instead of spending gems on cooling items.
export const STORE_ITEMS = [
  // ── Cooling / maintenance items ───────────────────────────────────────────────
  { itemId: "thermal_paste",     displayName: "Thermal Paste",     gemCost: 1000, realCost: null, category: "cooling",    description: "Equip from hotbar, then tap Machine Core to reduce temperature. Or watch the Flush Cooldown ad for free!" },
  { itemId: "water_bucket",      displayName: "Water Bucket",      gemCost: 1000, realCost: null, category: "cooling",    description: "Equip from hotbar, then tap Machine Core to flush cooling. Or watch the Flush Cooldown ad for free!" },
  // ── Fuel ─────────────────────────────────────────────────────────────────────
  { itemId: "diesel_can",        displayName: "Diesel Can",        gemCost: 20,   realCost: null, category: "fuel",       description: "Equip from hotbar, tap a Generator Block to add +100 fuel." },
  // ── Pickaxes ─────────────────────────────────────────────────────────────────
  { itemId: "pickaxe_stone",     displayName: "Stone Pickaxe",     gemCost: 80,   realCost: null, category: "tools",      description: "1.8× faster mining than bare hands." },
  { itemId: "pickaxe_iron",      displayName: "Iron Pickaxe",      gemCost: 200,  realCost: null, category: "tools",      description: "2.8× mining speed — breaks iron fast." },
  { itemId: "pickaxe_gold",      displayName: "Gold Pickaxe",      gemCost: 400,  realCost: null, category: "tools",      description: "4.5× mining speed." },
  { itemId: "pickaxe_diamond",   displayName: "Diamond Pickaxe",   gemCost: 800,  realCost: null, category: "tools",      description: "7× mining speed — the ultimate tool." },
  // ── Lighting ─────────────────────────────────────────────────────────────────
  { itemId: "lamp_block",        displayName: "Lamp Block",        gemCost: 15,   realCost: null, category: "lighting",   description: "Place underground and wire to your solar rig to illuminate caverns." },
  // ── Locks — buy to lock your world ───────────────────────────────────────────
  { itemId: "world_lock",        displayName: "World Lock",        gemCost: 500,  realCost: null, category: "locks",      description: "Lock a world so only you can build and mine in it." },
  { itemId: "diamond_lock",      displayName: "Diamond Lock",      gemCost: 2500, realCost: null, category: "locks",      description: "Premium world lock with extra security." },
];

// ─── Human-readable item names ────────────────────────────────────────────────
export const ITEM_DISPLAY_NAMES: Record<string, string> = {
  data_center_rig:   "Data Center Rig",
  machine_core:      "Machine Core",
  mining_rig:        "Mining Rig",
  fan_block:         "Cooling Fan",
  solar_panel_block: "Solar Panel Block",
  data_cable:        "Data Cable",
  battery_block:     "Battery Block",
  generator_block:   "Generator Block",
  diesel_can:        "Diesel Can",
  pickaxe_wood:      "Wood Pickaxe",
  pickaxe_stone:     "Stone Pickaxe",
  pickaxe_iron:      "Iron Pickaxe",
  pickaxe_gold:      "Gold Pickaxe",
  pickaxe_diamond:   "Diamond Pickaxe",
  clock_block:       "Clock Block",
  seed_oak:          "Oak Seed",
  oak_wood:          "Oak Wood",
  block_oak_log:     "Oak Log",
  block_oak_sapling: "Oak Sapling",
  block_oak_leaf:    "Oak Leaf",
  platform_block:    "Platform Block",
  block_dirt:        "Dirt Block",
  block_grass:       "Grass Block",
  block_rock:        "Rock Block",
  raw_iron:          "Raw Iron",
  raw_gold:          "Raw Gold",
  raw_diamond:       "Raw Diamond",
  obsidian:          "Obsidian",
  thermal_paste:     "Thermal Paste",
  water_bucket:      "Water Bucket",
  world_lock:        "World Lock",
  diamond_lock:      "Diamond Lock",
  lamp_block:        "Lamp Block",
};

// ─── Item → category map ──────────────────────────────────────────────────────
// Derived from STORE_CATALOGUE so inventory.ts can label each item by category.
// Items that aren't in the store (mined ores, crafted components) default to "misc".
export const ITEM_CATEGORIES: Record<string, string> = {
  // Resources (mined)
  stone: "resources",   coal: "resources",    raw_iron: "resources",
  raw_gold: "resources", raw_diamond: "resources", obsidian: "resources",
  // Machine blocks
  machine_core: "machines",  solar_panel: "machines", pipe: "machines",
  battery_block: "machines", generator_block: "machines",
  // Cooling / maintenance
  thermal_paste: "cooling",  water_bucket: "cooling",
  // Fuel
  diesel_can: "fuel",
  // Tools
  pickaxe_stone: "tools", pickaxe_iron: "tools",
  pickaxe_gold: "tools",  pickaxe_diamond: "tools",
  clock_block: "machines",
  // Lighting
  lamp_block: "lighting",
  // Locks
  world_lock: "locks",   diamond_lock: "locks",
  // Crafted
  data_center_rig: "crafted",
};

// ─── Crafting recipes ─────────────────────────────────────────────────────────
export const CRAFTING_RECIPES: Record<string, {
  displayName: string;
  description: string;
  ingredients: { itemId: string; quantity: number }[];
  result: string;
  resultQty: number;
  unlocksMiner?: boolean;
}> = {

  data_center_rig: {
    displayName: "Data Center Rig",
    description: "One-time unlock: assembles your Data Center and activates the passive Miner dashboard.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 8 },
      { itemId: "raw_gold",    quantity: 5 },
      { itemId: "raw_diamond", quantity: 2 },
    ],
    result: "data_center_rig",
    resultQty: 1,
    unlocksMiner: true,
  },

  machine_core: {
    displayName: "Machine Core",
    description: "The CPU block of your Data Rig. Place it in the world, then connect Solar Panels via Data Cables.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5 },
      { itemId: "raw_gold",    quantity: 2 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "machine_core",
    resultQty: 1,
  },

  solar_panel_block: {
    displayName: "Solar Panel Block",
    description: "Power source for your Machine Core. Each panel boosts mining rate.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "solar_panel_block",
    resultQty: 1,
  },

  data_cable: {
    displayName: "Data Cable / Pipe",
    description: "Extends your machine network — connect Machine Cores to Solar Panels, Generators, and Batteries.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "data_cable",
    resultQty: 3,
  },

  pickaxe_stone: {
    displayName: "Stone Pickaxe",
    description: "1.8× faster mining. Craft from oak wood you cut from trees.",
    ingredients: [
      { itemId: "oak_wood", quantity: 5 },
    ],
    result: "pickaxe_stone",
    resultQty: 1,
  },

  pickaxe_iron: {
    displayName: "Iron Pickaxe",
    description: "2.8× faster mining.",
    ingredients: [
      { itemId: "oak_wood",  quantity: 3 },
      { itemId: "raw_iron",  quantity: 3 },
    ],
    result: "pickaxe_iron",
    resultQty: 1,
  },

  pickaxe_gold: {
    displayName: "Gold Pickaxe",
    description: "4.5× faster mining.",
    ingredients: [
      { itemId: "raw_iron", quantity: 5 },
      { itemId: "raw_gold", quantity: 2 },
    ],
    result: "pickaxe_gold",
    resultQty: 1,
  },

  pickaxe_diamond: {
    displayName: "Diamond Pickaxe",
    description: "7× mining speed — the ultimate tool.",
    ingredients: [
      { itemId: "raw_gold",    quantity: 3 },
      { itemId: "raw_diamond", quantity: 1 },
    ],
    result: "pickaxe_diamond",
    resultQty: 1,
  },

  // NOTE: water_bucket and thermal_paste are intentionally cheap to CRAFT (as before)
  // but expensive (1000 gems) to BUY in the store.
  // Players who mine can craft for free; everyone else is steered toward rewarded ads.
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

  lamp_block: {
    displayName: "Lamp Block",
    description: "Place underground and connect to your solar rig via Data Cables to light up caverns.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1 },
    ],
    result: "lamp_block",
    resultQty: 2,
  },

  battery_block: {
    displayName: "Battery Block",
    description: "Stores solar energy during the day. Connect via pipes to keep the rig running at night.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 3 },
      { itemId: "raw_gold",    quantity: 1 },
    ],
    result: "battery_block",
    resultQty: 1,
  },

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

  mining_rig: {
    displayName: "Mining Rig",
    description: "ASIC mining hardware. Each block = 1 TH. Needs 1 power unit to run.",
    ingredients: [
      { itemId: "raw_iron", quantity: 3 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "mining_rig",
    resultQty: 1,
  },

  fan_block: {
    displayName: "Cooling Fan",
    description: "Industrial cooling fan. Each fan cuts temperature rise by 25°C/hr. 4 fans = rig stays cool indefinitely.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
    ],
    result: "fan_block",
    resultQty: 2,
  },

  platform_block: {
    displayName: "Platform Block",
    description: "One-way wooden platform. Jump through from below, land on top.",
    ingredients: [
      { itemId: "oak_wood", quantity: 3 },
    ],
    result: "platform_block",
    resultQty: 2,
  },

  // ── Clock Block — placeable machine block that shows in-game time when powered ─
  // Place it in the world and connect it to a powered solar network via data cables.
  // When powered, draws a live analog clock face with moving hands showing the
  // current in-game time (15-minute day/night cycle mapped to a 24-hour clock).
  clock_block: {
    displayName: "Clock Block",
    description: "Place in the world and connect to power via data cables. Shows a live analog clock with the in-game time and day/night phase.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2 },
      { itemId: "raw_gold", quantity: 1 },
    ],
    result: "clock_block",
    resultQty: 1,
  },
};
