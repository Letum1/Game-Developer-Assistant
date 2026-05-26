// ============================================================
// StoreWindow.tsx — compact floating store panel
//
// Shows available store items and lets players buy them with
// gems without leaving the game canvas. Uses a direct fetch
// to the store API (mirrors the full Store page logic).
// ============================================================

import { X, ShoppingCart, Gem } from "lucide-react";
import { useGetStore } from "@workspace/api-client-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

type StoreWindowProps = {
  gems:    number;
  onClose: () => void;
  onBuy:   () => void; // called after a successful purchase to trigger refetches
};

// Category display order
const CATEGORY_ORDER = ["cooling", "fuel", "lighting", "tools", "energy", "locks"];
const CATEGORY_LABEL: Record<string, string> = {
  cooling:  "🧊 Cooling",
  fuel:     "⛽ Fuel",
  lighting: "💡 Lights",
  tools:    "⛏ Tools",
  energy:   "☀ Energy",
  locks:    "🔒 Locks",
};

export default function StoreWindow({ gems, onClose, onBuy }: StoreWindowProps) {
  const { data: storeItems } = useGetStore();
  const { toast }            = useToast();
  const [buying, setBuying]  = useState<string | null>(null);

  // Group items by category
  const grouped: Record<string, typeof storeItems> = {};
  (storeItems ?? []).forEach((item) => {
    const cat = (item as { category?: string }).category ?? "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat]!.push(item);
  });

  const handleBuy = async (itemId: string, cost: number) => {
    if (gems < cost) {
      toast({ title: "NOT ENOUGH GEMS", description: `Need ${cost} 💎`, variant: "destructive" });
      return;
    }
    const userId = localStorage.getItem("userId");
    if (!userId) return;

    setBuying(itemId);
    try {
      const res  = await fetch("/api/store/buy", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body:    JSON.stringify({ itemId }),
      });
      const data = await res.json();
      if (data.success) {
        toast({
          title:       "PURCHASED",
          description: `${itemId} added to inventory.`,
          className:   "bg-black border-primary text-primary font-mono text-xs",
        });
        onBuy();
      } else {
        toast({ title: "BUY FAILED", description: data.error ?? "Unknown error.", variant: "destructive" });
      }
    } catch {
      toast({ title: "NETWORK ERROR", variant: "destructive" });
    } finally {
      setBuying(null);
    }
  };

  const orderedCats = [
    ...CATEGORY_ORDER.filter((c) => grouped[c]),
    ...Object.keys(grouped).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  return (
    <div className="w-64 bg-black/96 border border-border rounded-lg shadow-[0_0_20px_rgba(0,0,0,0.5)] font-mono text-xs pointer-events-auto select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-1.5">
          <ShoppingCart className="w-3 h-3 text-accent" />
          <span className="text-accent font-bold uppercase tracking-widest text-[10px]">Store</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-primary font-bold text-[10px]">{gems} 💎</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Item list — scrollable */}
      <div className="max-h-72 overflow-y-auto pb-2">
        {orderedCats.map((cat) => (
          <div key={cat}>
            {/* Category header */}
            <div className="px-3 pt-2 pb-1 text-[9px] text-muted-foreground uppercase tracking-widest border-b border-border/40">
              {CATEGORY_LABEL[cat] ?? cat}
            </div>

            {/* Items in this category */}
            {(grouped[cat] ?? []).map((item) => {
              const cost = (item as { gemCost?: number }).gemCost ?? 0;
              const canAfford = gems >= cost;
              const isBuying  = buying === item.itemId;

              return (
                <div
                  key={item.itemId}
                  className="flex items-center justify-between px-3 py-1.5 hover:bg-white/5 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-[10px] font-bold truncate">
                      {(item as { displayName?: string }).displayName ?? item.itemId}
                    </div>
                    <div className="text-muted-foreground text-[8px] truncate">
                      {(item as { description?: string }).description}
                    </div>
                  </div>

                  <button
                    onClick={() => handleBuy(item.itemId, cost)}
                    disabled={!canAfford || isBuying}
                    className={`ml-2 shrink-0 flex items-center gap-0.5 px-2 py-1 rounded border text-[9px] font-bold transition-all ${
                      canAfford
                        ? "border-primary/50 text-primary bg-primary/10 hover:bg-primary/20 cursor-pointer"
                        : "border-border/30 text-muted-foreground/40 cursor-not-allowed"
                    } ${isBuying ? "animate-pulse" : ""}`}
                  >
                    <Gem className="w-2.5 h-2.5" />
                    {cost}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
