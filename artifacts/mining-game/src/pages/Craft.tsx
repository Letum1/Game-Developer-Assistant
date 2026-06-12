// ============================================================
// Craft.tsx — Workbench page where players craft machine components
// and support items from raw resources mined in the game world.
//
// Machine building flow:
//   1. Mine iron/gold/diamond in the world
//   2. Craft Machine Core + power blocks (Solar Panel, Battery, Generator)
//   3. Go to game world, place them connected via Data Cables
//   4. Your Data Rig activates → passive income starts!
//
// Level formula (must match game.ts scanMachineCluster):
//   solar_panel_block  = +1 power unit (daytime only)
//   battery_block      = +1 power unit (always-on, charges from solar)
//   generator_block    = +2 power units (always-on, needs diesel fuel)
//   Level = total power units connected to Machine Core, cap = 9
// ============================================================

import { useCraftItem, useGetInventory, useGetMiner } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Hammer, CheckCircle, XCircle, ChevronRight, Cpu, Zap, Store } from "lucide-react";
import { Link } from "wouter";

// ─── Crafting recipes shown in the UI ────────────────────────────────────────
// IMPORTANT: Machine blocks (Mining Rig, Solar Panel, Generator, Battery, Fan,
// Data Cable) are now ONLY available from the rotating Black Market shop.
// This workbench handles only:
//   Group 1: One-time unlock (Data Center Rig certificate)
//   Group 2: Support / maintenance items (cooling, platforms)
const RECIPES = [
  // ── Step 0: Data Center Rig — one-time unlock certificate ────────────────
  // This is NOT a placeable block. Crafting it:
  //   1. Adds a "Data Center Rig" item to your inventory (proof of rig)
  //   2. Fires the server-side `unlocksMiner` flag → Miner page becomes active
  // You only need to craft this ONCE. Then buy machine blocks from the Shop.
  {
    recipe: "data_center_rig",
    displayName: "Data Center Rig",
    description: "Assemble your Data Center and unlock the passive Miner dashboard. Craft this ONCE — it stays in your inventory as your rig certificate.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 8, label: "Raw Iron"    },
      { itemId: "raw_gold",    quantity: 5, label: "Raw Gold"    },
      { itemId: "raw_diamond", quantity: 2, label: "Raw Diamond" },
    ],
    key: true,
    machine: true,
    unlock: true,   // special flag: one-time miner unlock item
    emoji: "🖥️",
    hint: "Craft ONCE to unlock the Miner page — then buy machine blocks from the Black Market Shop",
  },

  // ── Support / maintenance items ─────────────────────────────────────────
  // These are use-items (equip from hotbar, apply to rig) not placeable blocks.
  {
    recipe: "water_bucket",
    displayName: "Water Bucket",
    description: "Flush cooling water to reset your miner temperature gauge. Also available in the Shop.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1, label: "Raw Iron" },
    ],
    emoji: "🪣",
  },
  {
    recipe: "thermal_paste",
    displayName: "Thermal Paste",
    description: "Apply to reduce miner core temperature by 30°C. Also available in the Shop.",
    ingredients: [
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    emoji: "🧪",
  },
  // ── Platform Block — one-way jump-through platform ─────────────────────────
  // Cheap early-game utility block: crafted from oak wood (cut trees to get it).
  // Players land on top but jump straight through from below — like Terraria.
  {
    recipe: "platform_block",
    displayName: "Platform Block",
    description: "Jump-through platform. Land on top, jump through from below. Great for multi-level bases. Crafts 2.",
    ingredients: [
      { itemId: "oak_wood", quantity: 3, label: "Oak Wood" },
    ],
    emoji: "🪵",
    hint: "Cut oak trees to get oak_wood, then craft platforms for your base",
  },
] as const;

type Recipe = (typeof RECIPES)[number];

// ─── Raw resource display in the "Available Resources" panel ─────────────────
const RESOURCES = [
  { itemId: "raw_iron",    label: "Iron",    color: "text-gray-400"   },
  { itemId: "raw_gold",    label: "Gold",    color: "text-yellow-500" },
  { itemId: "raw_diamond", label: "Diamond", color: "text-cyan-400"   },
  { itemId: "obsidian",    label: "Obsidian",color: "text-purple-400" },
];

