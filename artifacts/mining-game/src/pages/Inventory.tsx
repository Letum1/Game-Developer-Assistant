// ============================================================
// Inventory.tsx — Displays the player's item list grouped by category.
// Items are shown in a responsive grid (2 cols on mobile, 4/6 on larger screens).
// ============================================================

import { useGetInventory } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wrench, Leaf, Cuboid, Flame, Droplet, Key, Package } from "lucide-react";

const getCategoryIcon = (cat: string) => {
  switch (cat?.toLowerCase()) {
    case "tools":   return <Wrench  className="w-5 h-5" />;
    case "seeds":   return <Leaf    className="w-5 h-5" />;
    case "blocks":  return <Cuboid  className="w-5 h-5" />;
    case "energy":  return <Flame   className="w-5 h-5" />;
    case "cooling": return <Droplet className="w-5 h-5" />;
    case "locks":   return <Key     className="w-5 h-5" />;
    default:        return <Package className="w-5 h-5" />;
  }
};

export default function Inventory() {
  const { data: inventory } = useGetInventory();

  if (!inventory) {
    return (
      <div className="p-8 text-primary font-mono text-center animate-pulse">
        Loading Inventory...
      </div>
    );
  }

  // Group items by category
  const grouped: Record<string, typeof inventory> = {};
  inventory.forEach((item) => {
    const cat = item.category || "Misc";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // h-full + overflow-y-auto = fills the Layout content pane and scrolls.
      // pb-4 ensures the last row isn't visually cut off on mobile.
      className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto font-mono overflow-y-auto h-full pb-4"
    >
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
          Cargo Hold
        </h1>
        <p className="text-muted-foreground text-xs sm:text-sm tracking-widest uppercase mt-1">
          Asset Storage &amp; Management
        </p>
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {Object.keys(grouped).length === 0 && (
        <div className="p-12 text-center text-muted-foreground border border-dashed border-border rounded uppercase tracking-widest text-xs">
          Cargo Hold Empty
        </div>
      )}

      {/* ── Category groups ─────────────────────────────────────────────── */}
      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="space-y-3">
          {/* Category header */}
          <h2 className="text-base sm:text-xl font-bold text-white uppercase tracking-widest border-b border-border pb-2 flex items-center gap-2">
            {getCategoryIcon(category)}
            <span>{category}</span>
          </h2>

          {/* Item grid — 2 cols mobile, 3 sm, 4 md, 6 lg */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {items.map((item) => (
              <Card
                key={item.itemId}
                className="bg-black/50 border-border hover:border-primary/50 transition-colors"
              >
                <CardContent className="p-3 flex flex-col items-center justify-center text-center space-y-1.5 h-full">
                  {/* Category icon as item graphic */}
                  <div className="w-10 h-10 rounded bg-sidebar flex items-center justify-center text-muted-foreground border border-border">
                    {getCategoryIcon(category)}
                  </div>
                  {/* Item name — truncated if too long */}
                  <div className="text-[10px] sm:text-xs font-bold text-white uppercase tracking-wider line-clamp-2 leading-tight">
                    {item.displayName || item.itemId}
                  </div>
                  {/* Quantity badge */}
                  <Badge variant="secondary" className="bg-primary/20 text-primary border-none text-[10px]">
                    QTY: {item.quantity}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </motion.div>
  );
}
