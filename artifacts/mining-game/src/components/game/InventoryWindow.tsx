// ============================================================
// InventoryWindow.tsx — compact floating inventory panel
//
// Shows all player items as a scrollable grid inside the game
// view. Toggled via the HUD toolbar so players never need to
// navigate away from the canvas to check their bag.
// ============================================================

import { X, Package } from "lucide-react";

// Item display name map for the window (shared subset)
const DISPLAY_NAMES: Record<string, string> = {
  machine_core:      "M.Core",
  solar_panel_block: "Solar Pnl",
  data_cable:        "Pipe",
  battery_block:     "Battery",
  generator_block:   "Generator",
  diesel_can:        "Diesel Can",
  lamp_block:        "Lamp",
  thermal_paste:     "Therm.Paste",
  water_bucket:      "Water Bkt",
  pickaxe_wood:      "Wood Pick",
  pickaxe_stone:     "Stone Pick",
  pickaxe_iron:      "Iron Pick",
  pickaxe_gold:      "Gold Pick",
  pickaxe_diamond:   "Dmnd Pick",
  raw_iron:          "Raw Iron",
  raw_gold:          "Raw Gold",
  raw_diamond:       "Raw Diamond",
  obsidian:          "Obsidian",
  seed_oak:          "Oak Seed",
  oak_wood:          "Oak Wood",
  block_dirt:        "Dirt",
  block_grass:       "Grass",
  block_rock:        "Rock",
  world_lock:        "World Lock",
  diamond_lock:      "Dmnd Lock",
};

// Emoji icons for quick visual recognition
const ITEM_ICON: Record<string, string> = {
  machine_core:      "⚙",
  solar_panel_block: "☀",
  data_cable:        "〜",
  battery_block:     "🔋",
  generator_block:   "⚡",
  diesel_can:        "⛽",
  lamp_block:        "💡",
  thermal_paste:     "🧴",
  water_bucket:      "💧",
  raw_iron:          "🔩",
  raw_gold:          "🥇",
  raw_diamond:       "💎",
  obsidian:          "🪨",
  seed_oak:          "🌱",
  oak_wood:          "🪵",
};

type InventoryItem = {
  itemId:   string;
  quantity: number;
};

type InventoryWindowProps = {
  inventory: InventoryItem[];
  onClose:   () => void;
};

export default function InventoryWindow({ inventory, onClose }: InventoryWindowProps) {
  // Only show items with quantity > 0
  const items = inventory.filter((i) => i.quantity > 0);

  return (
    <div className="w-60 bg-black/96 border border-border rounded-lg shadow-[0_0_20px_rgba(0,0,0,0.5)] font-mono text-xs pointer-events-auto select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <Package className="w-3 h-3 text-white" />
          <span className="text-white font-bold uppercase tracking-widest text-[10px]">Inventory</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Item grid — scrollable */}
      <div className="px-2 py-2 max-h-52 overflow-y-auto grid grid-cols-3 gap-1">
        {items.length === 0 ? (
          <div className="col-span-3 text-center text-muted-foreground text-[10px] py-4 italic">
            Inventory empty
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.itemId}
              className="flex flex-col items-center p-1.5 rounded border border-border bg-black/50 text-center gap-0.5"
              title={DISPLAY_NAMES[item.itemId] ?? item.itemId}
            >
              {/* Icon or color swatch */}
              <span className="text-base leading-none">
                {ITEM_ICON[item.itemId] ?? "📦"}
              </span>
              <span className="text-[8px] text-muted-foreground leading-tight uppercase truncate w-full text-center">
                {DISPLAY_NAMES[item.itemId] ?? item.itemId}
              </span>
              <span className="text-primary font-bold text-[9px]">×{item.quantity}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