export default function Craft() {
  // Load player inventory to show "have/need" counts per ingredient
  const { data: inventory = [], refetch } = useGetInventory();
  const craftItem = useCraftItem();
  const { toast } = useToast();
  // Miner data — used to lock the data_center_rig recipe once already unlocked
  const { data: minerData } = useGetMiner({ query: { enabled: true } });

  // Helper: returns the player's current quantity of an item
  const qty = (itemId: string) => inventory.find((i) => i.itemId === itemId)?.quantity ?? 0;

  // Returns true if the player has all required ingredients for a recipe
  const canCraft = (r: Recipe) => r.ingredients.every((ing) => qty(ing.itemId) >= ing.quantity);

  // Send craft request to backend
  const handleCraft = (r: Recipe) => {
    craftItem.mutate(
      { data: { recipe: r.recipe } },
      {
        onSuccess: (res) => {
          if (res.success) {
            // Different toast copy depending on what was just crafted:
            // - rig unlock → celebrate that the miner is now active
            // - placeable machine block → remind player to go place it in the world
            // - support items → generic success
            const isUnlock   = "unlock" in r && r.unlock;
            const isMachine  = "machine" in r && r.machine && !isUnlock;
            const description = isUnlock
              ? "Your Data Center Rig is assembled! Head to the Miner page — passive income is now running."
              : isMachine
                ? "Go to the game world and place it! Add Solar Panels next to the Machine Core to power your rig."
                : (res.message ?? undefined);
            toast({
              title: `CRAFTED: ${r.displayName.toUpperCase()}`,
              description,
              className: "bg-black border-primary text-primary font-mono uppercase",
            });
            refetch();  // refresh inventory counts
          } else {
            toast({
              title: "NOT ENOUGH MATERIALS",
              description: res.message ?? undefined,
              variant: "destructive",
            });
          }
        },
        onError: () => toast({ title: "CRAFT FAILED", variant: "destructive" }),
      }
    );
  };

  // Separate machine components from support items for layout grouping
  const machineRecipes = RECIPES.filter((r) => "machine" in r && r.machine);
  const supportRecipes = RECIPES.filter((r) => !("machine" in r && r.machine));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto font-mono overflow-y-auto h-full"
    >
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] flex items-center">
          <Hammer className="mr-3 w-8 h-8" /> Workbench
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">
          Craft machine components from mined resources — then BUILD your rig in the game world
        </p>
      </div>

      {/* ── How to build your rig — instruction banner ───────────────────── */}
      <Card className="border-primary/40 bg-primary/5 shadow-[0_0_20px_rgba(34,197,94,0.05)]">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-start gap-3">
            <Cpu className="w-8 h-8 text-primary shrink-0 mt-0.5" />
            <div className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
              <p className="text-primary font-bold uppercase tracking-widest text-[10px] mb-2">How to Build Your Data Rig</p>
              {/* Step-by-step build guide — machine blocks now come from the rotating shop */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-black/40 rounded border border-primary/20 p-2 text-center space-y-1">
                  <div className="text-2xl">⛏️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 1: Mine</div>
                  <div className="text-[10px]">Break iron, gold, diamond blocks to gather raw resources and gems</div>
                </div>
                <div className="bg-black/40 rounded border border-primary/30 p-2 text-center space-y-1">
                  <div className="text-2xl">🖥️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 2: Unlock</div>
                  <div className="text-[10px]">Craft a <strong>Data Center Rig</strong> (one-time only) to unlock the Miner page</div>
                </div>
                <div className="bg-black/40 rounded border border-purple-500/30 p-2 text-center space-y-1">
                  <div className="text-2xl">🏪</div>
                  <div className="text-purple-300 font-bold text-[10px] uppercase">Step 3: Shop</div>
                  <div className="text-[10px]">Buy <strong>Machine Blocks</strong> from the Black Market — restocks every 10 min</div>
                </div>
                <div className="bg-black/40 rounded border border-primary/20 p-2 text-center space-y-1">
                  <div className="text-2xl">☀️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 4: Place</div>
                  <div className="text-[10px]">Place Machine Core in the world, connect power blocks via Data Cables!</div>
                </div>
              </div>
              {/* Power formula — must match game.ts scanMachineCluster and Miner.tsx MAX_LEVEL */}
              <p className="text-[10px] pt-1 text-primary/70">
                💡 <span className="text-yellow-400">Solar Panel = +1 level</span> &nbsp;|&nbsp;
                <span className="text-blue-400">Battery Block = +1 level</span> &nbsp;|&nbsp;
                <span className="text-orange-400">Generator Block = +2 levels</span>. Max level: 9. Use Data Cables to bridge gaps.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Machine blocks → Shop redirect banner ────────────────────────── */}
      {/* Machine blocks (Mining Rig, Solar Panel, Battery, Generator, Fan, Cable)
          are no longer craftable — they're exclusive to the rotating shop. */}
      <Card className="border-purple-500/40 bg-purple-950/10">
        <CardContent className="pt-4 pb-3">
          <div className="flex items-center gap-3">
            <Store className="w-6 h-6 text-purple-400 shrink-0" />
            <div>
              <p className="text-purple-300 font-bold uppercase tracking-widest text-[10px]">Machine Blocks → Black Market Shop</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Mining Rigs, Solar Panels, Generators, Batteries, Cooling Fans and Data Cables are now
                available exclusively in the rotating shop — restocking every 10 minutes with random quantities.
                Rare items like Mining Rigs appear infrequently, so check back often!
              </p>
            </div>
            <Link href="/store">
              <button className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-purple-300 border border-purple-500/50 rounded px-2 py-1 hover:bg-purple-500/10 transition-colors whitespace-nowrap">
                Go to Shop →
              </button>
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* ── Available resources panel ─────────────────────────────────────── */}
      <Card className="border-border bg-sidebar/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-[10px] text-muted-foreground uppercase tracking-widest">
            Available Resources
          </CardTitle>
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
                Mine blocks in the game world to gather resources.{" "}
                <Link href="/game" className="text-primary underline">Go mine →</Link>
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Machine Components section (primary — featured prominently) ───── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-4 h-4 text-primary" />
          <h2 className="text-xs uppercase tracking-widest text-primary font-bold">Machine Building Blocks</h2>
          <span className="text-[10px] text-muted-foreground">— Place these in the world to build your Data Rig</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {machineRecipes.map((r) => {
            const isOneTimeUnlock = "unlock" in r && r.unlock;
            // Data Center Rig is a one-time craft: once miner.unlocked = true, disable recrafting
            const alreadyUnlocked = isOneTimeUnlock && !!minerData?.unlocked;
            const craftable = canCraft(r) && !alreadyUnlocked;
            const inInventory = qty(r.recipe);
            return (
              <Card
                key={r.recipe}
                className={`border transition-all ${
                  alreadyUnlocked
                    ? "border-green-800/40 opacity-70"
                    : "key" in r && r.key
                      ? "border-primary/60 shadow-[0_0_20px_rgba(34,197,94,0.08)]"
                      : "border-primary/20"
                } bg-black/80`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-sm uppercase tracking-wider flex items-center gap-2 text-primary">
                        <span className="text-xl">{r.emoji}</span>
                        {r.displayName}
                      </CardTitle>
                      {/* Show quantity already in inventory */}
                      {inInventory > 0 && (
                        <Badge className="bg-primary/20 text-primary border-primary text-[9px] px-1.5 py-0 mt-1">
                          {inInventory} in inventory
                        </Badge>
                      )}
                    </div>
                    {craftable
                      ? <CheckCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                      : <XCircle className="w-5 h-5 text-muted-foreground/40 shrink-0 mt-0.5" />
                    }
                  </div>
                  <CardDescription className="text-[11px] text-muted-foreground mt-1">
                    {r.description}
                  </CardDescription>
                  {/* Placement hint */}
                  {"hint" in r && r.hint && (
                    <div className="text-[10px] text-primary/60 bg-primary/5 border border-primary/20 rounded px-2 py-1 mt-1">
                      💡 {r.hint}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Ingredient list with have/need counts */}
                  <div className="bg-black/40 rounded border border-border/50 p-2 space-y-1">
                    {r.ingredients.map((ing) => {
                      const have = qty(ing.itemId);
                      const ok   = have >= ing.quantity;
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
                  {/* One-time craft lock: show "Already Unlocked" badge for data_center_rig */}
                  {alreadyUnlocked ? (
                    <div className="w-full h-9 flex items-center justify-center rounded border border-green-700/50 bg-green-900/20 text-green-500 text-xs font-bold uppercase tracking-widest gap-2">
                      <CheckCircle className="w-3.5 h-3.5" />
                      Already Unlocked — Miner Active!
                    </div>
                  ) : (
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
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Support / Maintenance items section ──────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground font-bold">Support Items</h2>
          <span className="text-[10px] text-muted-foreground/60">— Cooling, energy, and miner maintenance</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {supportRecipes.map((r) => {
            const craftable = canCraft(r);
            return (
              <Card key={r.recipe} className="border border-border bg-black/70">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-sm uppercase tracking-wider flex items-center gap-2 text-white">
                        <span>{r.emoji}</span>
                        {r.displayName}
                      </CardTitle>
                      <CardDescription className="text-[11px] text-muted-foreground mt-1">
                        {r.description}
                      </CardDescription>
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
                      const ok   = have >= ing.quantity;
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
    </motion.div>
  );
}
