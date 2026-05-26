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

import { useCraftItem, useGetInventory } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Hammer, CheckCircle, XCircle, ChevronRight, Cpu, Zap, Cable } from "lucide-react";
import { Link } from "wouter";

// ─── Crafting recipes shown in the UI ────────────────────────────────────────
// Group 1: Machine building blocks (the new Minecraft-redstone style system)
// Group 2: Support / maintenance items
const RECIPES = [
  // ── Step 0: Data Center Rig — one-time unlock certificate ────────────────
  // This is NOT a placeable block. Crafting it:
  //   1. Adds a "Data Center Rig" item to your inventory (proof of rig)
  //   2. Fires the server-side `unlocksMiner` flag → Miner page becomes active
  // You only need to craft this ONCE. Then craft Machine Core blocks separately.
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
    unlock: true,   // special flag: this is the one-time miner unlock item
    emoji: "🖥️",
    hint: "Craft ONCE to unlock the Miner page — then craft Machine Core blocks to place in the world",
  },

  // ── Machine building components ─────────────────────────────────────────
  {
    recipe: "machine_core",
    displayName: "Machine Core",
    description: "The CPU block of your Data Rig. Place it in the world, then put Solar Panels next to it to start passive earning.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5, label: "Raw Iron"    },
      { itemId: "raw_gold",    quantity: 2, label: "Raw Gold"    },
      { itemId: "raw_diamond", quantity: 1, label: "Raw Diamond" },
    ],
    key: true,          // key item — highlighted prominently
    machine: true,      // machine component flag for styling
    emoji: "⚙️",
    hint: "Placeable block — put in world → add Solar Panels to power it",
  },
  {
    recipe: "solar_panel_block",
    displayName: "Solar Panel Block",
    description: "Power source for your Machine Core. Each panel placed adjacent to the core increases your miner level and earning rate.",
    ingredients: [
      { itemId: "raw_iron", quantity: 2, label: "Raw Iron" },
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    key: true,
    machine: true,
    emoji: "☀️",
    hint: "Place touching Machine Core to boost rate",
  },
  {
    recipe: "data_cable",
    displayName: "Data Cable",
    description: "Extends your machine network — connect Machine Cores to Solar Panels across gaps. Crafts 3 at once.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1, label: "Raw Iron" },
    ],
    machine: true,
    emoji: "〜",
    hint: "Bridges components that aren't directly adjacent",
  },

  // ── Battery Block — stores solar energy so the rig runs 24/7 ────────────
  // +1 power unit, always-on. Charges from solar panels during the day.
  // Ingredients must match server CRAFTING_RECIPES["battery_block"].
  {
    recipe: "battery_block",
    displayName: "Battery Block",
    description: "Stores solar energy during the day and keeps the rig running at night. Connect via Data Cables to Machine Core.",
    ingredients: [
      { itemId: "raw_iron", quantity: 3, label: "Raw Iron" },
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    key: true,
    machine: true,
    emoji: "🔋",
    hint: "Always-on +1 power — charges from solar during day",
  },

  // ── Generator Block — diesel-powered, day-and-night power source ─────────
  // +2 power units, always-on. Requires diesel_can items to run.
  // Ingredients must match server CRAFTING_RECIPES["generator_block"].
  {
    recipe: "generator_block",
    displayName: "Generator Block",
    description: "Always-on diesel power — works day AND night. Connect to Machine Core via Data Cables. Buy Diesel Cans from Store to refuel.",
    ingredients: [
      { itemId: "raw_iron",    quantity: 5, label: "Raw Iron"    },
      { itemId: "raw_gold",    quantity: 2, label: "Raw Gold"    },
      { itemId: "raw_diamond", quantity: 1, label: "Raw Diamond" },
    ],
    key: true,
    machine: true,
    emoji: "⚡",
    hint: "Always-on +2 power — tap block in game to refuel with Diesel Can",
  },

  // ── Support / maintenance items ─────────────────────────────────────────
  // These are use-items (equip from hotbar, apply to rig) not placeable blocks.
  {
    recipe: "water_bucket",
    displayName: "Water Bucket",
    description: "Flush cooling water to reset your miner temperature gauge.",
    ingredients: [
      { itemId: "raw_iron", quantity: 1, label: "Raw Iron" },
    ],
    emoji: "🪣",
  },
  {
    recipe: "thermal_paste",
    displayName: "Thermal Paste",
    description: "Apply to reduce miner core temperature by 30°C.",
    ingredients: [
      { itemId: "raw_gold", quantity: 1, label: "Raw Gold" },
    ],
    emoji: "🧪",
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
              {/* Step-by-step build guide — 4 steps now that Rig and Machine Core are separate */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-black/40 rounded border border-primary/20 p-2 text-center space-y-1">
                  <div className="text-2xl">⛏️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 1: Mine</div>
                  <div className="text-[10px]">Break iron, gold, diamond blocks in the world to gather raw resources</div>
                </div>
                <div className="bg-black/40 rounded border border-primary/30 p-2 text-center space-y-1">
                  <div className="text-2xl">🖥️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 2: Unlock</div>
                  <div className="text-[10px]">Craft a <strong>Data Center Rig</strong> (one-time only) to unlock the Miner page</div>
                </div>
                <div className="bg-black/40 rounded border border-primary/20 p-2 text-center space-y-1">
                  <div className="text-2xl">⚙️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 3: Craft</div>
                  <div className="text-[10px]">Craft <strong>Machine Core</strong> + Solar Panel Blocks — these are the placeable parts</div>
                </div>
                <div className="bg-black/40 rounded border border-primary/20 p-2 text-center space-y-1">
                  <div className="text-2xl">☀️</div>
                  <div className="text-primary font-bold text-[10px] uppercase">Step 4: Place</div>
                  <div className="text-[10px]">Drop Machine Core in the world, place Solar Panels touching it to start earning!</div>
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
            const craftable = canCraft(r);
            const inInventory = qty(r.recipe);
            return (
              <Card
                key={r.recipe}
                className={`border transition-all ${
                  "key" in r && r.key
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
