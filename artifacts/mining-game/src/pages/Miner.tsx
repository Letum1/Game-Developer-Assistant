/**
 * Miner.tsx — Data Center / Passive Income Dashboard
 *
 * Shows the player's passive mining rig status, live balance counter, and
 * the "Watch Ad" rewarded-ad system with a full client-side anti-cheat layer.
 *
 * Anti-cheat ad flow (matches the server's timestamp verification):
 *   1. Player clicks a "Watch Ad" button → POST /api/monetization/request-task
 *      Server creates a DB row with a timestamp + returns a one-time token + ad URL.
 *   2. Client opens the Adsterra Smartlink in a popup window.
 *   3. Full-screen overlay appears with a 15-second countdown.
 *   4. Tab-visibility guard: if the player switches tabs, the countdown PAUSES and
 *      a warning appears. The server also checks elapsed wall-clock time, so tab-
 *      switching genuinely delays the reward — it cannot be cheated.
 *   5. Popup-close guard: an interval polls adWindow.closed every 400 ms. If the
 *      player closes the popup before the timer reaches 0, the ad is cancelled
 *      immediately and no reward is issued.
 *   6. After the countdown, POST /api/monetization/verify-task with the token.
 *      Server independently checks ≥15 s elapsed — client cannot skip this.
 *   7. Reward is applied server-side and the token row is deleted (one-time use).
 *
 * Task types:
 *   gem_reward  — "Watch Ad for Gems" → +50 gems, +25 leaderboard points
 *   drill_boost — "Overcharge Drill"  → +10 gems, +50 leaderboard points
 *   cool_down   — "Flash Cool Down"   → reset miner temperature to 0
 */

import { useEffect, useState, useRef, useCallback } from "react";

// ── How rig level works ───────────────────────────────────────────────────────
// Level is driven by world blocks, not gem spending.
// Place Machine Core + Mining Rig blocks (each = 1 TH, needs 1 power unit to run).
// Connect Solar Panels or Generators via Data Cables to supply power.
// active_rigs = min(total_mining_rigs, power_supply). Rate scales with active_rigs.
// Fan blocks reduce temperature rise — 4 fans = no overheating at base load.
import {
  useGetMiner,
  useGetWallet,
  useMinerTick,
  useMaintainMiner,
  useVerifyMonetizationTask,
} from "@workspace/api-client-react";
import { useBtcPrice } from "@/hooks/use-btc-price";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Server, Activity, Thermometer, Cpu, Zap, Snowflake,
  Hammer, BatteryCharging, Download, TrendingUp, Sun, Fuel, Gem,
} from "lucide-react";
import { Link } from "wouter";

// ── Fuel constants (must stay in sync with server game-constants.ts) ──────────
const MAX_FUEL        = 500;
const FUEL_DRAIN_RATE = 0.05; // units per second per always-on block

// ── Power-unit values for each block type (must match server scanMachineCluster) ──
// solar_panel_block = 1 unit (daytime only)
// battery_block     = 1 unit (always-on, charged by solar)
// generator_block   = 2 units (always-on, requires diesel fuel)
const MAX_LEVEL = 9; // effective speed ceiling (MINER_RATES[9] is the peak rate)

// ── Anti-cheat ad constants ───────────────────────────────────────────────────
// Must match REQUIRED_WATCH_SECONDS in monetization.ts
const AD_WATCH_SECONDS = 15;
// Daily cap for Overcharge Drill — must match DRILL_BOOST_MAX_PER_DAY in game-constants.ts
const DRILL_BOOST_MAX = 3;

