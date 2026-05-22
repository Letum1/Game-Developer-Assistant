export const WORLD_WIDTH = 20;
export const WORLD_HEIGHT = 15;

export const BLOCK_REWARDS: Record<string, { gems: number; points: number; drop?: string; dropChance?: number }> = {
  block_dirt:    { gems: 1,  points: 10, drop: "seed_oak",    dropChance: 0.15 },
  block_grass:   { gems: 1,  points: 8,  drop: "seed_oak",    dropChance: 0.30 },
  block_iron:    { gems: 3,  points: 20, drop: "raw_iron",    dropChance: 1.0  },
  block_rock:    { gems: 2,  points: 12 },
  block_gold:    { gems: 10, points: 50, drop: "raw_gold",    dropChance: 1.0  },
  block_diamond: { gems: 25, points: 100, drop: "raw_diamond", dropChance: 1.0  },
  block_lava:    { gems: 5,  points: 30, drop: "obsidian",    dropChance: 0.5  },
};

// Miner rates: sats per day per level. 1 sat = 0.00000001 BTC
// We store as USD cents per second for simplicity (simulated)
export const MINER_RATES: Record<number, number> = {
  1:  1 / 86400,      // 1 sat/day in tiny decimal
  2:  2 / 86400,
  3:  5 / 86400,
  4:  10 / 86400,
  5:  15 / 86400,
  6:  20 / 86400,
  7:  25 / 86400,
  8:  30 / 86400,
  9:  40 / 86400,
  10: 50 / 86400,
};

export const MINER_UPGRADE_COSTS: Record<number, number> = {
  1:  50,    // gems to upgrade from level 1 to 2
  2:  120,
  3:  280,
  4:  500,
  5:  900,
  6:  1500,
  7:  2500,
  8:  4000,
  9:  6500,
};

// Temperature rise per hour (degrees)
export const TEMP_RISE_PER_HOUR = 4.17; // ~100°C over 24h
export const MAX_TEMP = 100;

export const STORE_ITEMS = [
  { itemId: "solar_panel",       displayName: "Solar Panel",       gemCost: 100, realCost: null, category: "energy",     description: "Reduces fuel consumption for your miner." },
  { itemId: "generator",         displayName: "Diesel Generator",  gemCost: 200, realCost: null, category: "energy",     description: "Provides backup power for your miner." },
  { itemId: "thermal_paste",     displayName: "Thermal Paste",     gemCost: 30,  realCost: null, category: "cooling",    description: "Apply to reduce miner temperature." },
  { itemId: "water_bucket",      displayName: "Water Bucket",      gemCost: 20,  realCost: null, category: "cooling",    description: "Flush cooling water to reset temp gauge." },
  { itemId: "world_lock",        displayName: "World Lock",        gemCost: 500, realCost: null, category: "locks",      description: "Lock a world to make it yours." },
  { itemId: "diamond_lock",      displayName: "Diamond Lock",      gemCost: 2500, realCost: null, category: "locks",     description: "Premium world lock with extra security." },
  { itemId: "pickaxe_stone",     displayName: "Stone Pickaxe",     gemCost: 80,  realCost: null, category: "tools",     description: "Faster block breaking than wood." },
  { itemId: "pickaxe_iron",      displayName: "Iron Pickaxe",      gemCost: 200, realCost: null, category: "tools",     description: "Breaks iron and harder blocks faster." },
  { itemId: "pickaxe_gold",      displayName: "Gold Pickaxe",      gemCost: 400, realCost: null, category: "tools",     description: "Very fast mining speed." },
  { itemId: "pickaxe_diamond",   displayName: "Diamond Pickaxe",   gemCost: 800, realCost: null, category: "tools",     description: "The ultimate mining tool." },
];

export const ITEM_DISPLAY_NAMES: Record<string, string> = {
  pickaxe_wood:    "Wood Pickaxe",
  pickaxe_stone:   "Stone Pickaxe",
  pickaxe_iron:    "Iron Pickaxe",
  pickaxe_gold:    "Gold Pickaxe",
  pickaxe_diamond: "Diamond Pickaxe",
  seed_oak:        "Oak Seed",
  block_dirt:      "Dirt Block",
  block_grass:     "Grass Block",
  block_rock:      "Rock Block",
  raw_iron:        "Raw Iron",
  raw_gold:        "Raw Gold",
  raw_diamond:     "Raw Diamond",
  obsidian:        "Obsidian",
  solar_panel:     "Solar Panel",
  generator:       "Generator",
  thermal_paste:   "Thermal Paste",
  water_bucket:    "Water Bucket",
  world_lock:      "World Lock",
  diamond_lock:    "Diamond Lock",
};

export const ITEM_CATEGORIES: Record<string, string> = {
  pickaxe_wood:    "tools",
  pickaxe_stone:   "tools",
  pickaxe_iron:    "tools",
  pickaxe_gold:    "tools",
  pickaxe_diamond: "tools",
  seed_oak:        "seeds",
  block_dirt:      "blocks",
  block_grass:     "blocks",
  block_rock:      "blocks",
  raw_iron:        "resources",
  raw_gold:        "resources",
  raw_diamond:     "resources",
  obsidian:        "resources",
  solar_panel:     "energy",
  generator:       "energy",
  thermal_paste:   "cooling",
  water_bucket:    "cooling",
  world_lock:      "locks",
  diamond_lock:    "locks",
};
