// ============================================================
// Wallet.tsx — Player earnings dashboard
//
// Shows:
//   • realBalance   — collected earnings saved to wallet (persistent)
//   • currentBalance — pending miner earnings not yet collected
//   • gem balance
//   • Collect button — moves currentBalance → realBalance
//
// The "real balance" is what persists in the database across
// sessions. It only grows when the player clicks Collect on this
// page or the Miner page.
// ============================================================

import { useState } from "react";
import { motion } from "framer-motion";
import { useGetWallet, useGetMiner, getGetWalletQueryKey, getGetMinerQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Wallet, Gem, DollarSign, Cpu, Download, Thermometer, Zap } from "lucide-react";
import { useBtcPrice, satoshiToUsd } from "@/hooks/use-btc-price";

export default function WalletPage() {
  const queryClient                  = useQueryClient();
  const { toast }                    = useToast();
  const [isCollecting, setCollecting] = useState(false);
  const btcPrice                     = useBtcPrice();

  const { data: wallet } = useGetWallet({
    query: { refetchInterval: 10000, queryKey: getGetWalletQueryKey() },
  });
  const { data: miner } = useGetMiner({
    query: {
      enabled:        !!localStorage.getItem("userId"),
      refetchInterval: 8000,
      queryKey:        getGetMinerQueryKey(),
    },
  });

  // ── Collect current miner balance into persistent wallet ───────────────
  const handleCollect = async () => {
    const userId = localStorage.getItem("userId");
    if (!userId) return;
    if (!miner || miner.currentBalance <= 0) {
      toast({ title: "NOTHING TO COLLECT", description: "Balance is zero.", variant: "destructive" });
      return;
    }

    setCollecting(true);
    try {
      const res  = await fetch("/api/miner/collect", {
        method:  "POST",
        headers: { "x-user-id": userId, "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        const collectedSat = data.collected ?? 0;
        const collectedDisplay = btcPrice
          ? satoshiToUsd(collectedSat, btcPrice)
          : `${collectedSat.toFixed(0)} sat`;
        toast({
          title:       "COLLECTED ✓",
          description: `${collectedDisplay} saved to your wallet.`,
          className:   "bg-black border-primary text-primary font-mono uppercase",
        });
        queryClient.invalidateQueries({ queryKey: getGetWalletQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMinerQueryKey() });
      } else {
        toast({ title: "COLLECT FAILED", description: data.error ?? "Unknown error.", variant: "destructive" });
      }
    } catch {
      toast({ title: "NETWORK ERROR", variant: "destructive" });
    } finally {
      setCollecting(false);
    }
  };

  const temp      = miner?.temperature ?? 0;
  const tempColor = temp < 60 ? "text-primary" : temp < 80 ? "text-yellow-400" : "text-red-400";
  const fuelPct   = Math.max(0, Math.min(100, ((miner?.fuel ?? 0) / 500) * 100));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 md:p-8 space-y-6 max-w-2xl mx-auto font-mono overflow-y-auto h-full"
    >
      {/* Page header */}
      <div>
        <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] flex items-center gap-3">
          <Wallet className="w-8 h-8" /> Vault
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">
          Earnings &amp; Balance Overview
        </p>
      </div>

      {/* ── Saved balance (real_balance) ────────────────────────────────── */}
      <Card className="border-primary/30 bg-primary/5 shadow-[0_0_30px_rgba(34,197,94,0.08)]">
        <CardContent className="p-6 space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground uppercase text-xs tracking-widest mb-2">
            <DollarSign className="w-4 h-4 text-primary" />
            Saved Balance
          </div>
          <div className="text-4xl font-black text-white tabular-nums tracking-tighter">
            {btcPrice
              ? satoshiToUsd(wallet?.realBalance ?? 0, btcPrice)
              : `${(wallet?.realBalance ?? 0).toFixed(0)} sat`}
          </div>
          {btcPrice && (
            <div className="text-muted-foreground text-[10px] tabular-nums">
              {(wallet?.realBalance ?? 0).toFixed(0)} sat · 1 BTC = ${btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Collected earnings — persistent across sessions.
          </p>
        </CardContent>
      </Card>

      {/* ── Pending miner balance ────────────────────────────────────────── */}
      <Card className="border-accent/30 bg-accent/5">
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center gap-2 text-muted-foreground uppercase text-xs tracking-widest">
            <Cpu className="w-4 h-4 text-accent" />
            Pending Miner Balance
          </div>

          <div className="text-3xl font-black text-accent tabular-nums tracking-tighter">
            {btcPrice
              ? satoshiToUsd(miner?.currentBalance ?? 0, btcPrice)
              : `${(miner?.currentBalance ?? 0).toFixed(0)} sat`}
          </div>
          {btcPrice && (
            <div className="text-muted-foreground text-[10px] tabular-nums">
              {(miner?.currentBalance ?? 0).toFixed(0)} sat
            </div>
          )}

          <p className="text-muted-foreground text-xs">
            Earned since last collect. Click Collect to save this permanently.
          </p>

          <Button
            onClick={handleCollect}
            disabled={isCollecting || !miner || miner.currentBalance <= 0}
            className="w-full bg-accent/20 border border-accent text-accent hover:bg-accent hover:text-black font-bold uppercase tracking-widest"
          >
            <Download className="w-4 h-4 mr-2" />
            {isCollecting ? "Collecting…" : "Collect into Wallet"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Gem balance ─────────────────────────────────────────────────── */}
      <Card className="border-border bg-sidebar/50">
        <CardContent className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Gem className="w-6 h-6 text-primary" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Gem Balance</div>
              <div className="text-2xl font-black text-primary">{wallet?.gems ?? 0} 💎</div>
            </div>
          </div>
          <p className="text-muted-foreground text-xs text-right max-w-[140px]">
            Spent in the Store and on world expansion.
          </p>
        </CardContent>
      </Card>

      {/* ── Miner status strip ──────────────────────────────────────────── */}
      {miner && miner.level > 0 && (
        <Card className="border-border bg-black/40">
          <CardContent className="p-4 space-y-3">
            <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1 flex items-center gap-2">
              <Zap className="w-3 h-3 text-accent" /> Miner Status
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="space-y-0.5">
                <div className="text-muted-foreground text-xs uppercase">Status</div>
                <div className={`font-bold ${miner.isRunning ? "text-primary" : "text-red-400"}`}>
                  {miner.isRunning ? "● Running" : "✕ Halted"}
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="text-muted-foreground text-xs uppercase">Rate</div>
                <div className="text-accent font-bold">
                  {btcPrice
                    ? satoshiToUsd(miner.ratePerSecond * 86400, btcPrice) + "/day"
                    : `${(miner.ratePerSecond * 86400).toFixed(4)} sat/day`}
                </div>
              </div>

              <div className="space-y-0.5">
                <div className="text-muted-foreground text-xs uppercase flex items-center gap-1">
                  <Thermometer className="w-3 h-3" /> Temp
                </div>
                <div className={`font-bold ${tempColor}`}>{temp.toFixed(0)}°C</div>
              </div>

              <div className="space-y-0.5">
                <div className="text-muted-foreground text-xs uppercase">Fuel</div>
                <div className={`font-bold ${fuelPct < 20 ? "text-red-400" : "text-yellow-400"}`}>
                  {fuelPct.toFixed(0)}%
                </div>
              </div>
            </div>

            {/* Fuel bar */}
            <div className="w-full h-2 bg-black/60 rounded-full border border-border overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${fuelPct}%`,
                  backgroundColor: fuelPct > 40 ? "#f59e0b" : fuelPct > 15 ? "#f97316" : "#ef4444",
                }}
              />
            </div>

            {/* Overheat warning */}
            {temp >= 80 && (
              <div className="text-xs text-red-400 border border-red-500/30 rounded p-2 bg-red-950/30">
                ⚠ Rig is overheating! Apply <b>Thermal Paste</b> or <b>Water Bucket</b> from your
                hotbar in-game (tap the Machine Core block) — or visit the Miner page.
                {temp >= 100 && " ❌ Mining has STOPPED until you cool it down."}
              </div>
            )}

            <p className="text-muted-foreground text-[10px]">
              Mining stops after ~12h without cooling. Apply maintenance to reset temperature.
            </p>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}
