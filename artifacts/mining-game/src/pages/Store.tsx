// ============================================================
// Store.tsx — Rotating Black Market shop
//
// Items restock every 10 minutes server-side. Rarity tiers:
//   ULTRA   → Mining Rig (~18% per cycle) — the FOMO anchor
//   RARE    → Power blocks (28–42%)
//   UNCOMMON → Cooling, locks, support (50–65%)
//   COMMON  → Cables, fuel, tools (80–100%)
//
// The client polls every 60 s and fires a toast + "NEW!" badge
// whenever a new restock is detected.
// ============================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { motion } from "framer-motion";
import { useGetWallet } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Gem, Clock, RefreshCw, Package, Zap, Star, ShieldAlert } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
type Rarity = "common" | "uncommon" | "rare" | "ultra";

interface StockItem {
  itemId:        string;
  displayName:   string;
  rarity:        Rarity;
  gemCost:       number;
  quantity:      number;
  restockNumber: number;
  description:   string;
  category:      string;
}

interface StoreData {
  items:             StockItem[];
  restockNumber:     number;
  nextRestockAt:     number;
  restockIntervalMs: number;
}

// ─── Rarity visual config ─────────────────────────────────────────────────────
const RARITY: Record<Rarity, {
  label:     string;
  badge:     string;  // badge pill classes
  card:      string;  // card border + bg
  titleColor: string;
  icon:      typeof Zap;
}> = {
  ultra:    { label: "ULTRA RARE", badge: "bg-purple-500/20 text-purple-300 border-purple-500/60", card: "border-purple-500/50 bg-purple-950/20 shadow-[0_0_12px_rgba(168,85,247,0.15)]", titleColor: "text-purple-300", icon: Zap    },
  rare:     { label: "RARE",       badge: "bg-orange-500/20 text-orange-300 border-orange-500/50",  card: "border-orange-500/40 bg-orange-950/10 shadow-[0_0_8px_rgba(249,115,22,0.10)]",  titleColor: "text-orange-300", icon: Star   },
  uncommon: { label: "UNCOMMON",   badge: "bg-blue-500/20   text-blue-300   border-blue-500/40",    card: "border-blue-500/30   bg-blue-950/10",                                             titleColor: "text-blue-200",   icon: ShieldAlert },
  common:   { label: "COMMON",     badge: "bg-green-500/10  text-green-400  border-green-500/30",   card: "border-border",                                                                   titleColor: "text-white",      icon: Package },
};

