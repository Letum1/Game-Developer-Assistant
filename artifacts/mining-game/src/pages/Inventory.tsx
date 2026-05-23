import { useGetInventory } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wrench, Leaf, Cuboid, Flame, Droplet, Key, Package } from "lucide-react";

const getCategoryIcon = (cat: string) => {
  switch (cat?.toLowerCase()) {
    case "tools": return <Wrench className="w-6 h-6" />;
    case "seeds": return <Leaf className="w-6 h-6" />;
    case "blocks": return <Cuboid className="w-6 h-6" />;
    case "energy": return <Flame className="w-6 h-6" />;
    case "cooling": return <Droplet className="w-6 h-6" />;
    case "locks": return <Key className="w-6 h-6" />;
    default: return <Package className="w-6 h-6" />;
  }
};

export default function Inventory() {
  const { data: inventory } = useGetInventory();

  if (!inventory) return <div className="p-8 text-primary font-mono text-center animate-pulse">Loading Inventory...</div>;

  // Group by category
  const grouped: Record<string, typeof inventory> = {};
  inventory.forEach(item => {
    const cat = item.category || "Misc";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(item);
  });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 space-y-8 max-w-6xl mx-auto font-mono">
      <div>
        <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
          Cargo Hold
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">Asset Storage & Management</p>
      </div>

      {Object.keys(grouped).length === 0 && (
         <div className="p-12 text-center text-muted-foreground border border-dashed border-border rounded uppercase tracking-widest">
           Cargo Hold Empty
         </div>
      )}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="space-y-4">
          <h2 className="text-xl font-bold text-white uppercase tracking-widest border-b border-border pb-2 flex items-center">
            {getCategoryIcon(category)} <span className="ml-2">{category}</span>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {items.map(item => (
              <Card key={item.itemId} className="bg-black/50 border-border hover:border-primary/50 transition-colors">
                <CardContent className="p-4 flex flex-col items-center justify-center text-center space-y-2 h-full">
                  <div className="w-12 h-12 rounded bg-sidebar flex items-center justify-center text-muted-foreground border border-border">
                    {getCategoryIcon(category)}
                  </div>
                  <div className="text-xs font-bold text-white uppercase tracking-wider line-clamp-1">{item.displayName || item.itemId}</div>
                  <Badge variant="secondary" className="bg-primary/20 text-primary border-none">
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
