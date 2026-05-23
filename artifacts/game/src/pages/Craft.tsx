import { useCraftItem, useGetInventory } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Hammer, CheckCircle, XCircle, ChevronRight } from "lucide-react";
import { Link } from "wouter";

// ─── All craftable recipes shown in the Workbench UI ────────────────────────
const RECIPES = [
  // ── Pickaxes (Minecraft-style progression) ────────────────────────────────
  // Break oak trees → get oak_wood → craft stone pickaxe → mine iron faster, etc.
  {
    recipe: "pickaxe_stone",
    displayName: "Stone Pickaxe",
    description: "1.8× faster mining. Craft from oak wood — plant seeds, grow trees, cut logs.",
    ingredients: [
      { itemId: "oak_wood", quantity: 5, label: "Oak Wood" },
    ],
    emoji: "⛏️",
    category: "tools",
  },
  {
    recipe: "pickaxe_iron",
    displayName: "Iron Pickaxe",
    description: "2.8× faster mining. Mine iron and harder blocks much faster.",
    ingredients: [
      { itemId: "oak_wood",  quantity: 3, label: "Oak Wood" },
      { itemId: "raw_iron",  quantity: 3, label: "Raw Iron" },
    ],
    emoji: "⛏️",
    category: "tools",
  },
  {
    recipe: "pickaxe_gold",
    displayName: "Gold Pickaxe",
    description: "4.5× faster mining. Deep gold ore is worth the grind.",
    ingredients: [
      { itemId: "raw_iron", quantity: 5, label: "Raw Iron" },
      { itemId: "raw_gold", quantity: 2, label: "Raw Gold" },
    ],
    emoji: "⛏️",
    category: "tools",
  },
  {
    recipe: "pickaxe_diamond",
    displayName: "Diamond Pickaxe",
    description: "7× mining speed — the ultimate tool. Any block breaks in seconds.",
    ingredients: [
      { itemId: "raw_gold",    quantity: 3, label: "Raw Gold" },
      { itemId: "raw_diamond", quantity: 1, label: "Raw Diamond" },
    ],
    emoji: "💎",
    category: "tools",
    key: true,
  },
  // ── Data Center (passive income machine) ─────────────────────────────────
  {
    recipe: "data_center_rig",
    displayName: "Data Center Rig",
    description: "Unlocks your passive Data Center Miner — the engine of your earnings. Gives you a Machine Core to place.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5, label: "Raw Iron" },
      { itemId: "raw_gold",    quantity: 3, label: "Raw Gold" },
      { itemId: "raw_diamond", quantity: 1, label: "Raw Diamond" },
    ],
    key: true,
    emoji: "🖥️",
    category: "machines",
  },
  {
    recipe: "solar_panel_block",
    displayName: "Solar Panel Block",
    description: "Power source for your Machine Core. Each panel boosts mining rate.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2, label: "Raw Iron" },
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    emoji: "☀️",
    category: "machines",
  },
  {
    recipe: "data_cable",
    displayName: "Data Cable",
    description: "Connect Machine Cores to Solar Panels across gaps. Crafts 3 at a time.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1, label: "Raw Iron" },
    ],
    emoji: "🔌",
    category: "machines",
  },
  // ── Support items ─────────────────────────────────────────────────────────
  {
    recipe: "water_bucket",
    displayName: "Water Bucket",
    description: "Flush cooling water to reset your miner temperature gauge.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1, label: "Raw Iron" },
    ],
    emoji: "🪣",
    category: "cooling",
  },
  {
    recipe: "thermal_paste",
    displayName: "Thermal Paste",
    description: "Apply to reduce miner core temperature by 30°C.",
    ingredients: [
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    emoji: "🧪",
    category: "cooling",
  },
] as const;

type Recipe = (typeof RECIPES)[number];

// ─── Resources shown in the materials panel ───────────────────────────────────
const RESOURCES = [
  { itemId: "oak_wood",    label: "Oak Wood",  color: "text-amber-600" },
  { itemId: "raw_iron",    label: "Iron",      color: "text-gray-400"  },
  { itemId: "raw_gold",    label: "Gold",      color: "text-yellow-500"},
  { itemId: "raw_diamond", label: "Diamond",   color: "text-cyan-400"  },
  { itemId: "obsidian",    label: "Obsidian",  color: "text-purple-400"},
];

const CATEGORY_LABELS: Record<string, string> = {
  tools:    "⛏️ Pickaxes",
  machines: "🖥️ Data Rig",
  cooling:  "❄️ Cooling",
};

