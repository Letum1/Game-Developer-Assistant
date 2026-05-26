import { useEffect, useState, useRef } from "react";
import { useGetMiner, useMinerTick, useMaintainMiner, useUpgradeMiner, useRequestMonetizationTask, useVerifyMonetizationTask } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Server, Activity, Thermometer, Cpu, Zap, Snowflake, ArrowUpCircle, Hammer, BatteryCharging, Download } from "lucide-react";
import { Link } from "wouter";

// ── Fuel constants (must stay in sync with server game-constants.ts) ──────────
// Total fuel capacity shared by all generators/batteries in the rig.
const MAX_FUEL        = 500;   // max fuel units
const FUEL_DRAIN_RATE = 0.05;  // units/sec per always-on source (generator or battery)

export default function Miner() {
  const { data: miner, refetch } = useGetMiner();
  const minerTick = useMinerTick();
  const maintainMiner = useMaintainMiner();
  const upgradeMiner = useUpgradeMiner();
  const requestMonetization = useRequestMonetizationTask();
  const verifyMonetization = useVerifyMonetizationTask();
  const { toast } = useToast();

  const [localBalance, setLocalBalance] = useState<number>(0);
  const [adTimer, setAdTimer] = useState<number | null>(null);
  const [adToken, setAdToken] = useState<string | null>(null);
  const [isCollecting, setIsCollecting] = useState(false);

  // Sync initial
  useEffect(() => {
    if (miner) setLocalBalance(miner.currentBalance);
  }, [miner]);

  // Local Ticker for visual effect
  useEffect(() => {
    if (!miner || !miner.isRunning) return;
    
    const interval = setInterval(() => {
      setLocalBalance(prev => prev + ((miner.ratePerSecond || 0) / 10)); // runs every 100ms
    }, 100);

    return () => clearInterval(interval);
  }, [miner]);

  // Server Tick every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      minerTick.mutate(undefined, {
        onSuccess: (data) => {
          setLocalBalance(data.currentBalance);
          refetch();
        }
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [minerTick, refetch]);

  // Ad Timer logic
  useEffect(() => {
    if (adTimer !== null && adTimer > 0) {
      const t = setTimeout(() => setAdTimer(adTimer - 1), 1000);
      return () => clearTimeout(t);
    } else if (adTimer === 0 && adToken) {
      // Verify
      verifyMonetization.mutate({ data: { token: adToken } }, {
        onSuccess: (res) => {
          if(res.success) {
             toast({ title: "BOOST APPLIED", description: res.reward, className: "bg-black border-primary text-primary font-mono uppercase" });
             refetch();
          }
        }
      });
      setAdTimer(null);
      setAdToken(null);
    }
    return undefined;
  }, [adTimer, adToken, verifyMonetization, refetch, toast]);

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
        toast({
          title: "BALANCE COLLECTED",
          description: `$${data.collected?.toFixed(8) ?? "0"} moved to your wallet.`,
          className: "bg-black border-primary text-primary font-mono uppercase",
        });
        setLocalBalance(0);  // reset local display
        refetch();
      } else {
        toast({ title: "NOTHING TO COLLECT", description: data.error ?? "Balance is zero.", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "COLLECT FAILED", description: "Network error.", variant: "destructive" });
    } finally {
      setIsCollecting(false);
    }
  };

  const handleMaintenance = (type: "flush_cooling" | "thermal_paste") => {
    maintainMiner.mutate({ data: { type } }, {
      onSuccess: () => {
        toast({ title: "MAINTENANCE COMPLETE", description: "Systems stabilized.", className: "bg-black border-accent text-accent font-mono uppercase" });
        refetch();
      },
      onError: (err: any) => {
        toast({ title: "MAINTENANCE FAILED", description: err?.data?.message || "Missing resources.", variant: "destructive" });
      }
    });
  };

  const handleMonetization = (type: "drill_boost" | "cool_down") => {
    requestMonetization.mutate({ data: { type } }, {
      onSuccess: (res) => {
        if(res.success) {
          window.open(res.adUrl || "https://example.com/ad", "_blank");
          setAdToken(res.token);
          setAdTimer(15);
        }
      }
    });
  };

  if (!miner) return <div className="p-8 text-center text-primary font-mono animate-pulse">Connecting to Data Center...</div>;

  if (!miner.unlocked) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full p-8 font-mono space-y-6 text-center">
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
            <div className="flex justify-between"><span className="text-gray-400">Raw Iron</span><span className="text-primary font-bold">×5</span></div>
            <div className="flex justify-between"><span className="text-yellow-500">Raw Gold</span><span className="text-primary font-bold">×3</span></div>
            <div className="flex justify-between"><span className="text-cyan-400">Raw Diamond</span><span className="text-primary font-bold">×1</span></div>
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

  const tempColor = miner.temperature < 60 ? "text-primary" : miner.temperature < 80 ? "text-yellow-500" : "text-destructive";
  const isOverheated = miner.temperature >= 100;

  // ── Fuel / battery calculations ──────────────────────────────────────────
  // `generators` column tracks total always-on source blocks (battery + generator).
  // `fuel` is the shared energy pool (0–MAX_FUEL) for those sources.
  const generators    = miner.generators ?? 0;
  const fuel          = miner.fuel ?? 0;
  const fuelPct       = Math.min(100, Math.round((fuel / MAX_FUEL) * 100));
  const drainPerSec   = generators * FUEL_DRAIN_RATE;
  // Time remaining = fuel units ÷ drain rate (seconds); 0 if no always-on source
  const fuelTimeSec   = drainPerSec > 0 ? fuel / drainPerSec : 0;
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

  // Rig needs at least one power source (solar panel in world OR generator from store)
  // to generate passive income. Without power it's always offline.
  const hasPower = (miner.solarPanels ?? 0) > 0 || (miner.generators ?? 0) > 0;

  // Status label shown in the badge
  const statusLabel = !hasPower ? "NO POWER" : isOverheated ? "OVERHEATED" : miner.isRunning ? "ONLINE" : "OFFLINE";
  const statusClass  = !hasPower
    ? "border-yellow-500 text-yellow-400"
    : miner.isRunning
    ? "border-primary text-primary"
    : "border-destructive text-destructive";

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto font-mono overflow-y-auto h-full">

      {/* ── No-power warning banner ────────────────────────────────────────── */}
      {!hasPower && (
        <div className="border border-yellow-500/60 bg-yellow-500/5 rounded-lg p-4 flex items-start gap-3">
          <Zap className="w-5 h-5 text-yellow-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-yellow-400 font-bold uppercase tracking-widest text-sm">No Power Source Detected</p>
            <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
              Your rig needs electricity before it can mine. Go to the <span className="text-primary font-bold">Game world</span> and
              place a <span className="text-yellow-400 font-bold">Solar Panel Block</span> in open sky, then connect it to your{" "}
              <span className="text-yellow-400 font-bold">Machine Core</span> with <span className="text-yellow-400 font-bold">Data Cables</span>.
              Alternatively buy a <span className="text-yellow-400 font-bold">Diesel Generator</span> from the Store.
            </p>
          </div>
        </div>
      )}

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
        
        {/* Balance Display */}
        <Card className="md:col-span-2 border-primary/30 bg-black/60 shadow-[0_0_30px_rgba(0,0,0,0.8)] relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(transparent_50%,rgba(0,0,0,1)_50%)] bg-[length:100%_4px]" />
          <CardHeader>
            <CardTitle className="text-muted-foreground uppercase text-xs tracking-widest flex items-center">
              <Activity className="w-4 h-4 mr-2" /> Live Yield
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-8 gap-4">
            <div className="text-5xl md:text-7xl font-black text-primary tracking-tighter drop-shadow-[0_0_15px_rgba(34,197,94,0.6)] font-mono tabular-nums">
              ${localBalance.toFixed(10)}
            </div>
            <div className="text-muted-foreground text-sm uppercase tracking-widest">
              Rate: {miner.ratePerSecond} sats/sec
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

        {/* Temperature Gauge */}
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
              <Button 
                variant="outline" 
                size="sm" 
                className="w-full border-accent text-accent hover:bg-accent hover:text-black uppercase tracking-widest text-xs"
                onClick={() => handleMaintenance("flush_cooling")}
                disabled={maintainMiner.isPending}
              >
                <Snowflake className="w-3 h-3 mr-2" /> Flush Cooling (1 Bucket)
              </Button>
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

      {/* ── Fuel / Battery Status Card (only shown when always-on blocks exist) */}
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
        {/* Stats & Upgrade */}
        <Card className="border-border bg-sidebar/50">
          <CardHeader>
            <CardTitle className="text-white uppercase text-sm tracking-widest">System Specifications</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center pb-2 border-b border-border">
              <span className="text-muted-foreground uppercase text-xs tracking-widest">Rig Level</span>
              <Badge variant="outline" className="border-primary text-primary font-bold">LVL {miner.level}</Badge>
            </div>
            <div className="flex justify-between items-center pb-2 border-b border-border">
              <span className="text-muted-foreground uppercase text-xs tracking-widest">Solar Arrays</span>
              <span className="text-white font-bold">{miner.solarPanels}</span>
            </div>
            <div className="flex justify-between items-center pb-2 border-b border-border">
              <span className="text-muted-foreground uppercase text-xs tracking-widest">Generators</span>
              <span className="text-white font-bold">{miner.generators}</span>
            </div>
            
            <Button 
              className="w-full bg-primary/20 text-primary border border-primary hover:bg-primary hover:text-black uppercase tracking-widest font-bold mt-4"
              onClick={() => upgradeMiner.mutate(undefined, { onSuccess: () => refetch() })}
              disabled={upgradeMiner.isPending}
            >
              <ArrowUpCircle className="w-4 h-4 mr-2" /> Upgrade Rig (Gems)
            </Button>
          </CardContent>
        </Card>

        {/* Monetization Actions */}
        <Card className="border-accent/30 bg-accent/5">
          <CardHeader>
            <CardTitle className="text-accent uppercase text-sm tracking-widest flex items-center">
              <Zap className="w-4 h-4 mr-2" /> External Overrides
            </CardTitle>
            <CardDescription className="text-muted-foreground text-xs uppercase tracking-widest">Execute sponsored tasks for system boosts</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {adTimer !== null ? (
               <div className="bg-black/50 p-6 rounded border border-accent/50 text-center space-y-4">
                 <div className="text-accent text-sm uppercase tracking-widest">Verifying Connection...</div>
                 <div className="text-4xl font-black text-white">{adTimer}s</div>
                 <Progress value={(15 - adTimer) / 15 * 100} className="h-1 bg-accent/20" />
               </div>
            ) : (
              <>
                <Button 
                  className="w-full bg-accent/10 text-accent border border-accent hover:bg-accent hover:text-black uppercase tracking-widest h-12"
                  onClick={() => handleMonetization("drill_boost")}
                  disabled={requestMonetization.isPending}
                >
                  <Zap className="w-4 h-4 mr-2" /> Overcharge Drill (15s Ad)
                </Button>
                <Button 
                  className="w-full bg-accent/10 text-accent border border-accent hover:bg-accent hover:text-black uppercase tracking-widest h-12"
                  onClick={() => handleMonetization("cool_down")}
                  disabled={requestMonetization.isPending}
                >
                  <Snowflake className="w-4 h-4 mr-2" /> Flash Cool Down (15s Ad)
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

    </motion.div>
  );
}
