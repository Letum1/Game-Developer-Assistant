// ============================================================
// Admin.tsx — Debug / cheat panel (admin user only)
//
// Access: log in with username matching ADMIN_USERNAME env var (default "admin").
// The "Admin" link appears in the sidebar only for that user.
// The server rejects all /api/admin/* calls from non-admin users with 403.
//
// Sections:
//   1. Player picker  — lists every registered account with key stats
//   2. Gems           — give / set gems instantly
//   3. Items          — one-click give of any item / custom item+qty form
//   4. Miner          — unlock, set rig level, reset temp, refill fuel
//   5. Time Simulator — fast-forward miner ticks to test overheating, income
//   6. Activity Pts   — bypass mining-hours gate on miner upgrades
//   7. World Reset    — wipe a named world so it regenerates fresh
// ============================================================

import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import {
  ShieldAlert, RefreshCw, Gem, Package, Thermometer, Zap,
  Fuel, Star, Trash2, ChevronDown, ChevronUp, Clock, Play,
  AlertTriangle, CheckCircle2, Ban, ShieldCheck, ShieldOff,
  MessageSquareOff, MessageSquare, UserX, UserCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

// ── Player row shape returned by GET /api/admin/users ────────────────────
interface PlayerRow {
  id: number;
  username: string;
  gems: number;
  miner_level: number;
  temperature: number;
  is_running: boolean;
  miner_unlocked: boolean;
  // Moderation fields — added by startup migrations
  adblock_detected: boolean;
  is_banned: boolean;
  is_muted: boolean;
  is_admin: boolean;
}

// ── Miner state shape returned by GET /api/admin/miner-state ─────────────
interface MinerState {
  userId: number;
  temperature: number;
  effectiveTempRise: number;   // °C per hour with current fans
  secsToOverheat: number | null; // null = already overheated or no rise
  isRunning: boolean;
  unlocked: boolean;
  currentBalance: number;
  ratePerSec: number;
  rigCount: number;
  fans: number;
  solarPanels: number;
  generators: number;
  fuel: number;
  lastTickAt: string;          // ISO timestamp
  secsSinceLastTick: number;
}

// ── Simulation result returned by POST /api/admin/simulate-time ──────────
interface SimResult {
  elapsedSeconds: number;
  runsForSeconds: number;       // how long it actually ran (≤ elapsedSeconds)
  stoppedEarly: boolean;        // true if it stopped before the window ended
  stopReason: "overheat" | "fuel_empty" | "still_running" | "was_not_running";
  overheatsAtSecond: number | null; // null = didn't overheat in this window
  wasRunning: boolean;
  oldTemp: number;
  newTemp: number;
  overheated: boolean;
  oldBalance: number;
  newBalance: number;
  earned: number;
  oldFuel: number;
  newFuel: number;
  isRunning: boolean;
}

// ── Authenticated fetch helper (sends x-user-id on every call) ───────────
function adminFetch(path: string, body?: object) {
  const userId = localStorage.getItem("userId");
  return fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "x-user-id": userId ?? "",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

// ── Format seconds into a human-readable string ───────────────────────────
function fmtSecs(secs: number | null): string {
  if (secs === null) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
}

// ─────────────────────────────────────────────────────────────────────────
export default function Admin() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const storedUsername = localStorage.getItem("username") ?? "";

  // ── Guard: bounce non-admins away ───────────────────────────────────────
  useEffect(() => {
    const userId = localStorage.getItem("userId");
    if (!userId) { setLocation("/"); return; }
    adminFetch("/api/admin/users").then((data) => {
      if (data.error) {
        toast({ title: "Admin access denied", variant: "destructive" });
        setLocation("/game");
      }
    });
  }, [setLocation, toast]);

  // ── Player list ──────────────────────────────────────────────────────────
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  const fetchPlayers = useCallback(async () => {
    setLoadingPlayers(true);
    const data = await adminFetch("/api/admin/users");
    if (Array.isArray(data)) setPlayers(data);
    setLoadingPlayers(false);
  }, []);

  useEffect(() => { fetchPlayers(); }, [fetchPlayers]);

  // ── Selected player ──────────────────────────────────────────────────────
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const selectedPlayer = players.find((p) => p.id === selectedUserId) ?? null;

  // ── Collapsible sections ─────────────────────────────────────────────────
  // Default: open the Time Simulator section since that's the new feature
  const [openSection, setOpenSection] = useState<string | null>("time");
  const toggleSection = (key: string) =>
    setOpenSection((prev) => (prev === key ? null : key));

  // ── Generic quick-action (POST with just userId) ─────────────────────────
  const quickAction = async (path: string, label: string, extraBody?: object) => {
    if (!selectedUserId) return;
    const data = await adminFetch(path, { userId: selectedUserId, ...extraBody });
    toast({
      title: data.success ? label : "Failed",
      description: data.message ?? data.error,
      variant: data.success ? "default" : "destructive",
    });
    fetchPlayers();
    if (openSection === "time") fetchMinerState();
  };

  // ── Gems ─────────────────────────────────────────────────────────────────
  const [gemAmount, setGemAmount] = useState("1000");

  const giveGems = async () => {
    if (!selectedUserId) return;
    const data = await adminFetch("/api/admin/give-gems", {
      userId: selectedUserId, amount: parseInt(gemAmount),
    });
    toast({
      title: data.success ? `Gave ${gemAmount} gems` : "Failed",
      description: data.success ? `Player now has ${data.newGems} gems` : data.error,
      variant: data.success ? "default" : "destructive",
    });
    fetchPlayers();
  };

  const setGems = async (amount: number) => {
    if (!selectedUserId) return;
    const data = await adminFetch("/api/admin/set-gems", { userId: selectedUserId, amount });
    toast({
      title: data.success ? `Gems set to ${amount}` : "Failed",
      description: data.success ? `Player now has ${data.newGems} gems` : data.error,
      variant: data.success ? "default" : "destructive",
    });
    fetchPlayers();
  };

  // ── Items ─────────────────────────────────────────────────────────────────
  const [itemId, setItemId] = useState("pickaxe_diamond");
  const [itemQty, setItemQty] = useState("1");

  const giveItem = async () => {
    if (!selectedUserId) return;
    const data = await adminFetch("/api/admin/give-item", {
      userId: selectedUserId, itemId, quantity: parseInt(itemQty),
    });
    toast({
      title: data.success ? `Gave ${itemQty}× ${itemId}` : "Failed",
      description: data.success ? `New qty: ${data.newQuantity}` : data.error,
      variant: data.success ? "default" : "destructive",
    });
  };

  // ── Miner ─────────────────────────────────────────────────────────────────
  const [minerLevel, setMinerLevel] = useState("5");

  const setMinerLevelFn = async () => {
    if (!selectedUserId) return;
    const data = await adminFetch("/api/admin/set-miner-level", {
      userId: selectedUserId, level: parseInt(minerLevel),
    });
    toast({
      title: data.success ? `Miner level set to ${minerLevel}` : "Failed",
      description: data.message ?? data.error,
      variant: data.success ? "default" : "destructive",
    });
    fetchPlayers();
    fetchMinerState();
  };

  // ── Activity Points ───────────────────────────────────────────────────────
  const [pointsAmount, setPointsAmount] = useState("5200");

  const givePoints = async () => {
    if (!selectedUserId) return;
    const data = await adminFetch("/api/admin/add-points", {
      userId: selectedUserId, points: parseInt(pointsAmount),
    });
    toast({
      title: data.success ? `+${pointsAmount} pts` : "Failed",
      description: data.success ? `New total: ${Math.floor(data.newPoints)}` : data.error,
      variant: data.success ? "default" : "destructive",
    });
  };

  // ── World Reset ───────────────────────────────────────────────────────────
  const [worldName, setWorldName] = useState("world1");

  const resetWorld = async () => {
    const data = await adminFetch("/api/admin/reset-world", { worldName });
    toast({
      title: data.success ? "World wiped" : "Failed",
      description: data.message ?? data.error,
      variant: data.success ? "default" : "destructive",
    });
  };

  // ════════════════════════════════════════════════════════════════════════
  // TIME SIMULATOR — fetch live miner state + simulate time jumps
  // ════════════════════════════════════════════════════════════════════════

  const [minerState, setMinerState] = useState<MinerState | null>(null);
  const [loadingState, setLoadingState] = useState(false);
  const [simResult, setSimResult] = useState<SimResult | null>(null);
  const [simSeconds, setSimSeconds] = useState("3600"); // default 1 hour
  const [simulating, setSimulating] = useState(false);

  // Live timer — counts up from secsSinceLastTick so user can see elapsed time ticking
  const [liveSecs, setLiveSecs] = useState(0);
  const liveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch live miner state for the selected player ───────────────────────
  const fetchMinerState = useCallback(async () => {
    if (!selectedUserId) return;
    setLoadingState(true);
    const data = await adminFetch(`/api/admin/miner-state?userId=${selectedUserId}`);
    if (!data.error) {
      setMinerState(data as MinerState);
      setLiveSecs(data.secsSinceLastTick ?? 0);
    }
    setLoadingState(false);
    setSimResult(null); // clear previous sim result when refreshing
  }, [selectedUserId]);

  // Auto-fetch miner state when selected player changes
  useEffect(() => {
    if (selectedUserId) fetchMinerState();
    else setMinerState(null);
  }, [selectedUserId, fetchMinerState]);

  // ── Count-up ticker (updates liveSecs every second) ──────────────────────
  // Shows how many seconds have passed since the last real server tick.
  useEffect(() => {
    if (liveRef.current) clearInterval(liveRef.current);
    if (minerState) {
      liveRef.current = setInterval(() => setLiveSecs((s) => s + 1), 1000);
    }
    return () => { if (liveRef.current) clearInterval(liveRef.current); };
  }, [minerState]);

  // ── Run a time simulation ────────────────────────────────────────────────
  // Calls POST /api/admin/simulate-time which applies tick math for
  // `elapsedSeconds` without touching last_tick_at.
  const runSimulation = async (secs: number) => {
    if (!selectedUserId) return;
    setSimulating(true);
    const data = await adminFetch("/api/admin/simulate-time", {
      userId: selectedUserId,
      elapsedSeconds: secs,
    });
    setSimulating(false);
    if (data.success && data.simulated) {
      setSimResult(data.simulated as SimResult);
      toast({
        title: `Simulated ${fmtSecs(secs)}`,
        description: data.simulated.overheated
          ? "🔥 Miner overheated!"
          : `+${data.simulated.earned.toFixed(8)} balance earned`,
        variant: data.simulated.overheated ? "destructive" : "default",
      });
      // Refresh the live state so panel reflects new temp/balance
      fetchMinerState();
      fetchPlayers();
    } else {
      toast({ title: "Simulation failed", description: data.error, variant: "destructive" });
    }
  };

  // ── Compute "simulate to overheat" seconds from current miner state ───────
  const secsToOverheat = minerState?.secsToOverheat ?? null;

  // ════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-4 font-mono">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-yellow-400" />
          <h1 className="text-lg font-black text-yellow-400 uppercase tracking-wider">Admin Panel</h1>
          <span className="text-xs text-muted-foreground uppercase">[{storedUsername}]</span>
        </div>
        <Button variant="outline" size="sm" onClick={fetchPlayers}
          disabled={loadingPlayers} className="text-xs border-primary/30">
          <RefreshCw className={`w-3 h-3 mr-1 ${loadingPlayers ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* ── Player picker ── */}
      <Card className="border-yellow-500/30 bg-black/60">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-yellow-400 uppercase">Select Target Player</CardTitle>
          <CardDescription className="text-xs">
            Pick a player — all cheat actions below apply to them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted-foreground uppercase">
                  <th className="text-left py-1.5 pr-3">ID</th>
                  <th className="text-left py-1.5 pr-3">Username</th>
                  <th className="text-right py-1.5 pr-3">Gems</th>
                  <th className="text-right py-1.5 pr-3">Lvl</th>
                  <th className="text-right py-1.5 pr-3">Temp</th>
                  <th className="text-right py-1.5 pr-3">Rig</th>
                  <th className="text-right py-1.5">Flags</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id}
                    onClick={() => setSelectedUserId(p.id)}
                    className={`cursor-pointer border-b border-border/40 transition-colors ${
                      selectedUserId === p.id
                        ? "bg-yellow-500/10 text-yellow-300"
                        : p.is_banned
                        ? "bg-red-950/30 hover:bg-red-950/50"
                        : "hover:bg-accent/10"
                    }`}
                  >
                    <td className="py-1.5 pr-3">{p.id}</td>
                    <td className="py-1.5 pr-3 font-bold">
                      {p.username}
                      {/* Inline role badge next to name */}
                      {p.is_admin && (
                        <span className="ml-1.5 px-1 py-0 rounded text-[9px] bg-yellow-500/20 text-yellow-400 uppercase">admin</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-primary">{p.gems}</td>
                    <td className="py-1.5 pr-3 text-right">{p.miner_level}</td>
                    <td className={`py-1.5 pr-3 text-right ${p.temperature >= 100 ? "text-red-400" : p.temperature > 70 ? "text-orange-400" : ""}`}>
                      {Math.round(p.temperature)}°C
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase ${
                        p.miner_unlocked && p.is_running ? "bg-green-500/20 text-green-400"
                        : p.miner_unlocked ? "bg-red-500/20 text-red-400"
                        : "bg-zinc-500/20 text-zinc-400"
                      }`}>
                        {p.miner_unlocked ? (p.is_running ? "run" : "hot") : "off"}
                      </span>
                    </td>
                    {/* Moderation flag badges */}
                    <td className="py-1.5 text-right">
                      <div className="flex gap-1 justify-end flex-wrap">
                        {p.adblock_detected && (
                          <span title="Adblocker detected"
                            className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-orange-500/20 text-orange-400 font-bold">
                            ADB
                          </span>
                        )}
                        {p.is_banned && (
                          <span title="Banned"
                            className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-red-500/30 text-red-400 font-bold">
                            BAN
                          </span>
                        )}
                        {p.is_muted && (
                          <span title="Muted"
                            className="px-1.5 py-0.5 rounded text-[9px] uppercase bg-zinc-500/30 text-zinc-400 font-bold">
                            MUT
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {players.map((p) => (
              <div key={p.id} onClick={() => setSelectedUserId(p.id)}
                className={`cursor-pointer rounded border p-2 transition-colors ${
                  selectedUserId === p.id ? "border-yellow-500/50 bg-yellow-500/10"
                  : p.is_banned ? "border-red-800/50 bg-red-950/30"
                  : "border-border bg-black/30"
                }`}>
                <div className="flex justify-between items-start">
                  <div>
                    <span className="font-bold text-sm">{p.username}</span>
                    {p.is_admin && <span className="ml-1 text-[9px] bg-yellow-500/20 text-yellow-400 px-1 rounded uppercase">admin</span>}
                  </div>
                  <span className="text-primary text-xs">{p.gems} gems</span>
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  Lvl {p.miner_level} · {Math.round(p.temperature)}°C · {p.is_running ? "running" : "stopped"}
                </div>
                {/* Flag row — only shown when flags are set */}
                {(p.adblock_detected || p.is_banned || p.is_muted) && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {p.adblock_detected && <span className="px-1 py-0 rounded text-[9px] bg-orange-500/20 text-orange-400 uppercase font-bold">adblock</span>}
                    {p.is_banned && <span className="px-1 py-0 rounded text-[9px] bg-red-500/30 text-red-400 uppercase font-bold">banned</span>}
                    {p.is_muted && <span className="px-1 py-0 rounded text-[9px] bg-zinc-500/30 text-zinc-400 uppercase font-bold">muted</span>}
                  </div>
                )}
              </div>
            ))}
          </div>

          {selectedPlayer && (
            <div className="mt-3 px-2 py-1 rounded bg-yellow-500/10 border border-yellow-500/30 text-xs text-yellow-300">
              Target: <strong>{selectedPlayer.username}</strong> (ID {selectedPlayer.id})
            </div>
          )}
        </CardContent>
      </Card>

      {/* ══════════════════════════════════════════════════════════════════
          TIME SIMULATOR — the main feature for testing overheating etc.
      ══════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection icon={<Clock className="w-4 h-4 text-cyan-400" />}
        title="Time Simulator" sectionKey="time"
        open={openSection === "time"} onToggle={toggleSection}>
        <div className="space-y-4">

          {/* Live miner state readout */}
          {selectedUserId ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">
                  Live miner state
                </span>
                <Button variant="outline" size="sm"
                  onClick={fetchMinerState} disabled={loadingState}
                  className="text-xs h-6 px-2 border-cyan-400/30 text-cyan-400">
                  <RefreshCw className={`w-3 h-3 mr-1 ${loadingState ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </div>

              {minerState ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {/* Temperature gauge */}
                  <StatBox
                    label="Temperature"
                    value={`${minerState.temperature.toFixed(1)}°C`}
                    sub={`+${minerState.effectiveTempRise.toFixed(0)}°C/hr`}
                    color={minerState.temperature >= 100 ? "red" : minerState.temperature > 70 ? "orange" : "green"}
                  />
                  {/* Time since last tick */}
                  <StatBox
                    label="Since Last Tick"
                    value={fmtSecs(liveSecs)}
                    sub="counting up live"
                    color="cyan"
                  />
                  {/* Time to overheat */}
                  <StatBox
                    label="ETA to Overheat"
                    value={minerState.temperature >= 100
                      ? "OVERHEATED"
                      : secsToOverheat === null
                      ? "No rise"
                      : fmtSecs(secsToOverheat)}
                    sub={minerState.fans > 0 ? `${minerState.fans} fan(s) active` : "no fans"}
                    color={minerState.temperature >= 100 ? "red" : secsToOverheat && secsToOverheat < 300 ? "orange" : "cyan"}
                  />
                  {/* Balance */}
                  <StatBox
                    label="Balance"
                    value={minerState.currentBalance.toFixed(6)}
                    sub={`${(minerState.ratePerSec * 86400).toFixed(4)}/day`}
                    color="primary"
                  />
                  {/* Running status */}
                  <StatBox
                    label="Status"
                    value={!minerState.unlocked ? "LOCKED" : minerState.isRunning ? "RUNNING" : "STOPPED"}
                    sub={`${minerState.rigCount} rig(s) · ${minerState.solarPanels} solar`}
                    color={minerState.isRunning ? "green" : "red"}
                  />
                  {/* Fuel */}
                  <StatBox
                    label="Fuel"
                    value={`${minerState.fuel}/500`}
                    sub={`${minerState.generators} generator(s)`}
                    color={minerState.fuel < 50 ? "red" : "cyan"}
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  {loadingState ? "Loading…" : "No miner found for this player"}
                </p>
              )}

              {/* Simulation result banner */}
              {simResult && (
                <div className={`rounded border p-3 space-y-2 text-xs ${
                  simResult.overheated
                    ? "border-red-500/40 bg-red-500/10 text-red-300"
                    : simResult.stopReason === "fuel_empty"
                    ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                    : "border-green-500/40 bg-green-500/10 text-green-300"
                }`}>
                  {/* Header row */}
                  <div className="flex items-center gap-2 font-bold">
                    {simResult.overheated || simResult.stopReason === "fuel_empty"
                      ? <AlertTriangle className="w-3 h-3" />
                      : <CheckCircle2 className="w-3 h-3" />}
                    Sim result — {fmtSecs(simResult.elapsedSeconds)} window
                  </div>

                  {/* ── Run duration — the key new info ── */}
                  <div className={`rounded px-2 py-1.5 text-[11px] font-mono ${
                    simResult.stoppedEarly ? "bg-red-900/40" : "bg-green-900/30"
                  }`}>
                    {simResult.stopReason === "was_not_running" ? (
                      <span>⛔ Miner was <strong>not running</strong> — no income, no temp rise.</span>
                    ) : simResult.stoppedEarly ? (
                      <>
                        ⏱ Ran for <strong>{fmtSecs(simResult.runsForSeconds)}</strong> then stopped
                        {simResult.stopReason === "overheat"
                          ? <> — <span className="text-red-300 font-bold">🔥 OVERHEATED</span> at {fmtSecs(simResult.overheatsAtSecond ?? simResult.runsForSeconds)}</>
                          : <> — <span className="text-orange-300 font-bold">⛽ FUEL EMPTY</span></>}
                        <br />
                        <span className="text-muted-foreground">
                          Idle for remaining {fmtSecs(simResult.elapsedSeconds - simResult.runsForSeconds)} (no earnings after stop)
                        </span>
                      </>
                    ) : (
                      <span>✅ Ran the full <strong>{fmtSecs(simResult.runsForSeconds)}</strong> — still running after window</span>
                    )}
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                    <span>Temp: {simResult.oldTemp.toFixed(1)}°C → <strong>{simResult.newTemp.toFixed(1)}°C</strong></span>
                    <span>Still running: <strong>{simResult.isRunning ? "Yes ✅" : "No ❌"}</strong></span>
                    <span>Earned: <strong>+{simResult.earned.toFixed(8)}</strong></span>
                    <span>Fuel: {simResult.oldFuel} → {simResult.newFuel}</span>
                  </div>
                </div>
              )}

              {/* Quick time-jump presets */}
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground uppercase tracking-wider">
                  Jump forward by…
                </p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: "+1 min",   secs: 60      },
                    { label: "+10 min",  secs: 600     },
                    { label: "+30 min",  secs: 1800    },
                    { label: "+1 hr",    secs: 3600    },
                    { label: "+3 hr",    secs: 10800   },
                    { label: "+8 hr",    secs: 28800   },
                  ].map(({ label, secs }) => (
                    <Button key={label} size="sm" variant="outline"
                      className="text-xs border-cyan-400/30 text-cyan-300"
                      disabled={simulating || !minerState}
                      onClick={() => runSimulation(secs)}>
                      <Play className="w-3 h-3 mr-1" />{label}
                    </Button>
                  ))}

                  {/* "Sim to overheat" — only shown when ETA is known */}
                  {secsToOverheat !== null && minerState && minerState.temperature < 100 && (
                    <Button size="sm"
                      className="text-xs bg-red-600/80 text-white hover:bg-red-600 border border-red-500/50"
                      disabled={simulating}
                      onClick={() => runSimulation(Math.ceil(secsToOverheat! + 1))}>
                      <Thermometer className="w-3 h-3 mr-1" />
                      Sim to Overheat ({fmtSecs(secsToOverheat)})
                    </Button>
                  )}
                </div>

                {/* Custom seconds input */}
                <div className="flex gap-2 items-center">
                  <Input type="number" value={simSeconds}
                    onChange={(e) => setSimSeconds(e.target.value)}
                    className="bg-black/50 border-primary/20 text-xs h-8 w-32"
                    placeholder="Seconds" min={1} />
                  <span className="text-xs text-muted-foreground">
                    = {fmtSecs(parseInt(simSeconds) || 0)}
                  </span>
                  <Button size="sm"
                    className="text-xs bg-cyan-600 text-white hover:bg-cyan-700"
                    disabled={simulating || !minerState || !parseInt(simSeconds)}
                    onClick={() => runSimulation(parseInt(simSeconds))}>
                    {simulating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
                    Simulate
                  </Button>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Simulation applies the full tick math (temp rise, income, fuel drain) without
                  moving <code>last_tick_at</code> — so the real background ticker keeps running normally.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Select a player above to use the time simulator.
            </p>
          )}
        </div>
      </CollapsibleSection>

      {/* ── Gems ── */}
      <CollapsibleSection icon={<Gem className="w-4 h-4 text-primary" />}
        title="Gems" sectionKey="gems" open={openSection === "gems"} onToggle={toggleSection}>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {[100, 500, 1000, 5000, 99999].map((n) => (
              <Button key={n} size="sm" variant="outline"
                className="text-xs border-primary/30 text-primary"
                disabled={!selectedUserId} onClick={() => setGems(n)}>
                Set {n.toLocaleString()}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input type="number" value={gemAmount}
              onChange={(e) => setGemAmount(e.target.value)}
              className="bg-black/50 border-primary/20 text-xs h-8 w-32" placeholder="Amount" />
            <Button size="sm" className="text-xs bg-primary text-black hover:bg-primary/80"
              disabled={!selectedUserId} onClick={giveGems}>
              + Give Gems
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Items ── */}
      <CollapsibleSection icon={<Package className="w-4 h-4 text-blue-400" />}
        title="Give Item" sectionKey="items" open={openSection === "items"} onToggle={toggleSection}>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {[
              ["pickaxe_diamond", "💎 Diamond Pick", 1],
              ["raw_iron",        "🪨 Raw Iron",     20],
              ["raw_gold",        "🥇 Raw Gold",     10],
              ["raw_diamond",     "💠 Raw Diamond",   5],
              ["water_bucket",    "🪣 Water Bucket",  3],
              ["thermal_paste",   "🧴 Thermal Paste", 3],
              ["diesel_can",      "⛽ Diesel Can",    5],
              ["machine_core",    "🤖 Machine Core",  1],
              ["solar_panel_block","☀️ Solar Panel",  2],
              ["mining_rig",      "⚙️ Mining Rig",    3],
              ["data_cable",      "🔌 Data Cable",    5],
              ["fan_block",       "🌀 Fan Block",     4],
              ["generator_block", "🔋 Generator",     1],
              ["battery_block",   "🔌 Battery",       1],
            ].map(([id, label, qty]) => (
              <Button key={id as string} size="sm" variant="outline"
                className="text-xs border-blue-400/30 text-blue-300"
                disabled={!selectedUserId}
                onClick={() =>
                  adminFetch("/api/admin/give-item", {
                    userId: selectedUserId, itemId: id, quantity: qty,
                  }).then((data) => {
                    toast({
                      title: data.success ? `Gave ${label}` : "Failed",
                      description: data.success ? `Qty: ${data.newQuantity}` : data.error,
                      variant: data.success ? "default" : "destructive",
                    });
                  })
                }>
                {label as string}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input value={itemId} onChange={(e) => setItemId(e.target.value)}
              className="bg-black/50 border-primary/20 text-xs h-8 flex-1"
              placeholder="item_id (e.g. raw_iron)" />
            <Input type="number" value={itemQty} onChange={(e) => setItemQty(e.target.value)}
              className="bg-black/50 border-primary/20 text-xs h-8 w-16" placeholder="Qty" />
            <Button size="sm" className="text-xs bg-blue-600 text-white hover:bg-blue-700"
              disabled={!selectedUserId} onClick={giveItem}>
              Give
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Miner controls ── */}
      <CollapsibleSection icon={<Zap className="w-4 h-4 text-yellow-400" />}
        title="Miner" sectionKey="miner" open={openSection === "miner"} onToggle={toggleSection}>
        <div className="space-y-2">
          <div className="flex gap-2 items-end">
            <div className="space-y-1">
              <Label className="text-[10px] uppercase text-muted-foreground">Rig Count (level)</Label>
              <Input type="number" value={minerLevel} onChange={(e) => setMinerLevel(e.target.value)}
                className="bg-black/50 border-primary/20 text-xs h-8 w-24" min={0} max={9} />
            </div>
            <Button size="sm" className="text-xs bg-yellow-500 text-black hover:bg-yellow-400"
              disabled={!selectedUserId} onClick={setMinerLevelFn}>
              Set Level
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline"
              className="text-xs border-green-400/30 text-green-400"
              disabled={!selectedUserId}
              onClick={() => quickAction("/api/admin/unlock-miner", "Miner unlocked")}>
              <Zap className="w-3 h-3 mr-1" /> Unlock & Start
            </Button>
            <Button size="sm" variant="outline"
              className="text-xs border-blue-400/30 text-blue-400"
              disabled={!selectedUserId}
              onClick={() => quickAction("/api/admin/reset-temp", "Miner cooled to 0°C")}>
              <Thermometer className="w-3 h-3 mr-1" /> Reset Temp
            </Button>
            <Button size="sm" variant="outline"
              className="text-xs border-orange-400/30 text-orange-400"
              disabled={!selectedUserId}
              onClick={() => quickAction("/api/admin/refill-fuel", "Fuel filled to 500")}>
              <Fuel className="w-3 h-3 mr-1" /> Refill Fuel
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* ── Activity Points ── */}
      <CollapsibleSection icon={<Star className="w-4 h-4 text-purple-400" />}
        title="Activity Points" sectionKey="points"
        open={openSection === "points"} onToggle={toggleSection}>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Window points gate miner upgrade tiers. Max needed for all tiers: 5 200.
          </p>
          <div className="flex flex-wrap gap-2">
            {[500, 1400, 3500, 5200].map((n) => (
              <Button key={n} size="sm" variant="outline"
                className="text-xs border-purple-400/30 text-purple-300"
                disabled={!selectedUserId}
                onClick={() =>
                  adminFetch("/api/admin/add-points", { userId: selectedUserId, points: n })
                    .then((data) => {
                      toast({
                        title: data.success ? `+${n} pts` : "Failed",
                        description: data.success ? `New total: ${Math.floor(data.newPoints)}` : data.error,
                        variant: data.success ? "default" : "destructive",
                      });
                    })
                }>
                +{n}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input type="number" value={pointsAmount}
              onChange={(e) => setPointsAmount(e.target.value)}
              className="bg-black/50 border-primary/20 text-xs h-8 w-32" />
            <Button size="sm" className="text-xs bg-purple-600 text-white hover:bg-purple-700"
              disabled={!selectedUserId} onClick={givePoints}>
              Add Points
            </Button>
          </div>
        </div>
      </CollapsibleSection>

      {/* ════════════════════════════════════════════════════════════════════
          MODERATION — ban, mute, and admin management
          Ban   → player cannot log in (shown as BAN badge in table)
          Mute  → player cannot send chat messages
          Admin → player gets access to the admin panel
                  (only root admin can grant/revoke admin)
      ════════════════════════════════════════════════════════════════════ */}
      <CollapsibleSection icon={<ShieldAlert className="w-4 h-4 text-red-400" />}
        title="Moderation" sectionKey="moderation"
        open={openSection === "moderation"} onToggle={toggleSection}>
        <div className="space-y-4">
          {!selectedUserId && (
            <p className="text-xs text-muted-foreground italic">Select a player above first.</p>
          )}

          {selectedUserId && (
            <>
              {/* ── Ban / Unban ────────────────────────────────────── */}
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Account Ban</p>
                <p className="text-xs text-muted-foreground">
                  Banned accounts cannot log in — they see an error at the login screen.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm"
                    className="text-xs bg-red-700 text-white hover:bg-red-600 border border-red-600/50"
                    disabled={!selectedUserId || selectedPlayer?.is_banned}
                    onClick={() => quickAction("/api/admin/ban-user", `${selectedPlayer?.username} banned`)}>
                    <UserX className="w-3 h-3 mr-1" /> Ban Account
                  </Button>
                  <Button size="sm" variant="outline"
                    className="text-xs border-green-500/40 text-green-400 hover:bg-green-500/10"
                    disabled={!selectedUserId || !selectedPlayer?.is_banned}
                    onClick={() => quickAction("/api/admin/unban-user", `${selectedPlayer?.username} unbanned`)}>
                    <UserCheck className="w-3 h-3 mr-1" /> Unban
                  </Button>
                </div>
                {selectedPlayer?.is_banned && (
                  <p className="text-[11px] text-red-400 flex items-center gap-1">
                    <Ban className="w-3 h-3" /> This player is currently banned.
                  </p>
                )}
              </div>

              {/* ── Mute / Unmute ─────────────────────────────────── */}
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Chat Mute</p>
                <p className="text-xs text-muted-foreground">
                  Muted players can still play but cannot send chat messages.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm"
                    className="text-xs bg-zinc-700 text-white hover:bg-zinc-600 border border-zinc-500/50"
                    disabled={!selectedUserId || selectedPlayer?.is_muted}
                    onClick={() => quickAction("/api/admin/mute-user", `${selectedPlayer?.username} muted`)}>
                    <MessageSquareOff className="w-3 h-3 mr-1" /> Mute
                  </Button>
                  <Button size="sm" variant="outline"
                    className="text-xs border-zinc-400/40 text-zinc-300 hover:bg-zinc-500/10"
                    disabled={!selectedUserId || !selectedPlayer?.is_muted}
                    onClick={() => quickAction("/api/admin/unmute-user", `${selectedPlayer?.username} unmuted`)}>
                    <MessageSquare className="w-3 h-3 mr-1" /> Unmute
                  </Button>
                </div>
                {selectedPlayer?.is_muted && (
                  <p className="text-[11px] text-zinc-400 flex items-center gap-1">
                    <MessageSquareOff className="w-3 h-3" /> This player is currently muted.
                  </p>
                )}
              </div>

              {/* ── Grant / Revoke Admin ──────────────────────────── */}
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Admin Access</p>
                <p className="text-xs text-muted-foreground">
                  Only the root admin ({localStorage.getItem("username") ?? "admin"}) can grant or revoke admin powers.
                  Granted admins can use all admin panel features except granting further admin.
                </p>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm"
                    className="text-xs bg-yellow-600 text-black hover:bg-yellow-500 border border-yellow-500/50"
                    disabled={!selectedUserId || selectedPlayer?.is_admin}
                    onClick={() => quickAction("/api/admin/grant-admin", `${selectedPlayer?.username} is now admin`)}>
                    <ShieldCheck className="w-3 h-3 mr-1" /> Grant Admin
                  </Button>
                  <Button size="sm" variant="outline"
                    className="text-xs border-yellow-600/40 text-yellow-500 hover:bg-yellow-600/10"
                    disabled={!selectedUserId || !selectedPlayer?.is_admin}
                    onClick={() => quickAction("/api/admin/revoke-admin", `${selectedPlayer?.username} admin revoked`)}>
                    <ShieldOff className="w-3 h-3 mr-1" /> Revoke Admin
                  </Button>
                </div>
                {selectedPlayer?.is_admin && (
                  <p className="text-[11px] text-yellow-400 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> This player has admin access.
                  </p>
                )}
              </div>

              {/* ── Adblock status ────────────────────────────────── */}
              <div className="space-y-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Adblocker Status</p>
                <div className={`rounded border px-3 py-2 text-xs flex items-center gap-2 ${
                  selectedPlayer?.adblock_detected
                    ? "border-orange-500/40 bg-orange-500/10 text-orange-300"
                    : "border-green-500/30 bg-green-500/5 text-green-400"
                }`}>
                  {selectedPlayer?.adblock_detected
                    ? <><Ban className="w-3 h-3 shrink-0" /> Adblocker detected — this player cannot mine.</>
                    : <><CheckCircle2 className="w-3 h-3 shrink-0" /> No adblocker detected.</>}
                </div>
              </div>
            </>
          )}
        </div>
      </CollapsibleSection>

      {/* ── World Reset ── */}
      <CollapsibleSection icon={<Trash2 className="w-4 h-4 text-red-400" />}
        title="World Reset" sectionKey="world"
        open={openSection === "world"} onToggle={toggleSection}>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Deletes the world from the DB — it regenerates fresh on next visit.
          </p>
          <div className="flex gap-2">
            <Input value={worldName} onChange={(e) => setWorldName(e.target.value)}
              className="bg-black/50 border-primary/20 text-xs h-8 flex-1" placeholder="world1" />
            <Button size="sm" className="text-xs bg-red-600 text-white hover:bg-red-700"
              onClick={resetWorld}>
              <Trash2 className="w-3 h-3 mr-1" /> Wipe
            </Button>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}

// ── Small stat display box used in the live miner readout ─────────────────
function StatBox({
  label, value, sub, color,
}: {
  label: string;
  value: string;
  sub: string;
  color: "green" | "red" | "orange" | "cyan" | "primary";
}) {
  const colorMap = {
    green:   "text-green-400",
    red:     "text-red-400",
    orange:  "text-orange-400",
    cyan:    "text-cyan-400",
    primary: "text-primary",
  };
  return (
    <div className="rounded border border-border/50 bg-black/40 px-3 py-2 space-y-0.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-bold ${colorMap[color]}`}>{value}</p>
      <p className="text-[10px] text-muted-foreground">{sub}</p>
    </div>
  );
}

// ── Collapsible section container ─────────────────────────────────────────
// Click the header bar to expand/collapse — keeps the panel compact.
function CollapsibleSection({
  icon, title, sectionKey, open, onToggle, children,
}: {
  icon: React.ReactNode;
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-border/50 bg-black/50">
      <button className="w-full flex items-center justify-between px-4 py-3 text-left"
        onClick={() => onToggle(sectionKey)}>
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs font-bold uppercase tracking-wider">{title}</span>
        </div>
        {open
          ? <ChevronUp className="w-3 h-3 text-muted-foreground" />
          : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      </button>
      {open && <CardContent className="pt-0 pb-4">{children}</CardContent>}
    </Card>
  );
}
