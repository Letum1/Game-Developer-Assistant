// ============================================================
// StructurePopup.tsx — floating status panel for machine blocks
//
// Shown when the player clicks a machine block (machine_core,
// generator_block, battery_block, etc.) in punch mode without a
// use-item selected. Displays real-time rig stats from the server
// without requiring navigation away from the game canvas.
//
// Props:
//   blockType    — the block that was clicked (e.g. "machine_core")
//   bx / by      — world grid coordinates of the block
//   minerData    — live miner state from useGetMiner()
//   onClose      — dismiss the popup
//   onBreak      — programmatically send the break action for this block
//   onRefuel     — (optional) called when player clicks Refuel button
//   hasDieselCan — (optional) true if player has a diesel_can in inventory
// ============================================================

import { X, Cpu, Thermometer, Fuel, Battery, Sun, Cable, Lightbulb } from "lucide-react";

// Live miner state shape (subset of what the API returns)
type MinerData = {
  level:          number;
  temperature:    number;
  isRunning:      boolean;
  ratePerSecond:  number;
  solarPanels:    number;
  generators:     number;
  fuel:           number;
  currentBalance: number;
};

type StructurePopupProps = {
  blockType:    string;
  bx:           number;
  by:           number;
  minerData:    MinerData | null | undefined;
  onClose:      () => void;
  onBreak:      () => void;
  // Optional refuel action — triggered by the Refuel button on generator/battery blocks.
  // Game.tsx passes this when it detects the clicked block is a generator_block or battery_block.
  onRefuel?:    () => void;
  hasDieselCan?: boolean; // true when player has ≥1 diesel_can in inventory
};

// Human-readable block display names
const BLOCK_FRIENDLY: Record<string, string> = {
  machine_core:      "Machine Core",
  solar_panel_block: "Solar Panel",
  data_cable:        "Data Pipe / Cable",
  lamp_block:        "Lamp Block",
  battery_block:     "Battery Block",
  generator_block:   "Diesel Generator",
};

