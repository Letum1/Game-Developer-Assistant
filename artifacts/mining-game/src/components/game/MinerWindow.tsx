// ============================================================
// MinerWindow.tsx — compact floating miner stats panel
//
// Shown as an overlay inside the game view when the player
// toggles the "Miner" window from the top HUD. Displays the
// same key stats as the full Miner page without leaving the canvas.
// ============================================================

import { X, Thermometer, Server, Fuel } from "lucide-react";

type MinerData = {
  level:          number;
  temperature:    number;
  isRunning:      boolean;
  ratePerSecond:  number;
  solarPanels:    number;
  generators:     number;
  fuel:           number;
  currentBalance: number;
  nextUpgradeCost: number | null;
};

type MinerWindowProps = {
  minerData: MinerData | null | undefined;
  onClose:   () => void;
};

export default function MinerWindow({ minerData, onClose }: MinerWindowProps) {
  const temp     = minerData?.temperature ?? 0;
  const tempColor =
    temp < 60 ? "#22c55e" :
    temp < 80 ? "#eab308" : "#ef4444";
  const fuelPct  = Math.max(0, Math.min(100, ((minerData?.fuel ?? 0) / 500) * 100));

  return (
    <div className="w-56 bg-black/96 border border-primary/40 rounded-lg shadow-[0_0_20px_rgba(34,197,94,0.15)] font-mono text-xs pointer-events-auto select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-primary/20">
        <div className="flex items-center gap-1.5">
          <Server className="w-3 h-3 text-primary" />
          <span className="text-primary font-bold uppercase tracking-widest text-[10px]">Data Miner</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Stats */}
      <div className="px-3 py-2 space-y-1.5">
        {!minerData ? (
          <div className="text-muted-foreground text-[10px] text-center py-2 animate-pulse">
            Loading…
          </div>
        ) : !minerData.isRunning && minerData.level === 0 ? (
          <div className="text-muted-foreground text-[10px] text-center py-2">
            No rig built yet. Place a Machine Core + Panels in the world.
          </div>
        ) : (
          <>
            {/* Running status */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status</span>
              <span className={`font-bold ${minerData.isRunning ? "text-primary" : "text-red-400"}`}>
                {minerData.isRunning ? "● RUNNING" : "✕ HALTED"}
              </span>
            </div>

            {/* Tier */}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tier</span>
              <span className="text-white font-bold">Level {minerData.level}</span>
            </div>

            {/* Temperature */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground flex items-center gap-1">
                <Thermometer className="w-3 h-3" /> Temp
              </span>
              <span style={{ color: tempColor }} className="font-bold">{temp.toFixed(0)}°C</span>
            </div>

            {/* Rate row intentionally hidden — shown as USD on Wallet page */}

            {/* Fuel gauge */}
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground flex items-center gap-1">
                <Fuel className="w-3 h-3" /> Fuel
              </span>
              <span className={`font-bold ${fuelPct < 20 ? "text-red-400 animate-pulse" : "text-yellow-400"}`}>
                {fuelPct.toFixed(0)}%
              </span>
            </div>

            {/* Fuel bar */}
            <div className="w-full h-1.5 bg-black/60 rounded-full border border-border overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${fuelPct}%`,
                  backgroundColor: fuelPct > 40 ? "#f59e0b" : fuelPct > 15 ? "#f97316" : "#ef4444",
                }}
              />
            </div>

            {/* Balance */}
            <div className="flex justify-between pt-0.5">
              <span className="text-muted-foreground">Balance</span>
              <span className="text-primary font-bold">
                ${minerData.currentBalance.toFixed(6)}
              </span>
            </div>

            {/* Panels / generators */}
            <div className="flex justify-between text-[9px]">
              <span className="text-yellow-400">☀ {minerData.solarPanels} panels</span>
              <span className="text-orange-400">⚡ {minerData.generators} gens</span>
            </div>

            {/* Overheat tip */}
            {temp >= 80 && (
              <div className="text-[9px] text-red-400/80 border border-red-500/20 rounded px-2 py-1 bg-red-950/30">
                Apply Thermal Paste or Water Bucket!
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