// ─── Countdown formatter MM:SS ────────────────────────────────────────────────
function fmtCountdown(ms: number): string {
  if (ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function Store() {
  const { data: wallet, refetch: refetchWallet } = useGetWallet();
  const { toast } = useToast();

  const [storeData, setStoreData]       = useState<StoreData | null>(null);
  const [loading, setLoading]           = useState(true);
  const [buying, setBuying]             = useState<string | null>(null);
  const [countdown, setCountdown]       = useState("--:--");
  // Set of itemIds that appeared in the most-recent restock (shows "NEW!" badge)
  const [newItems, setNewItems]         = useState<Set<string>>(new Set());
  const lastRestockNumRef               = useRef<number | null>(null);
  const countdownIntervalRef            = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Fetch stock from server ─────────────────────────────────────────────────
  const fetchStock = useCallback(async () => {
    try {
      const res  = await fetch("/api/store");
      const data = (await res.json()) as StoreData;

      // Detect new restock cycle
      if (
        lastRestockNumRef.current !== null &&
        data.restockNumber > lastRestockNumRef.current
      ) {
        // Flash "NEW!" badge on items that appeared in this restock
        const arrived = new Set(data.items.map((i) => i.itemId));
        setNewItems(arrived);
        setTimeout(() => setNewItems(new Set()), 6000);

        // Toast — highlight rare finds
        const hot = data.items.filter(
          (i) => i.rarity === "ultra" || i.rarity === "rare",
        );
        if (hot.length > 0) {
          toast({
            title: "⚡ RARE RESTOCK!",
            description: hot.map((i) => `${i.displayName} ×${i.quantity}`).join("  ·  "),
            className: "bg-purple-950 border-purple-400 text-purple-100 font-mono",
          });
        } else {
          toast({
            title: "🏪 Shop Restocked!",
            description: "New items now available in the Black Market.",
            className: "bg-black border-primary text-primary font-mono",
          });
        }
      }

      lastRestockNumRef.current = data.restockNumber;
      setStoreData(data);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [toast]);

  // ── Initial load + 60-second poll for restock detection ────────────────────
  useEffect(() => {
    fetchStock();
    const iv = setInterval(fetchStock, 60_000);
    return () => clearInterval(iv);
  }, [fetchStock]);

  // ── Countdown ticker (1-second update) ─────────────────────────────────────
  useEffect(() => {
    if (!storeData) return;
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    const tick = () => {
      const remaining = storeData.nextRestockAt - Date.now();
      setCountdown(remaining > 0 ? fmtCountdown(remaining) : "RESTOCKING…");
    };
    tick();
    countdownIntervalRef.current = setInterval(tick, 1000);
    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [storeData?.nextRestockAt]);

  // ── Buy handler ─────────────────────────────────────────────────────────────
  const handleBuy = async (item: StockItem) => {
    if ((wallet?.gems ?? 0) < item.gemCost) {
      toast({
        title:       "INSUFFICIENT GEMS",
        description: `You need ${item.gemCost} gems but only have ${wallet?.gems ?? 0}.`,
        variant:     "destructive",
      });
      return;
    }
    setBuying(item.itemId);
    try {
      const res = await fetch("/api/store/buy", {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id":    localStorage.getItem("userId") ?? "",
        },
        body: JSON.stringify({ itemId: item.itemId, quantity: 1 }),
      });
      const data = await res.json();
      if (data.success) {
        toast({
          title:       "ACQUIRED",
          description: data.message,
          className:   "bg-black border-primary text-primary font-mono uppercase",
        });
        refetchWallet();
        fetchStock(); // refresh quantities immediately
      } else {
        toast({ title: "FAILED", description: data.message ?? data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Network error", variant: "destructive" });
    }
    setBuying(null);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const rarityOrder: Rarity[] = ["ultra", "rare", "uncommon", "common"];
  const grouped = rarityOrder
    .map((r) => ({ rarity: r, items: storeData?.items.filter((i) => i.rarity === r) ?? [] }))
    .filter((g) => g.items.length > 0);

  if (loading) {
    return (
      <div className="p-8 text-primary font-mono text-center animate-pulse">
        Connecting to Black Market…
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 md:p-6 space-y-5 font-mono overflow-y-auto h-full"
    >
      {/* ── Header ── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
        <div>
          <h1 className="text-2xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
            Black Market
          </h1>
          <p className="text-muted-foreground text-[11px] tracking-widest uppercase mt-0.5">
            Rotating stock · rare items appear randomly · sell out fast
          </p>
        </div>

        {/* Countdown + gems + refresh */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 bg-black/60 border border-primary/20 rounded px-3 py-1.5">
            <Clock className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Restock in</span>
            <span className="text-primary font-black text-sm tabular-nums">{countdown}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/60 border border-primary/20 rounded px-3 py-1.5">
            <Gem className="w-3.5 h-3.5 text-primary shrink-0" />
            <span className="text-primary font-black text-sm">{wallet?.gems ?? 0}</span>
          </div>
          <button
            onClick={fetchStock}
            title="Refresh stock"
            className="text-muted-foreground hover:text-primary transition-colors p-1.5 rounded border border-border hover:border-primary/40"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Restock meta */}
      <div className="text-[10px] text-muted-foreground uppercase tracking-widest">
        Restock #{storeData?.restockNumber ?? 0} · {storeData?.items.length ?? 0} item types in stock
      </div>

      {/* ── Item groups by rarity ── */}
      {grouped.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground space-y-3">
          <Package className="w-14 h-14 mx-auto opacity-20" />
          <p className="uppercase tracking-widest text-sm">All sold out</p>
          <p className="text-[11px]">Check back at next restock — stock appears randomly</p>
        </div>
      ) : (
        grouped.map(({ rarity, items }) => {
          const cfg = RARITY[rarity];
          const Icon = cfg.icon;
          return (
            <div key={rarity} className="space-y-2">
              {/* Section divider */}
              <div className="flex items-center gap-2">
                <Icon className="w-3 h-3 opacity-60" />
                <span className={`text-[10px] font-black uppercase tracking-widest px-2 py-0.5 rounded border ${cfg.badge}`}>
                  {cfg.label}
                </span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Item cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {items.map((item) => {
                  const isNew    = newItems.has(item.itemId);
                  const canAfford = (wallet?.gems ?? 0) >= item.gemCost;
                  const lowStock  = item.quantity <= 2;
                  const midStock  = item.quantity <= 5;

                  return (
                    <motion.div
                      key={item.itemId}
                      initial={isNew ? { scale: 0.94, opacity: 0 } : false}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      className={`relative rounded-lg border p-3 flex flex-col gap-2 ${cfg.card}`}
                    >
                      {/* NEW! badge — visible for 6 s after a restock */}
                      {isNew && (
                        <span className="absolute -top-2.5 -right-2 bg-yellow-400 text-black text-[8px] font-black px-1.5 py-0.5 rounded-full uppercase tracking-wider animate-bounce z-10">
                          NEW!
                        </span>
                      )}

                      {/* Name + stock qty */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className={`font-black uppercase tracking-wide text-sm leading-tight truncate ${cfg.titleColor}`}>
                            {item.displayName}
                          </p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-widest mt-0.5">
                            {item.category}
                          </p>
                        </div>
                        {/* Quantity remaining — colour shifts as stock drops */}
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${
                          lowStock ? "border-red-500/60 text-red-400 bg-red-950/30 animate-pulse"
                          : midStock ? "border-orange-500/50 text-orange-400 bg-orange-950/20"
                          : "border-border text-muted-foreground"
                        }`}>
                          {item.quantity}× left
                        </span>
                      </div>

                      {/* Description */}
                      <p className="text-[11px] text-muted-foreground leading-relaxed flex-1">
                        {item.description}
                      </p>

                      {/* Buy button */}
                      <Button
                        size="sm"
                        className={`w-full font-bold uppercase tracking-widest text-xs h-8 ${
                          rarity === "ultra" && canAfford
                            ? "bg-purple-600 hover:bg-purple-500 border border-purple-400"
                            : rarity === "rare" && canAfford
                            ? "bg-orange-600 hover:bg-orange-500 border border-orange-400"
                            : ""
                        }`}
                        variant={canAfford ? "default" : "secondary"}
                        onClick={() => handleBuy(item)}
                        disabled={buying === item.itemId}
                      >
                        {buying === item.itemId ? (
                          "Processing…"
                        ) : canAfford ? (
                          <><Gem className="w-3 h-3 mr-1.5" />{item.gemCost.toLocaleString()} gems</>
                        ) : (
                          <>Need {item.gemCost.toLocaleString()} gems</>
                        )}
                      </Button>
                    </motion.div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}

      {/* Footer tip */}
      <p className="text-[10px] text-muted-foreground text-center uppercase tracking-widest pb-2">
        Stock resets every 10 min · Mining Rig appears ~1 in 5 restocks · Mine gems to buy more
      </p>
    </motion.div>
  );
}