export default function StructurePopup({ blockType, bx, by, minerData, onClose, onBreak, onRefuel, hasDieselCan }: StructurePopupProps) {
  const name    = BLOCK_FRIENDLY[blockType] ?? blockType;
  const temp    = minerData?.temperature ?? 0;
  const tempColor =
    temp < 60 ? "#22c55e" :
    temp < 80 ? "#eab308" : "#ef4444";

  // Fuel / charge as 0-100 percentage (max fuel = 500 units)
  const fuelPct = Math.max(0, Math.min(100, ((minerData?.fuel ?? 0) / 500) * 100));
  const fuelBarColor =
    fuelPct > 40 ? "#f59e0b" :
    fuelPct > 15 ? "#f97316" : "#ef4444";

  return (
    // Width + styling only — positioning is handled by Game.tsx wrapper
    <div className="w-64 bg-black/96 border border-primary/40 rounded-lg shadow-[0_0_24px_rgba(34,197,94,0.18)] font-mono text-xs pointer-events-auto select-none">

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20">
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3 h-3 text-primary shrink-0" />
          <span className="text-primary font-bold uppercase tracking-widest text-[10px]">{name}</span>
        </div>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-white transition-colors ml-2"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Grid coords ────────────────────────────────────────── */}
      <div className="px-3 pt-1.5 pb-1 text-[9px] text-muted-foreground uppercase tracking-widest">
        World [{bx}, {by}]
      </div>

      {/* ── Block-specific stats ────────────────────────────────── */}
      <div className="px-3 pb-2 space-y-1.5">

        {/* ── machine_core: full rig stats ─────────────────────── */}
        {/* Level is automatically computed from connected power blocks:  */}
        {/* solar_panel=1pt, battery=1pt, generator=2pts; cap at 9.       */}
        {blockType === "machine_core" && minerData && (
          <>
            {/* Running status indicator */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              <span className={`font-bold ${minerData.isRunning ? "text-primary" : "text-red-400"}`}>
                {minerData.isRunning ? "● RUNNING" : "✕ HALTED"}
              </span>
            </div>

            {/* Rig tier — driven by total connected power units in the world */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Tier</span>
              <span className="text-white font-bold">Level {Math.min(minerData.level, 9)}</span>
            </div>

            {/* Core temperature with colour gradient: green → yellow → red */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground flex items-center gap-1">
                <Thermometer className="w-3 h-3" /> Temp
              </span>
              <span style={{ color: tempColor }} className="font-bold">
                {temp.toFixed(0)}°C
                {temp >= 80 && " 🔥"}
              </span>
            </div>

            {/* Connected solar panel count (daytime-only power) */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground flex items-center gap-1">
                <Sun className="w-3 h-3 text-yellow-400" /> Panels
              </span>
              <span className="text-yellow-400 font-bold">{minerData.solarPanels}</span>
            </div>

            {/* Always-on power sources (batteries + generators combined) */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Always-On</span>
              <span className="text-orange-400 font-bold">{minerData.generators}</span>
            </div>

            {/* Overheating warning — guide player to cool down */}
            {temp >= 80 && (
              <div className="mt-1 text-[9px] text-red-400/80 border border-red-500/20 rounded px-2 py-1 bg-red-950/30 leading-relaxed">
                ⚠ Overheating — apply Thermal Paste or Water Bucket to cool down.
              </div>
            )}

            {/* Structure upgrade hint — place more power blocks to raise level */}
            <div className="mt-1 text-[9px] text-primary/60 border border-primary/15 rounded px-2 py-1 bg-primary/5 leading-relaxed">
              ⚡ Level up by connecting more Solar Panels, Batteries, or Generators via Pipes. Max level: 9.
            </div>
          </>
        )}

        {/* ── generator_block / battery_block: fuel gauge + direct refuel ── */}
        {/* Fuel is a shared pool (0–500) drained by all always-on sources.  */}
        {/* onRefuel fires the "refuel" game action using the diesel_can item. */}
        {(blockType === "generator_block" || blockType === "battery_block") && (
          <>
            {/* Fuel level readout — blinks red when critically low */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground flex items-center gap-1">
                {blockType === "generator_block"
                  ? <Fuel className="w-3 h-3" />
                  : <Battery className="w-3 h-3" />}
                {blockType === "generator_block" ? "Diesel" : "Charge"}
              </span>
              <span
                className={`font-bold ${fuelPct < 20 ? "animate-pulse text-red-400" : "text-yellow-400"}`}
              >
                {fuelPct.toFixed(0)}% ({Math.round((minerData?.fuel ?? 0))}/500)
              </span>
            </div>

            {/* Fuel bar — colour transitions: yellow → orange → red as fuel depletes */}
            <div className="w-full h-2 bg-black/60 rounded-full border border-border overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${fuelPct}%`, backgroundColor: fuelBarColor }}
              />
            </div>

            {/* Direct refuel button — only shown for generators, only when onRefuel is provided */}
            {/* hasDieselCan=false greys it out and explains the situation inline */}
            {blockType === "generator_block" && onRefuel && (
              <button
                onClick={onRefuel}
                disabled={!hasDieselCan}
                className={`w-full mt-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-bold uppercase tracking-wider transition-all ${
                  hasDieselCan
                    ? "border-yellow-500/60 text-yellow-400 bg-yellow-500/10 hover:bg-yellow-500/20 cursor-pointer"
                    : "border-border/30 text-muted-foreground/40 cursor-not-allowed"
                }`}
              >
                <Fuel className="w-3 h-3" />
                {hasDieselCan ? "⛽ Refuel (+100 units)" : "No Diesel Can in inventory"}
              </button>
            )}

            {/* Battery hint — batteries charge from solar, no diesel needed */}
            {blockType === "battery_block" && (
              <div className="text-[9px] text-muted-foreground leading-relaxed">
                Charges from solar panels during the day. Use Diesel Can on a Generator to add fuel.
              </div>
            )}
          </>
        )}

        {/* ── solar_panel_block ────────────────────────────────── */}
        {blockType === "solar_panel_block" && (
          <div className="text-[10px] text-yellow-400/80 leading-relaxed">
            ☀ Needs open sky above and daytime to generate power.
            Connect to Machine Core via Data Pipes.
          </div>
        )}

        {/* ── data_cable ────────────────────────────────────────── */}
        {blockType === "data_cable" && (
          <div className="text-[10px] text-primary/80 leading-relaxed flex items-start gap-1">
            <Cable className="w-3 h-3 mt-0.5 shrink-0" />
            Carries power between blocks. Connects Solar Panels, Generators,
            Batteries, and the Machine Core.
          </div>
        )}

        {/* ── lamp_block ────────────────────────────────────────── */}
        {blockType === "lamp_block" && (
          <div className="text-[10px] text-yellow-300/80 leading-relaxed flex items-start gap-1">
            <Lightbulb className="w-3 h-3 mt-0.5 shrink-0" />
            Lights up when connected to an active power network.
            Wire to your rig via Data Pipes.
          </div>
        )}
      </div>

      {/* ── Break button ───────────────────────────────────────── */}
      <div className="px-3 pb-3">
        <button
          onClick={() => { onBreak(); onClose(); }}
          className="w-full text-[10px] uppercase tracking-wider font-bold px-2 py-1.5 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors"
        >
          ✕ Break Block
        </button>
      </div>
    </div>
  );
}