export default function Miner() {
  const { data: miner, refetch } = useGetMiner();
  const { data: wallet }         = useGetWallet();

  // BTC price used to convert internal sats balance → USD for display.
  // The player sees dollars going up — conversion to sats happens on the Wallet page.
  const btcPrice = useBtcPrice();

  const minerTick          = useMinerTick();
  const maintainMiner      = useMaintainMiner();
  const verifyMonetization = useVerifyMonetizationTask();
  const { toast } = useToast();

  // Track whether a task request is in flight (disables buttons during API call)
  const [adRequesting, setAdRequesting] = useState(false);

  // ── Local balance (sats) — ticks every 100ms for visual dopamine ─────────
  // Synced from the server on mount and every 30 s. Displayed as USD.
  const [localBalance, setLocalBalance] = useState<number>(0);
  const [isCollecting, setIsCollecting] = useState(false);

  // ── Floating earnings particles ───────────────────────────────────────────
  // Each particle floats upward over the balance display, then disappears.
  // Spawned every 3 seconds while the miner is running.
  const [particles, setParticles] = useState<{ id: number; label: string; x: number }[]>([]);
  const particleIdRef = useRef(0);

  // ── Ad overlay state ──────────────────────────────────────────────────────
  // Controls the fullscreen "Watching Ad" overlay during the 15-second countdown.
  const [adOverlayActive, setAdOverlayActive] = useState(false);
  const [adTimeLeft,      setAdTimeLeft]      = useState(AD_WATCH_SECONDS);
  const [adPaused,        setAdPaused]        = useState(false);   // true = tab is hidden
  const [adWarning,       setAdWarning]       = useState("");      // tab-switch warning text

  // ── Ad refs — used inside interval callbacks so we avoid stale closure issues ──
  const adWindowRef       = useRef<Window | null>(null);            // popup window handle
  const adCountdownRef    = useRef<ReturnType<typeof setInterval> | null>(null); // 1s tick
  const integrityCheckRef = useRef<ReturnType<typeof setInterval> | null>(null); // 400ms poll
  const adTokenRef        = useRef<string | null>(null);            // one-time server token
  const adPausedRef       = useRef(false);                          // mirrors adPaused for intervals
  const adTimeLeftRef     = useRef(AD_WATCH_SECONDS);               // mirrors adTimeLeft for intervals

  // ── Sync initial balance from server ─────────────────────────────────────
  useEffect(() => {
    if (miner) setLocalBalance(miner.currentBalance);
  }, [miner]);

  // ── Local balance ticker — runs every 100ms for smooth visual update ──────
  useEffect(() => {
    if (!miner || !miner.isRunning) return;
    const interval = setInterval(() => {
      setLocalBalance(prev => prev + ((miner.ratePerSecond || 0) / 10));
    }, 100);
    return () => clearInterval(interval);
  }, [miner]);

  // ── Particle spawner — fires every 3s while the miner is running ──────────
  // Shows a floating +$X.XXXXXXXX label that drifts upward over the balance card.
  useEffect(() => {
    if (!miner || !miner.isRunning || !btcPrice) return;

    const spawnParticle = () => {
      const earned3s = ((miner.ratePerSecond ?? 0) * 3 / 100_000_000) * btcPrice;
      const label = earned3s < 0.000001
        ? `+$${earned3s.toFixed(10)}`
        : earned3s < 0.001
        ? `+$${earned3s.toFixed(8)}`
        : `+$${earned3s.toFixed(6)}`;

      // Random horizontal offset so particles don't all stack on top of each other
      const x  = 30 + Math.random() * 40;
      const id = ++particleIdRef.current;
      setParticles(prev => [...prev, { id, label, x }]);

      // Remove after the 2s CSS animation completes
      setTimeout(() => {
        setParticles(prev => prev.filter(p => p.id !== id));
      }, 2000);
    };

    const interval = setInterval(spawnParticle, 3000);
    spawnParticle(); // fire immediately on mount so the player sees it right away
    return () => clearInterval(interval);
  }, [miner, btcPrice]);

  // ── Server sync every 30 s — keeps local balance accurate ────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      minerTick.mutate(undefined, {
        onSuccess: (data) => {
          setLocalBalance(data.currentBalance);
          refetch();
        },
      });
    }, 30_000);
    return () => clearInterval(interval);
  }, [minerTick, refetch]);

  // ── Tab-visibility guard ──────────────────────────────────────────────────
  // When the player switches away from this tab during an ad, the countdown
  // pauses and a warning is shown. adPausedRef is read inside the countdown
  // interval to skip ticks while paused.
  useEffect(() => {
    const handleVisibility = () => {
      if (!adOverlayActive) return;
      if (document.hidden) {
        // Tab went hidden — pause countdown
        adPausedRef.current = true;
        setAdPaused(true);
        setAdWarning("⚠ TIMER PAUSED — Return to this tab to resume your reward!");
      } else {
        // Tab is visible again — resume countdown
        adPausedRef.current = false;
        setAdPaused(false);
        setAdWarning("");
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [adOverlayActive]);

  // ── clearAdTimers — stops both the countdown and popup-integrity intervals ──
  const clearAdTimers = useCallback(() => {
    if (adCountdownRef.current)    clearInterval(adCountdownRef.current);
    if (integrityCheckRef.current) clearInterval(integrityCheckRef.current);
    adCountdownRef.current    = null;
    integrityCheckRef.current = null;
  }, []);

  // ── completeAd — called after the 15-second countdown finishes cleanly ────
  // Calls the server to verify and grant the reward using the one-time token.
  const completeAd = useCallback(() => {
    const token = adTokenRef.current;
    if (!token) return;

    setAdOverlayActive(false);
    adTokenRef.current = null;

    // Server independently checks that ≥15 s elapsed since task creation.
    // Client-side countdown alone is NOT the source of truth.
    verifyMonetization.mutate({ data: { token } }, {
      onSuccess: (res) => {
        if (res.success) {
          toast({
            title: "REWARD CLAIMED!",
            description: res.message ?? "Reward applied.",
            className: "bg-black border-primary text-primary font-mono uppercase",
          });
          refetch(); // refresh wallet/miner data
        } else {
          toast({
            title: "VERIFICATION FAILED",
            description: (res as any).message ?? "Server rejected the claim.",
            variant: "destructive",
          });
        }
      },
      onError: () => {
        toast({ title: "NETWORK ERROR", description: "Could not reach the server.", variant: "destructive" });
      },
    });
  }, [verifyMonetization, refetch, toast]);

  // ── startRewardedAd — main entry point for any "Watch Ad" button ──────────
  //
  // ALL task types now open an Adsterra popup in the user-gesture context.
  // window.open() MUST be synchronous — calling it after an await fails on
  // mobile Safari because the user-gesture context has already expired.
  //
  // Integrity levels:
  //   gem_reward   — popup + 15s countdown + popup-close guard (full)
  //   drill_boost  — popup + 15s countdown + popup-close guard (full, verified)
  //   cool_down    — popup + 15s countdown, NO popup-close guard (simpler flow)
  // Ref-based guard: blocks re-entry immediately (before React state updates).
  // Prevents the double-click race where multiple popups open simultaneously
  // before setAdRequesting(true) has had a chance to disable the button.
  const adStartingRef = useRef(false);

  const startRewardedAd = useCallback(async (type: "drill_boost" | "cool_down" | "gem_reward") => {
    if (adStartingRef.current) return; // immediate synchronous guard
    adStartingRef.current = true;

    const userId = localStorage.getItem("userId");
    if (!userId) {
      adStartingRef.current = false;
      toast({ title: "NOT LOGGED IN", description: "Please log in and try again.", variant: "destructive" });
      return;
    }

    // ── Step 1: Open Adsterra popup SYNCHRONOUSLY for ALL task types ─────────
    // This preserves the user-gesture context that mobile browsers require.
    // We open "about:blank" now, then navigate to the real URL after the API call.
    const popup = window.open("about:blank", "_blank", "width=800,height=600,scrollbars=yes");
    if (!popup) {
      adStartingRef.current = false;
      toast({
        title: "POPUP BLOCKED",
        description: "Allow popups for this site in your browser settings, then try again.",
        variant: "destructive",
      });
      return;
    }

    // ── Step 2: Call the server to create a timestamped task + get token ───
    // Send `type` as BOTH a query param and in the JSON body.
    // iOS Safari can strip the body when a popup is opened just before an async
    // fetch — the query param is a reliable fallback the server checks first.
    setAdRequesting(true);
    try {
      const res = await fetch(`/api/monetization/request-task?type=${encodeURIComponent(type)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({ type }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        popup.close();
        adStartingRef.current = false;
        toast({
          title: "REQUEST FAILED",
          description: data.error ?? data.message ?? "Could not start ad task. Try again.",
          variant: "destructive",
        });
        setAdRequesting(false);
        return;
      }

      // ── Step 3: Navigate popup to the real Adsterra Smartlink ────────────
      // data.adUrl is the Adsterra Direct Link returned by the server.
      // No fallback — if the server didn't return a URL, close the popup and bail.
      if (!data.adUrl) {
        popup.close();
        toast({ title: "AD URL MISSING", description: "Server did not return an ad URL. Try again.", variant: "destructive" });
        setAdRequesting(false);
        return;
      }
      if (!popup.closed) {
        popup.location.href = data.adUrl;
      }

      // Store references for the countdown intervals
      adTokenRef.current    = data.token;
      adWindowRef.current   = popup;
      adTimeLeftRef.current = AD_WATCH_SECONDS;
      adPausedRef.current   = false;

      // ── Step 4: Show the fullscreen overlay and start the countdown ───────
      setAdOverlayActive(true);
      setAdTimeLeft(AD_WATCH_SECONDS);
      setAdPaused(false);
      setAdWarning("");
      setAdRequesting(false);

      // ── Countdown interval — ticks every 1 second ─────────────────────────
      adCountdownRef.current = setInterval(() => {
        if (adPausedRef.current) return;
        adTimeLeftRef.current -= 1;
        setAdTimeLeft(adTimeLeftRef.current);
        if (adTimeLeftRef.current <= 0) {
          clearAdTimers();
          completeAd();
        }
      }, 1000);

      // ── Popup-integrity interval — gem_reward and drill_boost only ─────────
      // Cancels the reward if the player closes the popup before the timer ends.
      // cool_down is intentionally simpler: closing the popup early is tolerated.
      if (type !== "cool_down") {
        integrityCheckRef.current = setInterval(() => {
          if (adWindowRef.current && adWindowRef.current.closed) {
            clearAdTimers();
            setAdOverlayActive(false);
            adTokenRef.current = null;
            toast({
              title: "AD CLOSED EARLY",
              description: "Keep the ad window open for 15 seconds. No reward issued.",
              variant: "destructive",
            });
          }
        }, 400);
      }

    } catch {
      popup.close();
      adStartingRef.current = false;
      setAdRequesting(false);
      toast({ title: "NETWORK ERROR", description: "Could not reach the server.", variant: "destructive" });
    }
  }, [clearAdTimers, completeAd, toast]);

  // ── Collect accumulated miner balance into wallet.real_balance ────────────
  // Calls POST /api/miner/collect which moves current_balance → wallets.real_balance
  // and resets the miner counter. Balance persists in wallet across logins/rig resets.
  const handleCollect = async () => {
    const userId = localStorage.getItem("userId");
    if (!userId || localBalance <= 0) return;
    setIsCollecting(true);
    try {
      const res = await fetch("/api/miner/collect", {
        method: "POST",
        headers: { "x-user-id": userId, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        const collectedSats = data.collected ?? 0;
        const collectedUsd  = btcPrice
          ? `$${((collectedSats / 100_000_000) * btcPrice).toFixed(6)}`
          : `$0.000000`;
        toast({
          title: "BALANCE COLLECTED",
          description: `${collectedUsd} moved to your wallet.`,
          className: "bg-black border-primary text-primary font-mono uppercase",
        });
        setLocalBalance(0);
        refetch();
      } else {
        toast({ title: "NOTHING TO COLLECT", description: data.error ?? "Balance is zero.", variant: "destructive" });
      }
    } catch {
      toast({ title: "COLLECT FAILED", description: "Network error.", variant: "destructive" });
    } finally {
      setIsCollecting(false);
    }
  };

  // ── Maintenance actions — use items from inventory ────────────────────────
  const handleMaintenance = (type: "flush_cooling" | "thermal_paste") => {
    maintainMiner.mutate({ data: { type } }, {
      onSuccess: () => {
        toast({
          title: "MAINTENANCE COMPLETE",
          description: "Systems stabilized.",
          className: "bg-black border-accent text-accent font-mono uppercase",
        });
        refetch();
      },
      onError: (err: any) => {
        toast({ title: "MAINTENANCE FAILED", description: err?.data?.message || "Missing resources.", variant: "destructive" });
      },
    });
  };

  // ── Loading / locked states ───────────────────────────────────────────────
  if (!miner) return (
    <div className="p-8 text-center text-primary font-mono animate-pulse">
      Connecting to Data Center...
    </div>
  );

  if (!miner.unlocked) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="flex flex-col items-center justify-center h-full p-8 font-mono space-y-6 text-center">
        <div className="border border-border rounded-xl p-10 bg-black/60 max-w-md space-y-6 shadow-[0_0_40px_rgba(0,0,0,0.8)]">
          <Server className="w-16 h-16 text-muted-foreground mx-auto opacity-40" />
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-tighter">Data Center Locked</h2>
            <p className="text-muted-foreground text-sm mt-2 leading-relaxed">
              You need to build a <span className="text-primary font-bold">Data Center Rig</span> before you can start earning passive income.
            </p>
          </div>
          <div className="bg-black/50 border border-border rounded p-3 text-xs text-left space-y-1">
            <p className="text-muted-foreground uppercase tracking-widest text-[10px] mb-2">Required to craft:</p>
            <div className="flex justify-between"><span className="text-gray-400">Raw Iron</span><span className="text-primary font-bold">×8</span></div>
            <div className="flex justify-between"><span className="text-yellow-500">Raw Gold</span><span className="text-primary font-bold">×5</span></div>
            <div className="flex justify-between"><span className="text-cyan-400">Raw Diamond</span><span className="text-primary font-bold">×2</span></div>
          </div>
          <div className="flex flex-col gap-2">
            <Link href="/craft">
              <Button className="w-full bg-primary/20 border border-primary text-primary hover:bg-primary hover:text-black font-bold uppercase tracking-widest">
                <Hammer className="w-4 h-4 mr-2" /> Go to Workbench
              </Button>
            </Link>
            <Link href="/game">
              <Button variant="outline" className="w-full border-border text-muted-foreground hover:text-white font-bold uppercase tracking-widest text-xs">
                Mine Resources First
              </Button>
            </Link>
          </div>
        </div>
      </motion.div>
    );
  }

  // ── Derived display values ────────────────────────────────────────────────
  const tempColor    = miner.temperature < 60 ? "text-primary" : miner.temperature < 80 ? "text-yellow-500" : "text-destructive";
  const isOverheated = miner.temperature >= 100;

  // localBalance is kept in sats internally; displayed as USD so the counter
  // looks like real money growing. Players convert on the Wallet page.
  const satsToUsd = (sats: number): string => {
    if (!btcPrice) return "$0.000000";
    const usd = (sats / 100_000_000) * btcPrice;
    if (usd >= 1)      return `$${usd.toFixed(4)}`;
    if (usd >= 0.0001) return `$${usd.toFixed(6)}`;
    return `$${usd.toFixed(8)}`;
  };

  // Rate per second in USD — shown to player without mentioning sats
  const usdPerSec = btcPrice ? ((miner.ratePerSecond ?? 0) / 100_000_000) * btcPrice : 0;
  const usdPerSecStr = usdPerSec < 0.000001
    ? `$${usdPerSec.toFixed(10)}`
    : usdPerSec < 0.001
    ? `$${usdPerSec.toFixed(8)}`
    : `$${usdPerSec.toFixed(6)}`;

  // ── Rig / power stats — server adds these extra fields to the response ────
  // Accessed via `as any` since the OpenAPI type doesn't include them yet.
  const anyMiner    = miner as any;
  const rigCount    = anyMiner.rigCount   ?? miner.level ?? 0;
  const activeRigs  = anyMiner.activeRigs ?? 0;
  const powerSupply = anyMiner.powerSupply  ?? 0;
  const powerDemand = anyMiner.powerDemand  ?? rigCount;
  const fanCount    = anyMiner.fanCount   ?? 0;

  // Effective display level — clamped to MINER_RATES ceiling
  const displayLevel  = Math.min(rigCount, MAX_LEVEL);
  const levelProgress = displayLevel >= MAX_LEVEL ? 100 : (displayLevel / MAX_LEVEL) * 100;

  // ── Fuel / battery calculations ──────────────────────────────────────────
  const generators  = miner.generators ?? 0;
  const fuel        = miner.fuel ?? 0;
  const fuelPct     = Math.min(100, Math.round((fuel / MAX_FUEL) * 100));
  const drainPerSec = generators * FUEL_DRAIN_RATE;
  const fuelTimeSec = drainPerSec > 0 ? fuel / drainPerSec : 0;
  const hasFuelSource = generators > 0;

  const formatFuelTime = (secs: number) => {
    if (secs <= 0 || !hasFuelSource) return "—";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    const s = Math.floor(secs % 60);
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const hasPower  = (miner.solarPanels ?? 0) > 0 || (miner.generators ?? 0) > 0;
  const hasRigs   = rigCount > 0;
  const statusLabel = !hasRigs ? "NO RIGS" : !hasPower ? "NO POWER" : isOverheated ? "OVERHEATED" : miner.isRunning ? "ONLINE" : "OFFLINE";
  const statusClass  = (!hasRigs || !hasPower)
    ? "border-yellow-500 text-yellow-400"
    : miner.isRunning
    ? "border-primary text-primary"
    : "border-destructive text-destructive";

  // Progress percentage for the ad countdown overlay
  const adProgress = ((AD_WATCH_SECONDS - adTimeLeft) / AD_WATCH_SECONDS) * 100;

  return (
    <>
      {/* ── Full-screen Ad Overlay ────────────────────────────────────────────
          Shown during the 15-second rewarded-ad countdown.
          Blocks all interaction so the player cannot navigate away without the
          popup-close guard catching it and cancelling the reward.
          z-index: 9999 — sits above all game UI including the nav.
      ─────────────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {adOverlayActive && (
          <motion.div
            key="ad-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
            style={{ background: "rgba(0,0,0,0.92)" }}
          >
            {/* Overlay card */}
            <div className="bg-[#1a1a1e] border border-primary/40 rounded-2xl p-8 max-w-sm w-full mx-4 text-center space-y-6 shadow-[0_0_60px_rgba(34,197,94,0.2)]">

              {/* Gem icon — pulses to show something is happening */}
              <div className="flex justify-center">
                <Gem className={`w-16 h-16 ${adPaused ? "text-yellow-400" : "text-primary"} animate-pulse`} />
              </div>

              {/* Title */}
              <div>
                <h2 className="text-xl font-black text-white uppercase tracking-widest font-mono">
                  {adPaused ? "Timer Paused" : "Watching Ad..."}
                </h2>
                <p className="text-muted-foreground text-xs mt-1 uppercase tracking-widest">
                  Keep this tab open and the ad window active
                </p>
              </div>

              {/* Countdown number */}
              <div className={`text-6xl font-black tracking-tighter tabular-nums font-mono
                ${adPaused ? "text-yellow-400" : "text-primary"}
                drop-shadow-[0_0_20px_rgba(34,197,94,0.6)]`}>
                {adTimeLeft}s
              </div>

              {/* Progress bar — fills left-to-right as time elapses */}
              <div className="w-full h-2 bg-black/60 border border-border rounded-full overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${adPaused ? "bg-yellow-400" : "bg-primary"}`}
                  animate={{ width: `${adProgress}%` }}
                  transition={{ duration: 0.4 }}
                />
              </div>

              {/* Tab-switch warning — only shown when paused */}
              {adWarning && (
                <motion.p
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-yellow-400 font-bold text-sm font-mono"
                >
                  {adWarning}
                </motion.p>
              )}

              {/* Instructions */}
              <p className="text-muted-foreground text-xs leading-relaxed">
                Do not close the ad window or leave this tab — the timer will pause
                and your reward will be delayed.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Main page content ─────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto font-mono overflow-y-auto h-full"
      >

        {/* ── No-rig warning banner ──────────────────────────────────────── */}
        {!hasRigs && (
          <div className="border border-yellow-500/60 bg-yellow-500/5 rounded-lg p-4 flex items-start gap-3">
            <Cpu className="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-yellow-400 font-bold uppercase tracking-widest text-sm">No Mining Rigs Placed</p>
              <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
                Craft <span className="text-yellow-400 font-bold">Mining Rig</span> blocks at the Workbench (3 Iron + 1 Gold each) and place them in your Machine Core cluster. Each rig = +1 TH. You also need a power source — Solar Panel, Battery, or Generator.
              </p>
            </div>
          </div>
        )}

        {/* ── No-power warning banner ────────────────────────────────────── */}
        {hasRigs && !hasPower && (
          <div className="border border-yellow-500/60 bg-yellow-500/5 rounded-lg p-4 flex items-start gap-3">
            <Zap className="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-yellow-400 font-bold uppercase tracking-widest text-sm">No Power Source Detected</p>
              <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
                Your rig needs power. Craft a{" "}
                <span className="text-yellow-400 font-bold">Solar Panel Block</span> and place it in open sky connected to your{" "}
                <span className="text-yellow-400 font-bold">Machine Core</span> via{" "}
                <span className="text-yellow-400 font-bold">Data Cables</span>. For 24/7 power add a{" "}
                <span className="text-blue-400 font-bold">Battery Block</span> or{" "}
                <span className="text-orange-400 font-bold">Generator Block</span>.
              </p>
            </div>
          </div>
        )}

        {/* ── Page header ───────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] flex items-center">
              <Server className="mr-3 w-8 h-8" /> Data Center Core
            </h1>
            <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">Passive Generation Engine</p>
          </div>
          <Badge variant="outline" className={`px-3 py-1 border ${statusClass} uppercase tracking-widest`}>
            {statusLabel}
          </Badge>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* ── Live Balance Card ─────────────────────────────────────────── */}
          <Card className="md:col-span-2 border-primary/30 bg-black/60 shadow-[0_0_30px_rgba(0,0,0,0.8)] relative overflow-hidden">
            {/* CRT scanline overlay — purely decorative */}
            <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(transparent_50%,rgba(0,0,0,1)_50%)] bg-[length:100%_4px]" />
            <CardHeader>
              <CardTitle className="text-muted-foreground uppercase text-xs tracking-widest flex items-center">
                <Activity className="w-4 h-4 mr-2" /> Live Yield
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center py-8 gap-4 relative">

              {/* ── Floating earnings particles — drift upward and fade ─────── */}
              {particles.map(p => (
                <span
                  key={p.id}
                  className="pointer-events-none absolute select-none font-mono font-bold text-primary text-xs"
                  style={{
                    left: `${p.x}%`,
                    bottom: "60%",
                    animation: "floatUp 2s ease-out forwards",
                    textShadow: "0 0 8px rgba(34,197,94,0.8)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.label}
                </span>
              ))}

              {/* ── Live balance counter — ticks locally every 100ms ─────────── */}
              <div className="text-4xl md:text-6xl font-black text-primary tracking-tighter drop-shadow-[0_0_15px_rgba(34,197,94,0.6)] font-mono tabular-nums">
                {satsToUsd(localBalance)}
              </div>

              {/* Rate per second */}
              <div className="flex items-center gap-2 text-muted-foreground text-sm uppercase tracking-widest">
                <TrendingUp className="w-4 h-4 text-primary" />
                <span className="text-primary font-bold">+{usdPerSecStr}</span> / sec
                {activeRigs > 0 && (
                  <span className="text-xs text-muted-foreground">({activeRigs} rig{activeRigs !== 1 ? "s" : ""} active)</span>
                )}
              </div>

              {/* Collect button — transfers balance to wallet for permanent storage */}
              <Button
                className="mt-2 bg-primary/20 text-primary border border-primary hover:bg-primary hover:text-black uppercase tracking-widest font-bold px-8"
                onClick={handleCollect}
                disabled={isCollecting || localBalance <= 0}
              >
                <Download className="w-4 h-4 mr-2" />
                {isCollecting ? "COLLECTING..." : "COLLECT BALANCE"}
              </Button>
            </CardContent>
          </Card>

          {/* ── Temperature Gauge ─────────────────────────────────────────── */}
          <Card className={`border ${isOverheated ? "border-destructive/80 animate-pulse shadow-[0_0_20px_rgba(239,68,68,0.4)]" : "border-border"} bg-black/60`}>
            <CardHeader>
              <CardTitle className="text-muted-foreground uppercase text-xs tracking-widest flex items-center">
                <Thermometer className="w-4 h-4 mr-2" /> Core Temp
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col items-center">
                <div className={`text-5xl font-black tracking-tighter tabular-nums ${tempColor}`}>
                  {Math.round(miner.temperature)}°C
                </div>
                <Progress value={miner.temperature} className={`h-2 mt-4 ${isOverheated ? "bg-destructive/20" : ""}`} />
              </div>

              <div className="space-y-2">
                {/* Flush cooling — costs 1 Water Bucket from inventory */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-accent text-accent hover:bg-accent hover:text-black uppercase tracking-widest text-xs"
                  onClick={() => handleMaintenance("flush_cooling")}
                  disabled={maintainMiner.isPending}
                >
                  <Snowflake className="w-3 h-3 mr-2" /> Flush Cooling (1 Bucket)
                </Button>
                {/* Thermal paste — applies maintenance item */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-muted-foreground text-muted-foreground hover:text-white uppercase tracking-widest text-xs"
                  onClick={() => handleMaintenance("thermal_paste")}
                  disabled={maintainMiner.isPending}
                >
                  <Cpu className="w-3 h-3 mr-2" /> Apply Thermal Paste
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ── Fuel / Battery Status Card (only shown when always-on blocks exist) ── */}
        {hasFuelSource && (
          <Card className={`border ${fuel === 0 ? "border-destructive/70 animate-pulse" : fuel < MAX_FUEL * 0.2 ? "border-orange-500/60" : "border-yellow-500/30"} bg-black/60`}>
            <CardHeader>
              <CardTitle className="text-muted-foreground uppercase text-xs tracking-widest flex items-center">
                <BatteryCharging className="w-4 h-4 mr-2" /> Fuel / Battery Charge
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className={`text-4xl font-black tabular-nums ${fuel === 0 ? "text-destructive" : fuel < MAX_FUEL * 0.2 ? "text-orange-400" : "text-yellow-400"}`}>
                  {fuelPct}%
                </span>
                <span className="text-muted-foreground text-xs uppercase tracking-widest text-right">
                  {fuel} / {MAX_FUEL} units<br />
                  {hasFuelSource && fuel > 0 ? `~${formatFuelTime(fuelTimeSec)} remaining` : fuel === 0 ? "EMPTY — refuel generator" : ""}
                </span>
              </div>
              {/* Fuel bar — color shifts red when low */}
              <div className="w-full h-3 rounded bg-black/60 border border-border overflow-hidden">
                <div
                  className="h-full transition-all duration-1000"
                  style={{
                    width: `${fuelPct}%`,
                    backgroundColor: fuel === 0 ? "#ef4444" : fuel < MAX_FUEL * 0.2 ? "#f97316" : "#eab308",
                  }}
                />
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {fuel === 0
                  ? "⚠ Generator is out of fuel — rig running on solar only."
                  : "Tap a Generator or Battery block in the game world while holding a Diesel Can to refuel."}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* ── System Specifications ─────────────────────────────────────── */}
          <Card className="border-border bg-sidebar/50">
            <CardHeader>
              <CardTitle className="text-white uppercase text-sm tracking-widest">System Specifications</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Total mining rig blocks placed */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Cpu className="w-3 h-3 text-primary" /> Mining Rigs (TH)
                </span>
                <span className="text-primary font-bold">{rigCount}</span>
              </div>
              {/* Active = powered rigs */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Activity className="w-3 h-3 text-green-400" /> Active Rigs
                </span>
                <span className={activeRigs < rigCount ? "text-yellow-400 font-bold" : "text-primary font-bold"}>
                  {activeRigs} / {rigCount}
                  {activeRigs < rigCount && <span className="text-yellow-400 text-[10px] ml-1">(underpowered)</span>}
                </span>
              </div>
              {/* Power supply vs demand */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Zap className="w-3 h-3 text-yellow-400" /> Power
                </span>
                <span className={powerSupply < powerDemand ? "text-orange-400 font-bold" : "text-primary font-bold"}>
                  {powerSupply} / {powerDemand} units
                </span>
              </div>
              {/* Solar panels */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Sun className="w-3 h-3 text-yellow-400" /> Solar
                </span>
                <span className="text-yellow-400 font-bold">{miner.solarPanels}</span>
              </div>
              {/* Always-on (battery + generator) */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Fuel className="w-3 h-3 text-orange-400" /> Always-On
                </span>
                <span className="text-orange-400 font-bold">{miner.generators}</span>
              </div>
              {/* Cooling fans */}
              <div className="flex justify-between items-center pb-2 border-b border-border">
                <span className="text-muted-foreground uppercase text-xs tracking-widest flex items-center gap-1">
                  <Snowflake className="w-3 h-3 text-cyan-400" /> Cooling Fans
                </span>
                <span className={fanCount === 0 ? "text-muted-foreground font-bold" : "text-cyan-400 font-bold"}>
                  {fanCount} {fanCount >= 4 ? "✓ optimal" : fanCount > 0 ? `(${4 - fanCount} more to zero out heat)` : "(add fans to reduce overheat)"}
                </span>
              </div>
              {/* Progress bar toward speed ceiling */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-[10px] text-muted-foreground uppercase tracking-widest">
                  <span>Compute Capacity</span>
                  <span>{displayLevel} / {MAX_LEVEL} TH</span>
                </div>
                <div className="w-full h-2 bg-black/60 border border-border rounded-full overflow-hidden">
                  <div className="h-full bg-primary transition-all duration-700" style={{ width: `${levelProgress}%` }} />
                </div>
              </div>
              {/* Upgrade guide */}
              {displayLevel >= MAX_LEVEL ? (
                <div className="border border-primary/30 rounded p-3 text-center">
                  <p className="text-primary text-xs uppercase tracking-widest font-bold">⚡ Max Capacity — 9 Rigs Active</p>
                </div>
              ) : (
                <div className="border border-primary/15 rounded p-3 space-y-2 bg-primary/5">
                  <p className="text-primary text-[10px] uppercase tracking-widest font-bold">Increase Earnings: Place More Rigs</p>
                  <div className="space-y-1 text-[10px] text-muted-foreground leading-relaxed">
                    <div className="flex justify-between"><span>⛏ Mining Rig block</span><span className="text-primary font-bold">+1 TH, needs 1 power</span></div>
                    <div className="flex justify-between"><span className="flex items-center gap-1"><Sun className="w-3 h-3 text-yellow-400" /> Solar Panel</span><span className="text-yellow-400 font-bold">+1 power unit</span></div>
                    <div className="flex justify-between"><span className="flex items-center gap-1"><Fuel className="w-3 h-3 text-orange-400" /> Generator</span><span className="text-orange-400 font-bold">+2 power units</span></div>
                    <div className="flex justify-between"><span>💨 Cooling Fan</span><span className="text-cyan-400 font-bold">−2.5°C/hr each</span></div>
                  </div>
                  <Link href="/game">
                    <Button size="sm" className="w-full mt-1 bg-primary/15 text-primary border border-primary/40 hover:bg-primary hover:text-black uppercase tracking-widest font-bold text-[10px]">
                      Build in Game World →
                    </Button>
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Sponsored Boosts / Ad Actions ─────────────────────────────── */}
          {/* All buttons open an Adsterra popup + 15-second anti-cheat overlay. */}
          <Card className="border-accent/30 bg-accent/5">
            <CardHeader>
              <CardTitle className="text-accent uppercase text-sm tracking-widest flex items-center">
                <Zap className="w-4 h-4 mr-2" /> Sponsored Boosts
              </CardTitle>
              <CardDescription className="text-muted-foreground text-xs uppercase tracking-widest">
                Watch a short ad to earn rewards
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">

              {/* ── Drill Boost Status ─────────────────────────────────────────
                  Shown when an Overcharge Drill boost is currently active.
                  Shows remaining boost time and daily usage counter.
              ── */}
              {(() => {
                const am = anyMiner;
                const isDrillBoosted  = am.isDrillBoosted  ?? false;
                const drillBoostUntil = am.drillBoostUntil ? new Date(am.drillBoostUntil as string) : null;
                const drillBoostToday = am.drillBoostToday ?? 0;
                const usesLeft        = Math.max(0, DRILL_BOOST_MAX - drillBoostToday);
                return (
                  <>
                    {isDrillBoosted && drillBoostUntil && (
                      <div className="border border-cyan-500/60 bg-cyan-500/10 rounded p-2 flex items-center gap-2">
                        <Zap className="w-4 h-4 text-cyan-400 shrink-0 animate-pulse" />
                        <div className="text-xs font-mono">
                          <p className="text-cyan-400 font-bold uppercase tracking-widest text-[10px]">
                            ⚡ Drill Overcharged — +50% Rate Active
                          </p>
                          <p className="text-muted-foreground text-[10px]">
                            Expires {drillBoostUntil.toLocaleTimeString()}
                          </p>
                        </div>
                      </div>
                    )}
                    <p className="text-muted-foreground text-[10px] text-center">
                      Overcharge uses today: <span className={usesLeft === 0 ? "text-destructive font-bold" : "text-primary font-bold"}>
                        {drillBoostToday}/{DRILL_BOOST_MAX}
                      </span>
                    </p>
                  </>
                );
              })()}

              {/* ── WATCH AD FOR GEMS ────────────────────────────────────────
                  Opens Adsterra popup + full 15s anti-cheat countdown → +50 💎
              ── */}
              <Button
                className="w-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/60 hover:bg-yellow-500 hover:text-black uppercase tracking-widest h-14 flex-col gap-1"
                onClick={() => startRewardedAd("gem_reward")}
                disabled={adOverlayActive || adRequesting}
              >
                <div className="flex items-center gap-2 text-sm font-black">
                  <Gem className="w-4 h-4" /> Watch Ad for Gems
                </div>
                <div className="text-[10px] opacity-70 font-normal normal-case tracking-normal">
                  15-second ad → +50 💎 Gems
                </div>
              </Button>

              {/* ── OVERCHARGE DRILL ─────────────────────────────────────────
                  Opens Adsterra popup + full 15s anti-cheat countdown.
                  Reward: +50% rate for 30 min, +5 💎. Limit: 3/day.
              ── */}
              <Button
                className="w-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/60 hover:bg-cyan-500 hover:text-black uppercase tracking-widest h-14 flex-col gap-1"
                onClick={() => startRewardedAd("drill_boost")}
                disabled={adOverlayActive || adRequesting || ((anyMiner.drillBoostToday ?? 0) >= DRILL_BOOST_MAX && (anyMiner.isDrillBoosted !== undefined))}
              >
                <div className="flex items-center gap-2 text-sm font-black">
                  <Zap className="w-4 h-4" /> Overcharge Drill
                </div>
                <div className="text-[10px] opacity-70 font-normal normal-case tracking-normal">
                  15s ad → +50% rate for 30 min (+5 💎) • verified
                </div>
              </Button>

              {/* ── FLUSH COOL DOWN ──────────────────────────────────────────
                  Opens Adsterra popup + 15s wait → resets miner temperature.
                  Popup-close guard is intentionally omitted (simpler flow).
              ── */}
              <Button
                className="w-full bg-blue-500/10 text-blue-400 border border-blue-500/60 hover:bg-blue-500 hover:text-black uppercase tracking-widest h-14 flex-col gap-1"
                onClick={() => startRewardedAd("cool_down")}
                disabled={adOverlayActive || adRequesting}
              >
                <div className="flex items-center gap-2 text-sm font-black">
                  <Snowflake className="w-4 h-4" /> Flush Cool Down
                </div>
                <div className="text-[10px] opacity-70 font-normal normal-case tracking-normal">
                  15s ad → Temperature reset to 0°C
                </div>
              </Button>

              {/* Anti-cheat note */}
              <p className="text-muted-foreground text-[10px] leading-relaxed text-center pt-1">
                Keep the ad window open and stay on this tab. Switching tabs pauses
                the timer; closing the ad early cancels the reward (Overcharge Drill only).
              </p>
            </CardContent>
          </Card>

        </div>
      </motion.div>
    </>
  );
}