export default function Craft() {
  const { data: inventory = [], refetch } = useGetInventory();
  const craftItem = useCraftItem();
  const { toast } = useToast();

  const qty = (itemId: string) => inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;
  const canCraft = (r: Recipe) => r.ingredients.every((ing) => qty(ing.itemId) >= ing.quantity);

  const handleCraft = (r: Recipe) => {
    craftItem.mutate(
      { data: { recipe: r.recipe } },
      {
        onSuccess: (res) => {
          if (res.success) {
            toast({
              title: `✓ CRAFTED: ${r.displayName.toUpperCase()}`,
              description: res.message ?? undefined,
              className: "bg-black border-primary text-primary font-mono uppercase",
            });
            refetch();
          } else {
            toast({ title: "NOT ENOUGH MATERIALS", description: res.message ?? undefined, variant: "destructive" });
          }
        },
        onError: () => toast({ title: "CRAFT FAILED", variant: "destructive" }),
      }
    );
  };

  // Group recipes by category for display
  const categories = ["tools", "machines", "cooling"] as const;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto font-mono"
    >
      <div>
        <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] flex items-center">
          <Hammer className="mr-3 w-8 h-8" /> Workbench
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">
          Plant oak trees → get wood → craft pickaxes → mine faster → build Data Rig
        </p>
      </div>

      {/* ── Available Materials ──────────────────────────────────────────── */}
      <Card className="border-border bg-sidebar/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] text-muted-foreground uppercase tracking-widest">Your Materials</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {RESOURCES.map(({ itemId, label, color }) => (
              <div key={itemId} className="bg-black/60 border border-border rounded px-3 py-1.5 text-xs flex items-center gap-2">
                <span className="text-muted-foreground uppercase">{label}</span>
                <span className={`font-black tabular-nums ${qty(itemId) > 0 ? color : "text-muted-foreground/40"}`}>
                  {qty(itemId)}
                </span>
              </div>
            ))}
            {inventory.length === 0 && (
              <span className="text-muted-foreground text-xs italic">
                Plant oak seeds in the game world to grow trees and harvest wood.{" "}
                <Link href="/game"><a className="text-primary underline">Go to game →</a></Link>
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/60 mt-2 uppercase tracking-wider">
            💡 Start: plant seed → grow tree → break log → get oak_wood → craft Stone Pickaxe
          </p>
        </CardContent>
      </Card>

      {/* ── Recipe categories ────────────────────────────────────────────── */}
      {categories.map(cat => {
        const catRecipes = RECIPES.filter(r => r.category === cat);
        return (
          <div key={cat}>
            <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-2">
              <span>{CATEGORY_LABELS[cat]}</span>
              <span className="flex-1 border-t border-border/30 ml-2"/>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {catRecipes.map((r) => {
                const craftable = canCraft(r);
                return (
                  <Card
                    key={r.recipe}
                    className={`border transition-all ${
                      "key" in r && r.key
                        ? "border-primary/60 shadow-[0_0_20px_rgba(34,197,94,0.08)]"
                        : "border-border"
                    } bg-black/70`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <CardTitle className={`text-sm uppercase tracking-wider flex items-center gap-2 ${
                            "key" in r && r.key ? "text-primary" : "text-white"
                          }`}>
                            <span>{r.emoji}</span>
                            {r.displayName}
                            {"key" in r && r.key && (
                              <Badge className="bg-primary/20 text-primary border-primary text-[9px] px-1.5 py-0">KEY</Badge>
                            )}
                          </CardTitle>
                          <CardDescription className="text-[11px] text-muted-foreground mt-1">{r.description}</CardDescription>
                        </div>
                        {craftable
                          ? <CheckCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                          : <XCircle className="w-5 h-5 text-muted-foreground/40 shrink-0 mt-0.5" />
                        }
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="bg-black/40 rounded border border-border/50 p-2 space-y-1">
                        {r.ingredients.map((ing) => {
                          const have = qty(ing.itemId);
                          const ok = have >= ing.quantity;
                          return (
                            <div key={ing.itemId} className="flex justify-between items-center text-xs">
                              <span className="text-muted-foreground uppercase tracking-wide">{ing.label}</span>
                              <span className={`font-bold tabular-nums ${ok ? "text-primary" : "text-destructive"}`}>
                                {have} / {ing.quantity}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <Button
                        onClick={() => handleCraft(r)}
                        disabled={!craftable || craftItem.isPending}
                        className={`w-full uppercase tracking-widest font-bold text-xs h-9 ${
                          craftable
                            ? "bg-primary/10 border border-primary text-primary hover:bg-primary hover:text-black"
                            : "bg-transparent border border-border/40 text-muted-foreground/40 cursor-not-allowed"
                        }`}
                        variant="outline"
                      >
                        <Hammer className="w-3.5 h-3.5 mr-2" />
                        {craftItem.isPending ? "Crafting..." : "Craft"}
                        {craftable && <ChevronRight className="w-3.5 h-3.5 ml-auto" />}
                      </Button>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </div>
        );
      })}
    </motion.div>
  );
}
