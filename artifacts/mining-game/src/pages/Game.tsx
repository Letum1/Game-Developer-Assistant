// ============================================================
// Game.tsx — Main 2D sandbox world with Growtopia/Terraria-style gameplay
//
// Features:
//  • Camera + zoom system (scroll wheel / pinch / buttons)
//  • Always-on-screen floating controls (Growtopia/Terraria style)
//  • 15-minute day/night cycle with sun, moon, stars
//  • Machine building: place machine_core + solar_panel_block to build a rig
//  • Gravity physics, AABB collision, crack animations, punch flash
//  • Multi-hit blocks, Wizard anti-cheat challenge
//  • Multiplayer chat over WebSocket
// ============================================================

import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetWorld, useGameAction, useGetWallet, useGetInventory, useGetMiner,
  useMaintainMiner,
  getGetWorldQueryKey, getGetWalletQueryKey, getGetInventoryQueryKey,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert, MessageSquare, SendHorizonal, ZoomIn, ZoomOut, Server, Package, ShoppingCart, Trophy } from "lucide-react";
import StructurePopup    from "@/components/game/StructurePopup";
import MinerWindow       from "@/components/game/MinerWindow";
import InventoryWindow   from "@/components/game/InventoryWindow";
import StoreWindow       from "@/components/game/StoreWindow";
import LeaderboardWindow from "@/components/game/LeaderboardWindow";

// ─── World / Canvas constants ────────────────────────────────────────────────
const BS   = 40;    // Block size in world pixels — each grid cell is 40×40
const WW   = 800;   // Logical canvas width  (20 blocks × 40px)
const WH   = 600;   // Logical canvas height (15 blocks × 40px)
const COLS = 20;    // World grid columns
const ROWS = 15;    // World grid rows

// ─── Physics constants ───────────────────────────────────────────────────────
const GRAVITY    = 900;   // Downward acceleration (px/s²)
const JUMP_VY    = -420;  // Initial jump velocity — negative = upward
const MOVE_SPEED = 175;   // Horizontal walk speed (px/s)
const PW         = 26;    // Player hitbox width  (px)
const PH         = 36;    // Player hitbox height (px)

// ─── Day/Night cycle ─────────────────────────────────────────────────────────
// 15 minutes = 900,000 ms. t=0 midnight → t=0.5 noon → t=1 midnight again.
const DAY_MS = 900_000;

// ─── Clock HUD helper ────────────────────────────────────────────────────────
// Maps the 15-minute real-world wall-clock cycle onto a 24-hour in-game day.
// Returns the current in-game time string, phase label, emoji, and a
// human-readable countdown to the next phase transition.
//
// Phase breakpoints (mirror getSky):
//   NIGHT  t ∈ [0.78, 1.0] ∪ [0.0, 0.22)   — dark sky, no solar
//   DAWN   t ∈ [0.22, 0.30)                  — sky lightening, sunrise
//   DAY    t ∈ [0.30, 0.68)                  — full sunlight, solar active
//   DUSK   t ∈ [0.68, 0.78)                  — sky darkening, sunset
function getClockState(now: number) {
  const t = (now % DAY_MS) / DAY_MS;

  // Map t → in-game 24h time (t=0 = 00:00 midnight, t=0.5 = 12:00 noon)
  const gameHours = t * 24;
  const h         = Math.floor(gameHours);
  const m         = Math.floor((gameHours - h) * 60);
  const timeStr   = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  // Determine current phase and when the next transition starts (in t units)
  let phase:      string;
  let phaseEmoji: string;
  let nextT:      number; // t value at which the NEXT phase begins
  if      (t < 0.22) { phase = "NIGHT"; phaseEmoji = "🌙"; nextT = 0.22; }
  else if (t < 0.30) { phase = "DAWN";  phaseEmoji = "🌅"; nextT = 0.30; }
  else if (t < 0.68) { phase = "DAY";   phaseEmoji = "☀";  nextT = 0.68; }
  else if (t < 0.78) { phase = "DUSK";  phaseEmoji = "🌇"; nextT = 0.78; }
  else               { phase = "NIGHT"; phaseEmoji = "🌙"; nextT = 1.22; } // dawn next cycle

  // Real seconds until the next phase transition
  const tUntil   = nextT > t ? nextT - t : nextT + 1 - t;
  const secsLeft = Math.round(tUntil * (DAY_MS / 1000));
  const mLeft    = Math.floor(secsLeft / 60);
  const sLeft    = secsLeft % 60;
  const countdown = mLeft > 0 ? `${mLeft}m ${sLeft}s` : `${sLeft}s`;

  return { timeStr, phase, phaseEmoji, countdown };
}

// ─── Mining hit counts per block type ────────────────────────────────────────
// Growtopia mechanic: click N times to break a block.
// Machine blocks take 1 hit so players can rearrange their rigs easily.
const BLOCK_HITS: Record<string, number> = {
  block_grass:       1,   // Surface — instant
  block_dirt:        2,   // Sub-surface — easy
  block_rock:        3,   // Stone — medium
  block_iron:        4,   // Iron ore — harder
  block_gold:        3,   // Gold ore — medium (valuable, slightly easier)
  block_diamond:     5,   // Diamond — hardest ore
  block_lava:        4,   // Lava — dangerous, hard
  // Oak tree blocks — break quickly (Growtopia-style fast wood harvesting)
  block_oak_log:     1,   // Trunk — one punch; drops oak_wood + maybe a seed
  block_oak_sapling: 1,   // Young tree — breaks in one punch
  block_oak_leaf:    1,   // Leaf cluster — one punch, no drops
  // Platform — crafted from oak wood; one-way collision (solid from above)
  platform_block:    2,   // Medium hardness; returns itself on break
  machine_core:      1,   // Machine component — 1-shot so you can rearrange
  mining_rig:        1,   // ASIC hardware — 1-shot so rig arrays are rearrangeable
  fan_block:         1,   // Cooling fan — 1-shot to reposition
  solar_panel_block: 1,   // Power source — 1-shot to rearrange
  data_cable:        1,   // Connector — 1-shot to rearrange
  lamp_block:        1,   // Lamp — 1-shot to reposition freely
  battery_block:     1,   // Energy storage — stores solar power for the night
  generator_block:   1,   // Diesel generator — needs fuel to run
};

// ─── Canvas fill colors per block type ───────────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass:       "#15803d",
  block_dirt:        "#78350f",
  block_rock:        "#374151",
  block_iron:        "#6b7280",
  block_gold:        "#b45309",
  block_diamond:     "#0e7490",
  block_lava:        "#b91c1c",
  // Oak tree
  block_oak_log:     "#92400e",   // dark brown trunk
  block_oak_sapling: "#166534",   // dark forest-green young sprout
  block_oak_leaf:    "#15803d",   // medium green leaf cluster (same as grass)
  // One-way platform
  platform_block:    "#5c3d1e",   // wooden plank brown
  machine_core:      "#0a1628",   // dark navy — circuit board feel
  mining_rig:        "#111822",   // very dark blue-gray — ASIC server chassis
  fan_block:         "#101820",   // very dark teal-black — fan housing
  solar_panel_block: "#0d2b2b",   // dark teal — solar panel base
  data_cable:        "#1a1a2e",   // very dark — cable conduit
  lamp_block:        "#1c1608",   // very dark brown — metal lantern casing
  battery_block:     "#0f1a10",   // very dark green — energy cell housing
  generator_block:   "#1a1210",   // very dark brown/gray — diesel engine casing
  // Clock block was missing from this map — that's why it rendered as invisible.
  // A dark charcoal colour is used so the pixel-art clock face (drawn on top) pops.
  clock_block:       "#1a1520",   // dark charcoal with slight purple tint — timepiece housing
};

// ─── Top-edge highlight tints (makes blocks look 3D) ────────────────────────
const BLOCK_TINTS: Record<string, string> = {
  block_grass:       "rgba(74,222,128,0.25)",
  block_dirt:        "rgba(180,130,80,0.20)",
  block_rock:        "rgba(200,200,220,0.12)",
  block_iron:        "rgba(210,220,230,0.20)",
  block_gold:        "rgba(255,220,50,0.35)",
  block_diamond:     "rgba(100,240,255,0.30)",
  block_lava:        "rgba(255,120,0,0.40)",
  // Oak tree
  block_oak_log:     "rgba(180,120,50,0.25)",   // warm wood highlight
  block_oak_sapling: "rgba(100,220,100,0.45)",   // bright green sprout
  block_oak_leaf:    "rgba(74,222,128,0.35)",    // leafy green shimmer
  // One-way platform — warm plank feel
  platform_block:    "rgba(200,150,80,0.35)",
  machine_core:      "rgba(34,197,94,0.15)",   // faint green circuit glow
  mining_rig:        "rgba(34,197,94,0.20)",   // green LED array — active compute
  fan_block:         "rgba(0,180,255,0.25)",   // cyan — spinning blades
  solar_panel_block: "rgba(255,220,50,0.20)",  // gold tint — solar cells
  data_cable:        "rgba(34,197,94,0.10)",   // faint green data line
  lamp_block:        "rgba(255,220,80,0.60)",  // warm amber — illuminated glass
  battery_block:     "rgba(34,220,120,0.25)",  // bright green — energy glow
  generator_block:   "rgba(255,100,30,0.20)",  // warm orange — exhaust heat
  clock_block:       "rgba(180,180,220,0.20)", // silvery-blue — clock glass face
};

// ─── Hotbar label names ───────────────────────────────────────────────────────
const BLOCK_LABELS: Record<string, string> = {
  block_grass:       "Grass",
  block_dirt:        "Dirt",
  block_rock:        "Rock",
  // Oak tree blocks
  block_oak_log:     "Oak Log",
  block_oak_sapling: "Sapling",
  block_oak_leaf:    "Leaves",
  // One-way platform
  platform_block:    "Platform",
  seed_oak:          "Oak Seed",   // shown in hotbar when seed selected for planting
  machine_core:      "M.Core",
  mining_rig:        "Rig",        // ASIC mining hardware — each block = 1 TH
  fan_block:         "Fan",        // cooling fan — cuts temperature rise
  solar_panel_block: "SolarPnl",
  data_cable:        "Pipe",
  lamp_block:        "Lamp",       // underground light source
  battery_block:     "Battery",    // energy storage — keeps rig alive at night
  generator_block:   "Generator",  // diesel power source — needs fuel
  // ── Use items (equip from USE hotbar section, tap a structure to apply) ──
  diesel_can:        "Diesel",     // equip + tap generator or battery to refuel
  thermal_paste:     "Paste",      // equip + tap machine_core to reduce temperature
  water_bucket:      "H₂O",        // equip + tap machine_core for cooling flush
  // ── Clock Block (placeable machine block — shows in-game time when powered) ─
  clock_block:       "Clock",      // analog clock face — hands move based on DAY_MS cycle
};

// ─── Block fill colors for hotbar swatches ────────────────────────────────────
// water_bucket gets a blue swatch; actual placement is handled specially.

// ─── Which inventory items can be placed as world blocks ─────────────────────
// Includes terrain blocks (collected by mining) AND machine components (crafted).
// Use-items (thermal_paste, water_bucket, diesel_can) are handled separately —
// they are NOT placed as blocks. Select them from the USE hotbar section instead.
const PLACEABLE = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
  // Oak tree — seed_oak uses "plant" action (not regular place) but is still in
  // PLACEABLE so it shows up in the hotbar. Plant action is intercepted in handleCanvasClick.
  "seed_oak",
  // Platform blocks — one-way collision, crafted from oak wood
  "platform_block",
  "block_oak_leaf",
  "machine_core",
  "mining_rig",      // ASIC hardware — each block placed = 1 TH of compute
  "fan_block",       // cooling fan — place in cluster to reduce temp rise
  "solar_panel_block",
  "data_cable",
  "lamp_block",      // powered lamp — connect to solar network for light
  "battery_block",   // stores solar energy; keeps the rig running at night
  "generator_block", // diesel generator — needs diesel_can to run
  "clock_block",     // analog clock — place + connect to power to show in-game time
]);

// ─── Machine block types set (for special rendering / detection) ─────────────
// All blocks in this set:
//  • Get the machine "never fully dark" treatment in the shadow overlay
//  • Participate in BFS power routing
//  • lamp_block lights up when powered; battery/generator are always-on sources
//  • Clicking one in punch mode (with no use item) shows the StructurePopup
const MACHINE_BLOCKS = new Set([
  "machine_core",
  "mining_rig",      // ASIC compute block — counted by scanMachineCluster
  "fan_block",       // cooling fan — counted by scanMachineCluster
  "solar_panel_block",
  "data_cable",
  "lamp_block",
  "battery_block",   // energy storage — charges by day, powers rig at night
  "generator_block", // diesel generator — needs fuel to provide power
  "clock_block",     // in-game clock — participates in BFS power routing; glows when live
]);

// ─── Use-item set (equip from the USE section of the hotbar) ─────────────────
// These items are NOT placed as world blocks. Selecting one switches the cursor
// to "apply" mode. Clicking a compatible machine block consumes 1 item and
// applies the effect:
//   thermal_paste → machine_core        : resets temperature
//   water_bucket  → machine_core        : flush-cooling (bigger temp drop)
//   diesel_can    → generator_block / battery_block : +100 fuel
const USE_ITEMS = new Set(["thermal_paste", "water_bucket", "diesel_can"]);

// ─── Max punch reach in block-units ─────────────────────────────────────────
const REACH = 3.5;

// ─── Zoom limits ─────────────────────────────────────────────────────────────
const ZOOM_MIN  = 0.75;  // zoomed out — see more of the world
const ZOOM_MAX  = 3.0;   // zoomed in  — pixel-level detail
const ZOOM_STEP = 0.15;  // each zoom button press changes by this much

// ─── Day/Night sky color computation ─────────────────────────────────────────
// Returns sky gradient data and star/overlay info based on wall-clock time.
// Uses Date.now() so all players share the same day/night cycle in real time.
// t=0.0 midnight → t=0.25 sunrise → t=0.5 noon → t=0.75 sunset → t=1.0 midnight
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };
function getSky(now: number): SkyState {
  // Use real wall-clock time so every player sees the same sky simultaneously
  const t = (now % DAY_MS) / DAY_MS;

  if (t < 0.08) {
    // Full night — deep navy, stars visible
    return { r: 8, g: 10, b: 28, alpha: 0.78, stars: true };
  } else if (t < 0.20) {
    // Pre-dawn → dawn: indigo slowly warming to orange-peach horizon
    const f = (t - 0.08) / 0.12;
    return {
      r: Math.round(8  + 220 * f),
      g: Math.round(10 + 100 * f),
      b: Math.round(28 -  10 * f),
      alpha: 0.78 - 0.72 * f,
      stars: f < 0.45,
    };
  } else if (t < 0.30) {
    // Dawn → full day: sunrise orange fades to clear sky blue
    const f = (t - 0.20) / 0.10;
    return {
      r: Math.round(228 - 93  * f),  // 228 → 135 (sky blue)
      g: Math.round(110 + 96  * f),  // 110 → 206
      b: Math.round(18  + 217 * f),  // 18  → 235
      alpha: 0.06 - 0.06 * f,
      stars: false,
    };
  } else if (t < 0.68) {
    // Full daytime — clear bright sky blue, zero dark overlay
    return { r: 135, g: 206, b: 235, alpha: 0, stars: false };
  } else if (t < 0.78) {
    // Dusk — sky warms from blue to golden-orange
    const f = (t - 0.68) / 0.10;
    return {
      r: Math.round(135 + 120 * f),  // 135 → 255
      g: Math.round(206 - 100 * f),  // 206 → 106
      b: Math.round(235 - 205 * f),  // 235 → 30
      alpha: 0.06 * f,
      stars: false,
    };
  } else if (t < 0.88) {
    // Sunset → full night — darkening overlay, stars emerge
    const f = (t - 0.78) / 0.10;
    return {
      r: Math.round(255 - 247 * f),
      g: Math.round(106 -  96 * f),
      b: Math.round(30  -   2 * f),
      alpha: 0.06 + 0.72 * f,
      stars: f > 0.5,
    };
  }
  // Back to full night
  return { r: 8, g: 10, b: 28, alpha: 0.78, stars: true };
}

// ─── Crack overlay renderer ──────────────────────────────────────────────────
// Draws progressive crack lines over a block as it takes hits.
// progress: 0.0 (fresh) → 1.0 (about to break). 4 stages of cracks.
function drawCracks(ctx: CanvasRenderingContext2D, bx: number, by: number, progress: number) {
  if (progress < 0.2) return;  // no visible cracks below 20% damage
  const x = bx * BS;
  const y = by * BS;
  const stage = Math.min(4, Math.floor(progress * 5));  // stages 1-4

  // Darken block proportionally to damage received
  ctx.fillStyle = `rgba(0,0,0,${progress * 0.55})`;
  ctx.fillRect(x + 1, y + 1, BS - 2, BS - 2);

  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur  = 2;

  // Stage 1: top-left hairline crack
  if (stage >= 1) {
    ctx.beginPath();
    ctx.moveTo(x + 8,  y + 6);
    ctx.lineTo(x + 18, y + 16);
    ctx.lineTo(x + 14, y + 22);
    ctx.stroke();
  }
  // Stage 2: right-side crack
  if (stage >= 2) {
    ctx.beginPath();
    ctx.moveTo(x + 30, y + 8);
    ctx.lineTo(x + 22, y + 20);
    ctx.lineTo(x + 28, y + 30);
    ctx.stroke();
  }
  // Stage 3: mid crack + corner chips — block is badly damaged
  if (stage >= 3) {
    ctx.beginPath();
    ctx.moveTo(x + 4,  y + 28);
    ctx.lineTo(x + 16, y + 22);
    ctx.lineTo(x + 26, y + 34);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x + 2, y + 2, 5, 5);
    ctx.fillRect(x + 33, y + 30, 5, 5);
  }
  // Stage 4: severe — horizontal + vertical fault lines, all corners chipped
  if (stage >= 4) {
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 2,  y + 20);
    ctx.lineTo(x + 38, y + 18);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 20, y + 2);
    ctx.lineTo(x + 18, y + 38);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x + 1,  y + 1,  4, 4);
    ctx.fillRect(x + 35, y + 1,  4, 4);
    ctx.fillRect(x + 1,  y + 35, 4, 4);
    ctx.fillRect(x + 35, y + 35, 4, 4);
  }
  ctx.restore();
}

// ─── Punch flash renderer ────────────────────────────────────────────────────
// Brief white/yellow flash over a block the instant it is hit.
function drawPunchFlash(ctx: CanvasRenderingContext2D, bx: number, by: number, alpha: number) {
  ctx.fillStyle = `rgba(255,255,200,${alpha * 0.5})`;
  ctx.fillRect(bx * BS + 2, by * BS + 2, BS - 4, BS - 4);
}

// ─── Machine Core block renderer ─────────────────────────────────────────────
// Draws circuit-board pattern with a neon glow when the rig is active (powered).
function drawMachineCore(ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number) {
  const x = bx * BS;
  const y = by * BS;

  // Base fill — dark navy
  ctx.fillStyle = "#0a1628";
  ctx.fillRect(x, y, BS, BS);

  // Pulsing glow when active (based on sin wave for smooth breathing effect)
  const pulse = active ? 0.5 + 0.5 * Math.sin(time / 400) : 0;
  if (active) {
    ctx.shadowColor = "#22c55e";
    ctx.shadowBlur  = 8 + pulse * 12;
  }

  // Circuit trace lines (horizontal + vertical grid pattern)
  ctx.strokeStyle = active ? `rgba(34,197,94,${0.5 + pulse * 0.5})` : "rgba(34,197,94,0.15)";
  ctx.lineWidth   = 1;

  // Horizontal traces
  ctx.beginPath();
  ctx.moveTo(x + 4,  y + 10); ctx.lineTo(x + 36, y + 10);
  ctx.moveTo(x + 4,  y + 20); ctx.lineTo(x + 22, y + 20);
  ctx.moveTo(x + 4,  y + 30); ctx.lineTo(x + 36, y + 30);
  ctx.stroke();

  // Vertical traces
  ctx.beginPath();
  ctx.moveTo(x + 12, y + 4);  ctx.lineTo(x + 12, y + 36);
  ctx.moveTo(x + 28, y + 4);  ctx.lineTo(x + 28, y + 36);
  ctx.stroke();

  // CPU chip rectangle in the center
  ctx.strokeStyle = active ? `rgba(34,197,94,${0.8 + pulse * 0.2})` : "rgba(34,197,94,0.3)";
  ctx.lineWidth   = 2;
  ctx.strokeRect(x + 14, y + 14, 12, 12);

  // Center LED dot — solid green when active
  ctx.fillStyle = active ? `rgba(34,197,94,${0.8 + pulse * 0.2})` : "rgba(34,197,94,0.2)";
  ctx.beginPath();
  ctx.arc(x + 20, y + 20, 3, 0, Math.PI * 2);
  ctx.fill();

  // Border
  ctx.shadowBlur  = 0;
  ctx.strokeStyle = active ? "rgba(34,197,94,0.6)" : "rgba(34,197,94,0.2)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Solar Panel block renderer ───────────────────────────────────────────────
// Draws a grid of photovoltaic cells with golden glow.
function drawSolarPanel(ctx: CanvasRenderingContext2D, bx: number, by: number, powered: boolean, time: number) {
  const x = bx * BS;
  const y = by * BS;

  // Dark teal base
  ctx.fillStyle = "#0d2b2b";
  ctx.fillRect(x, y, BS, BS);

  // 2×2 grid of solar cells
  const cellSize = 14;
  const gap = 3;
  const offX = (BS - (2 * cellSize + gap)) / 2;
  const offY = (BS - (2 * cellSize + gap)) / 2;

  const pulse = powered ? 0.4 + 0.6 * Math.sin(time / 600) : 0;

  for (let cy = 0; cy < 2; cy++) {
    for (let cx2 = 0; cx2 < 2; cx2++) {
      const cellX = x + offX + cx2 * (cellSize + gap);
      const cellY = y + offY + cy * (cellSize + gap);

      // Cell background — dark blue tint
      ctx.fillStyle = "#0a1f3a";
      ctx.fillRect(cellX, cellY, cellSize, cellSize);

      // Cell glow lines — golden if powered
      ctx.strokeStyle = powered
        ? `rgba(253,224,71,${0.6 + pulse * 0.4})`
        : "rgba(253,224,71,0.15)";
      ctx.lineWidth = 1;
      // Diagonal cross inside each cell (solar panel aesthetic)
      ctx.beginPath();
      ctx.moveTo(cellX,            cellY + cellSize / 2);
      ctx.lineTo(cellX + cellSize, cellY + cellSize / 2);
      ctx.moveTo(cellX + cellSize / 2, cellY);
      ctx.lineTo(cellX + cellSize / 2, cellY + cellSize);
      ctx.stroke();

      // Cell border
      ctx.strokeStyle = powered
        ? `rgba(253,224,71,${0.4 + pulse * 0.3})`
        : "rgba(253,224,71,0.1)";
      ctx.strokeRect(cellX, cellY, cellSize, cellSize);
    }
  }

  if (powered) {
    // Yellow glow around the whole block when powered
    ctx.shadowColor = "#fde047";
    ctx.shadowBlur  = 6 + pulse * 8;
  }

  // Block border
  ctx.strokeStyle = powered ? "rgba(253,224,71,0.5)" : "rgba(253,224,71,0.15)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
  ctx.shadowBlur  = 0;
}

// ─── Lamp Block renderer ──────────────────────────────────────────────────────
// Draws a metal lantern casing with a glowing amber bulb inside.
// When powered (connected via cable to an active solar panel):
//   • Bulb is bright amber-yellow with a radiant inner glow
//   • Block-level shadow treatment is relaxed (handled in drawFrame halo pass)
// When unpowered:
//   • Bulb is dim gray — looks like a dead light
function drawLampBlock(ctx: CanvasRenderingContext2D, bx: number, by: number, powered: boolean, time: number) {
  const x  = bx * BS;
  const y  = by * BS;

  // ── Metal casing — dark iron body ────────────────────────────────────────
  ctx.fillStyle = "#1c1608";
  ctx.fillRect(x, y, BS, BS);

  // Iron frame bars (cross pattern — decorative lantern grill)
  ctx.fillStyle = "#302010";
  ctx.fillRect(x + 2,      y + 2,  BS - 4, 4);   // top bar
  ctx.fillRect(x + 2,      y + BS - 6, BS - 4, 4); // bottom bar
  ctx.fillRect(x + 2,      y + 2,  4, BS - 4);   // left bar
  ctx.fillRect(x + BS - 6, y + 2,  4, BS - 4);   // right bar

  // ── Glass bulb area — central rounded square ──────────────────────────────
  const pulse  = powered ? 0.6 + 0.4 * Math.sin(time / 300) : 0;
  const bulbX  = x + 8;
  const bulbY  = y + 8;
  const bulbW  = BS - 16;
  const bulbH  = BS - 16;

  if (powered) {
    // Lit: warm amber inner glow, soft center (toned down from previous over-bright version)
    ctx.fillStyle = `rgba(255,170,15,${0.55 + pulse * 0.2})`;
    ctx.fillRect(bulbX, bulbY, bulbW, bulbH);

    // Soft hotspot in the very center — not blinding white
    ctx.fillStyle = `rgba(255,230,140,${0.65 + pulse * 0.15})`;
    ctx.fillRect(bulbX + 4, bulbY + 4, bulbW - 8, bulbH - 8);

    // Subtle glow on the block itself — reduced shadowBlur so it doesn't bleed too far
    ctx.shadowColor = "#fbbf24";
    ctx.shadowBlur  = 3 + pulse * 4;

    // Small diagonal light-ray marks in the bulb corners — simple visual, no symbol
    ctx.save();
    ctx.strokeStyle = `rgba(255,210,80,${0.4 + pulse * 0.3})`;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    // Top-left to bottom-right ray
    ctx.moveTo(bulbX + 3,         bulbY + 3);
    ctx.lineTo(bulbX + bulbW - 3, bulbY + bulbH - 3);
    // Top-right to bottom-left ray
    ctx.moveTo(bulbX + bulbW - 3, bulbY + 3);
    ctx.lineTo(bulbX + 3,         bulbY + bulbH - 3);
    ctx.stroke();
    ctx.restore();
  } else {
    // Unlit: gray-dark glass — lamp is off / disconnected
    ctx.fillStyle = "rgba(60,55,45,0.9)";
    ctx.fillRect(bulbX, bulbY, bulbW, bulbH);
    // Cross reflection mark (suggests glass even when dark)
    ctx.fillStyle = "rgba(100,95,80,0.4)";
    ctx.fillRect(bulbX + bulbW / 2 - 1, bulbY + 2, 2, bulbH - 4);
    ctx.fillRect(bulbX + 2, bulbY + bulbH / 2 - 1, bulbW - 4, 2);
  }

  // ── Outer border ─────────────────────────────────────────────────────────
  ctx.strokeStyle = powered ? `rgba(251,191,36,${0.6 + pulse * 0.4})` : "rgba(100,85,50,0.4)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
  ctx.shadowBlur  = 0;
}

// ─── Data Cable block renderer ────────────────────────────────────────────────
// Draws a conduit pipe with a flowing neon data stream when active.
function drawDataCable(ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number) {
  const x = bx * BS;
  const y = by * BS;

  // Dark conduit background
  ctx.fillStyle = "#111122";
  ctx.fillRect(x, y, BS, BS);

  // Conduit pipe body — a thick gray channel through the center
  ctx.fillStyle = "#2a2a3a";
  ctx.fillRect(x + 12, y + 2, 16, BS - 4);   // vertical pipe
  ctx.fillRect(x + 2, y + 12, BS - 4, 16);   // horizontal pipe

  // Data flow animation — moving dot along the pipe
  if (active) {
    const flow = ((time / 600) % 1.0);  // 0→1 cycling
    const pulse = 0.5 + 0.5 * Math.sin(time / 300);

    // Horizontal data streak
    const streamX = x + 2 + flow * (BS - 4);
    ctx.fillStyle = `rgba(34,197,94,${0.7 + pulse * 0.3})`;
    ctx.fillRect(streamX, y + 17, 6, 6);

    // Vertical data streak (offset by half cycle)
    const flow2 = ((time / 600 + 0.5) % 1.0);
    const streamY = y + 2 + flow2 * (BS - 4);
    ctx.fillRect(x + 17, streamY, 6, 6);

    ctx.shadowColor = "#22c55e";
    ctx.shadowBlur  = 6;
  }

  // Pipe edge highlights
  ctx.strokeStyle = active ? "rgba(34,197,94,0.4)" : "rgba(100,100,120,0.3)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 12, y + 2, 16, BS - 4);
  ctx.strokeRect(x + 2, y + 12, BS - 4, 16);

  // Outer border
  ctx.strokeStyle = active ? "rgba(34,197,94,0.3)" : "rgba(100,100,120,0.2)";
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
  ctx.shadowBlur = 0;
}

// ─── Battery Block renderer ───────────────────────────────────────────────────
// Draws a chunky energy cell with glowing charge bars.
// When charged (active = true) the bars pulse green; when empty they're dark.
// fuelPct (0–1): how full the battery is — shown as a charge bar along the bottom.
// conns: which sides connect to a data_cable (shows green pipe nubs).
function drawBatteryBlock(
  ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number, fuelPct = 0.5,
  conns: { top: boolean; bottom: boolean; left: boolean; right: boolean } = { top: false, bottom: false, left: false, right: false }
) {
  const x = bx * BS;
  const y = by * BS;

  // Dark housing
  ctx.fillStyle = "#0f1a10";
  ctx.fillRect(x, y, BS, BS);

  // Housing border — steel frame
  ctx.fillStyle = "#1e2e1f";
  ctx.fillRect(x + 2, y + 2, BS - 4, BS - 4);

  // Positive terminal nub on top
  ctx.fillStyle = active ? "#22c55e" : "#374151";
  ctx.fillRect(x + BS / 2 - 4, y + 2, 8, 4);

  // Three charge bars — light up from bottom when active
  const barColors = active
    ? ["rgba(34,197,94,0.9)", "rgba(34,197,94,0.75)", "rgba(34,197,94,0.55)"]
    : ["rgba(55,65,81,0.8)",  "rgba(55,65,81,0.6)",   "rgba(55,65,81,0.4)"];
  const pulse = active ? 0.6 + 0.4 * Math.sin(time / 500) : 1;
  for (let i = 0; i < 3; i++) {
    const barY = y + BS - 10 - i * 10;
    ctx.fillStyle = barColors[i];
    ctx.globalAlpha = i === 0 ? pulse : 1;
    ctx.fillRect(x + 6, barY, BS - 12, 6);
    ctx.globalAlpha = 1;
  }

  if (active) {
    // Animated charge spark moving upward
    const spark = ((time / 800) % 1.0);
    const sparkY = y + BS - 8 - spark * (BS - 16);
    ctx.fillStyle = `rgba(134,239,172,${0.8 + 0.2 * Math.sin(time / 200)})`;
    ctx.fillRect(x + BS / 2 - 2, sparkY, 4, 6);
    ctx.shadowColor = "#22c55e";
    ctx.shadowBlur  = 8;
  }

  // ── Fuel level bar at the bottom of the block ──────────────────────────
  // Full width bar background (dark), filled portion shows charge level.
  const barW = BS - 8;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x + 4, y + BS - 5, barW, 3);
  const chargeColor = fuelPct > 0.5 ? "#22c55e" : fuelPct > 0.2 ? "#eab308" : "#ef4444";
  ctx.fillStyle = chargeColor;
  ctx.fillRect(x + 4, y + BS - 5, Math.round(barW * fuelPct), 3);

  // ── Pipe connection nubs — green protrusions where data cables dock ─────
  // The battery participates in the same power network as data_cable blocks.
  // Green nubs on touching sides make the wiring visually explicit.
  ctx.shadowBlur = 0;
  const nubColor = active ? "rgba(34,197,94,0.95)" : "rgba(60,100,60,0.55)";
  ctx.fillStyle  = nubColor;
  if (conns.top)    ctx.fillRect(x + BS / 2 - 4, y,          8, 5);
  if (conns.bottom) ctx.fillRect(x + BS / 2 - 4, y + BS - 5, 8, 5);
  if (conns.left)   ctx.fillRect(x,          y + BS / 2 - 4, 5, 8);
  if (conns.right)  ctx.fillRect(x + BS - 5, y + BS / 2 - 4, 5, 8);

  // Outer border
  ctx.strokeStyle = active ? "rgba(34,197,94,0.5)" : "rgba(100,120,100,0.3)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Generator Block renderer ─────────────────────────────────────────────────
// Draws a diesel generator — chunky engine block with exhaust pipe and warning light.
// Produces visible animated steam from the exhaust when running and fueled.
// conns: which sides connect to a data_cable (shows orange pipe nubs).
function drawGeneratorBlock(
  ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number, fuelPct = 0.5,
  conns: { top: boolean; bottom: boolean; left: boolean; right: boolean } = { top: false, bottom: false, left: false, right: false }
) {
  const x = bx * BS;
  const y = by * BS;

  // Engine body — dark industrial gray
  ctx.fillStyle = "#1a1210";
  ctx.fillRect(x, y, BS, BS);
  ctx.fillStyle = "#2a1e18";
  ctx.fillRect(x + 2, y + 6, BS - 4, BS - 8);

  // Exhaust pipe on top — small chimney
  ctx.fillStyle = "#111";
  ctx.fillRect(x + BS - 12, y + 2, 6, 8);
  ctx.fillStyle = "#333";
  ctx.fillRect(x + BS - 13, y + 2, 8, 3);

  // ── Steam puffs rising from exhaust when fueled and running ─────────────
  // 6 staggered puffs, each at a different animation phase, rising ~55px above
  // the block. They grow and fade as they ascend — visible even in the daytime.
  if (active && fuelPct > 0) {
    for (let i = 0; i < 6; i++) {
      const phase   = ((time / 900) + i / 6) % 1.0;
      const smokeX  = x + BS - 9 + Math.sin(phase * Math.PI * 4) * 5; // slight sway
      const smokeY  = y - phase * 55;              // rises 55px above block top
      const radius  = 3 + phase * 10;              // grows from 3px to 13px
      const alpha   = (1 - phase) * 0.5;           // fades to transparent
      ctx.fillStyle = `rgba(200,195,210,${alpha})`;
      ctx.beginPath();
      ctx.arc(smokeX, smokeY, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Engine cooling fins — horizontal ridges
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = "#3a2a22";
    ctx.fillRect(x + 4, y + 12 + i * 8, BS - 8, 4);
  }

  // Warning / status light — top left corner
  const blinkOn = active ? Math.sin(time / 400) > 0 : false;
  ctx.fillStyle = blinkOn ? "#ef4444" : (active ? "#7f1d1d" : "#374151");
  ctx.beginPath();
  ctx.arc(x + 8, y + 8, 4, 0, Math.PI * 2);
  ctx.fill();
  if (blinkOn) {
    ctx.shadowColor = "#ef4444";
    ctx.shadowBlur  = 8;
    ctx.fill();
  }

  // Output power terminals at the bottom
  ctx.fillStyle = active ? "#f59e0b" : "#374151";
  ctx.fillRect(x + 6,      y + BS - 6, 8, 4); // positive terminal
  ctx.fillRect(x + BS - 14, y + BS - 6, 8, 4); // negative terminal

  // ── Diesel fuel gauge bar at the bottom ────────────────────────────────
  const barW = BS - 8;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x + 4, y + BS - 5, barW, 3);
  const fuelColor = fuelPct > 0.4 ? "#f59e0b" : fuelPct > 0.15 ? "#f97316" : "#ef4444";
  ctx.fillStyle = fuelColor;
  ctx.fillRect(x + 4, y + BS - 5, Math.round(barW * fuelPct), 3);
  // "DIESEL" label stub — tiny dots at low fuel
  if (fuelPct < 0.15 && active) {
    ctx.fillStyle = `rgba(239,68,68,${0.5 + 0.5 * Math.sin(time / 200)})`;
    ctx.fillRect(x + BS / 2 - 4, y + BS - 5, 8, 3); // blink red
  }

  // ── Pipe connection nubs — orange protrusions where data cables dock ────
  // Generator pushes power into the network; nubs show the connection points.
  ctx.shadowBlur = 0;
  const nubC = active ? "rgba(245,158,11,0.95)" : "rgba(100,80,40,0.55)";
  ctx.fillStyle  = nubC;
  if (conns.top)    ctx.fillRect(x + BS / 2 - 4, y,          8, 5);
  if (conns.bottom) ctx.fillRect(x + BS / 2 - 4, y + BS - 5, 8, 5);
  if (conns.left)   ctx.fillRect(x,          y + BS / 2 - 4, 5, 8);
  if (conns.right)  ctx.fillRect(x + BS - 5, y + BS / 2 - 4, 5, 8);

  // Outer border
  ctx.strokeStyle = active ? "rgba(245,158,11,0.45)" : "rgba(120,100,80,0.3)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
  ctx.shadowBlur  = 0;
}

// ─── Mining Rig Block renderer ────────────────────────────────────────────────
// Draws an ASIC server rack — rows of chip slots, blinking status LEDs, and a
// green power indicator when connected to the cluster and powered. Each mining_rig
// block placed in the world = +1 TH of compute (tracked by scanMachineCluster).
function drawMiningRig(
  ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number
) {
  const x = bx * BS, y = by * BS;

  // Chassis background — dark server blue-black
  ctx.fillStyle = "#111822";
  ctx.fillRect(x, y, BS, BS);

  // Rack face — slightly lighter panel
  ctx.fillStyle = "#192234";
  ctx.fillRect(x + 2, y + 2, BS - 4, BS - 4);

  // ── ASIC chip rows — 3 rows of 4 chips each ──────────────────────────────
  const chipW = 7, chipH = 5;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const cx = x + 4 + col * (chipW + 2);
      const cy = y + 5 + row * (chipH + 4);
      // Active chips glow green; inactive are dark gray
      ctx.fillStyle = active
        ? `rgba(34,197,94,${0.55 + 0.35 * Math.sin(time / 600 + row + col * 0.7)})`
        : "#1e2a1e";
      ctx.fillRect(cx, cy, chipW, chipH);
    }
  }

  // ── Status LED row at the bottom ─────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    const phase  = (time / 350 + i * 0.5) % (Math.PI * 2);
    const bright = active ? (Math.sin(phase) > 0.4 ? 1 : 0.25) : 0.12;
    ctx.fillStyle = active ? `rgba(34,197,94,${bright})` : "rgba(60,80,60,0.4)";
    ctx.fillRect(x + 5 + i * 8, y + BS - 6, 4, 3);
  }

  // Outer border — green when active
  ctx.strokeStyle = active ? "rgba(34,197,94,0.55)" : "rgba(80,100,80,0.25)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Fan Block renderer ───────────────────────────────────────────────────────
// Draws an industrial cooling fan — rotating blade circle with cyan glow when
// connected to the cluster. Each fan_block reduces hourly temperature rise by
// FAN_COOLING_PER_HOUR. 4 fans = zero net temperature rise at base load.
function drawFanBlock(
  ctx: CanvasRenderingContext2D, bx: number, by: number, active: boolean, time: number
) {
  const x = bx * BS, y = by * BS;
  const cx = x + BS / 2, cy = y + BS / 2;
  const r  = BS * 0.38;  // blade circle radius

  // Fan housing — dark teal-black panel
  ctx.fillStyle = "#101820";
  ctx.fillRect(x, y, BS, BS);
  ctx.fillStyle = "#152028";
  ctx.fillRect(x + 2, y + 2, BS - 4, BS - 4);

  // ── Rotating fan blades (4 blades, time-animated) ────────────────────────
  // Speed is 1.5 rpm equivalent when active, slow drift when idle.
  const speed   = active ? 1.8 : 0.18;
  const angle   = (time / 1000) * speed * Math.PI * 2;
  const bladeColor = active ? "rgba(0,200,255,0.75)" : "rgba(40,80,100,0.55)";

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  for (let b = 0; b < 4; b++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.ellipse(r * 0.5, -r * 0.35, r * 0.5, r * 0.22, 0, 0, Math.PI * 2);
    ctx.fillStyle = bladeColor;
    ctx.fill();
  }
  ctx.restore();

  // ── Hub circle (center cap) ───────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = active ? "#00b4d8" : "#1e3040";
  ctx.fill();

  // Glow ring when active
  if (active) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,180,255,${0.2 + 0.15 * Math.sin(time / 300)})`;
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  // Outer border
  ctx.strokeStyle = active ? "rgba(0,180,255,0.45)" : "rgba(40,80,100,0.25)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Clock Block renderer ─────────────────────────────────────────────────────
// Draws a pixel-art analog clock face with moving hour + minute hands.
// The clock maps the 15-minute DAY_MS cycle onto a 24-hour in-game day:
//   t=0.0 = 00:00 midnight, t=0.25 = 06:00, t=0.5 = 12:00, t=0.75 = 18:00
// When powered (connected via cable to active solar/battery/generator):
//   • Hands spin live, face glows pale blue-white
//   • Phase label (NIGHT/DAWN/DAY/DUSK) fades in below center
// When unpowered:
//   • Dark face, hands fixed at 12:00, dim gray border
function drawClockBlock(
  ctx: CanvasRenderingContext2D, bx: number, by: number, powered: boolean, now: number
) {
  const x  = bx * BS;
  const y  = by * BS;
  const cx = x + BS / 2;   // block center X
  const cy = y + BS / 2;   // block center Y
  const R  = 15;            // clock face radius (px)

  // ── Case / background ────────────────────────────────────────────────────
  ctx.fillStyle = "#13131f";
  ctx.fillRect(x, y, BS, BS);

  // Outer bezel ring
  ctx.beginPath();
  ctx.arc(cx, cy, R + 3, 0, Math.PI * 2);
  ctx.fillStyle = powered ? "#1e1e3a" : "#161618";
  ctx.fill();
  ctx.strokeStyle = powered ? "rgba(160,160,255,0.65)" : "rgba(80,80,100,0.35)";
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // ── Clock face (inner fill) ───────────────────────────────────────────────
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = powered ? "#0c0c20" : "#0a0a0f";
  ctx.fill();

  // Optional soft glow when powered
  if (powered) {
    ctx.shadowColor = "rgba(120,120,255,0.55)";
    ctx.shadowBlur  = 10;
  }

  // ── Hour tick marks (12 ticks around the face) ────────────────────────────
  for (let i = 0; i < 12; i++) {
    const angle    = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const isMain   = i % 3 === 0;   // 12, 3, 6, 9 are longer
    const innerR   = isMain ? R - 5 : R - 3;
    ctx.strokeStyle = powered
      ? (isMain ? "rgba(200,200,255,0.9)" : "rgba(160,160,220,0.55)")
      : "rgba(80,80,100,0.4)";
    ctx.lineWidth = isMain ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
    ctx.lineTo(cx + Math.cos(angle) * R,       cy + Math.sin(angle) * R);
    ctx.stroke();
  }

  // ── Compute in-game clock hands from DAY_MS cycle ─────────────────────────
  const t     = (now % DAY_MS) / DAY_MS; // 0.0 – 1.0 within the 15-min cycle
  const h12   = (t * 24) % 12;           // 0–12 in-game hours (12h format)
  const mins  = (h12 % 1) * 60;          // 0–60 minutes within that hour
  // Angles: -π/2 offsets so 12 o'clock points up
  const hourAngle   = (h12 / 12)  * Math.PI * 2 - Math.PI / 2;
  const minuteAngle = (mins / 60) * Math.PI * 2 - Math.PI / 2;

  ctx.lineCap = "round";

  // Hour hand — short + thick
  ctx.strokeStyle = powered ? "rgba(230,230,255,0.95)" : "rgba(60,60,80,0.4)";
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(
    cx + Math.cos(hourAngle)   * (R - 7),
    cy + Math.sin(hourAngle)   * (R - 7)
  );
  ctx.stroke();

  // Minute hand — long + thin
  ctx.strokeStyle = powered ? "rgba(180,200,255,0.85)" : "rgba(50,50,70,0.35)";
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(
    cx + Math.cos(minuteAngle) * (R - 3),
    cy + Math.sin(minuteAngle) * (R - 3)
  );
  ctx.stroke();

  ctx.lineCap = "butt";

  // Center hub dot
  ctx.beginPath();
  ctx.arc(cx, cy, 2, 0, Math.PI * 2);
  ctx.fillStyle = powered ? "rgba(255,255,255,0.9)" : "rgba(70,70,90,0.4)";
  ctx.fill();

  // ── Phase label below center (only when powered) ──────────────────────────
  // Shows which phase of the day/night cycle is currently active.
  if (powered) {
    let label: string;
    if      (t < 0.22) label = "NIGHT";
    else if (t < 0.30) label = "DAWN";
    else if (t < 0.68) label = "DAY";
    else if (t < 0.78) label = "DUSK";
    else               label = "NIGHT";

    ctx.font         = "bold 4px monospace";
    ctx.fillStyle    = "rgba(180,180,255,0.75)";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + R - 5);
    ctx.textAlign    = "left";
    ctx.textBaseline = "alphabetic";
  }

  ctx.shadowBlur  = 0;

  // Outer block border
  ctx.strokeStyle = powered ? "rgba(130,130,220,0.55)" : "rgba(50,50,70,0.3)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Client-side machine adjacency check ─────────────────────────────────────
// Returns true if a machine_core at (gx,gy) has at least one solar_panel_block
// or data_cable adjacent to it — used for the active glow visual only.
// The server is the authority on actual miner state.
function isMachineCoreActive(grid: string[][], gx: number, gy: number): boolean {
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  return dirs.some(([dx, dy]) => {
    const nx = gx + dx, ny = gy + dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) return false;
    return grid[ny][nx] === "solar_panel_block" || grid[ny][nx] === "data_cable";
  });
}

// ─── Solar Panel sky-exposure check ──────────────────────────────────────────
// A solar panel only generates power when:
//   1. No solid blocks exist directly above it (needs open sky / no roof)
//   2. It is daytime (dayFactor > 0.15 — fades with the sun)
// If covered by any block or if it's night, it produces zero power.
function isSolarPanelExposed(grid: string[][], gx: number, gy: number, dayFactor: number): boolean {
  if (dayFactor < 0.15) return false;           // night — sun is gone
  for (let y = gy - 1; y >= 0; y--) {           // scan all blocks above
    if ((grid[y]?.[gx] ?? "air") !== "air") return false; // blocked by roof!
  }
  return true;  // clear sky above and sunlight available
}

// Returns true if a solar panel at (gx,gy) is wired to a cable or core neighbor
// (purely for visual glow — adjacency wiring display).
function isSolarPanelWired(grid: string[][], gx: number, gy: number): boolean {
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  return dirs.some(([dx, dy]) => {
    const nx = gx + dx, ny = gy + dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) return false;
    return MACHINE_BLOCKS.has(grid[ny][nx]);
  });
}

// ─── BFS Power Chain ─────────────────────────────────────────────────────────
// Returns true if machine_core at (gx,gy) has a cable/block path back to ANY
// active power source:
//   • solar_panel_block — only when exposed to open sky AND daytime
//   • battery_block     — always active (charged during day, discharges at night)
//   • generator_block   — always active (diesel; no sun required)
// All three block types act as BFS seeds; the flood-fill then travels through
// MACHINE_BLOCKS (cables, lamps, etc.) to reach the target core.
function isCoreConnectedToPower(grid: string[][], gx: number, gy: number, dayFactor: number): boolean {
  const visited = new Set<string>();
  const queue: [number, number][] = [];

  // Seed from every powered source in the grid
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[y]?.length ?? 0); x++) {
      const blk = grid[y][x];
      const isPowered =
        (blk === "solar_panel_block" && isSolarPanelExposed(grid, x, y, dayFactor)) ||
        blk === "battery_block"   || // stores solar charge — works day and night
        blk === "generator_block";   // diesel — always on
      if (isPowered) {
        const k = `${x},${y}`;
        visited.add(k);
        queue.push([x, y]);
      }
    }
  }

  // Flood-fill through all MACHINE_BLOCKS to reach the target position
  while (queue.length > 0) {
    const [cx, cy] = queue.shift()!;
    if (cx === gx && cy === gy) return true;
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      const nx = cx + dx, ny = cy + dy;
      if (ny < 0 || ny >= grid.length || nx < 0 || nx >= (grid[ny]?.length ?? 0)) continue;
      const k = `${nx},${ny}`;
      if (visited.has(k)) continue;
      if (MACHINE_BLOCKS.has(grid[ny][nx])) {
        visited.add(k);
        queue.push([nx, ny]);
      }
    }
  }
  return false;
}

// ─── Pipe connection helper ───────────────────────────────────────────────────
// Which of the 4 cardinal neighbors are also machine blocks (cables/cores/panels)?
// Used to auto-connect pipe segments visually — like Factorio or Minecraft pipes.
function getPipeConns(grid: string[][], gx: number, gy: number) {
  const check = (dx: number, dy: number) => {
    const nx = gx + dx, ny = gy + dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= (grid[ny]?.length ?? 0)) return false;
    return MACHINE_BLOCKS.has(grid[ny][nx]);
  };
  return { top: check(0, -1), bottom: check(0, 1), left: check(-1, 0), right: check(1, 0) };
}

// ─── Directional Pipe renderer ────────────────────────────────────────────────
// Draws pipe segments connecting to neighbors. Looks like plumbing — straight,
// elbow, T-junction, or cross — depending on which sides have machine neighbors.
// Active pipes glow green and show data flowing through them; inactive are dim.
function drawPipe(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number,
  active: boolean, time: number,
  conn: { top: boolean; bottom: boolean; left: boolean; right: boolean }
) {
  const x = bx * BS, y = by * BS;
  const cx = x + BS / 2, cy = y + BS / 2;
  const PW2 = 11; // pipe tube half-width in px

  // Dark background
  ctx.fillStyle = "#0d0d1a";
  ctx.fillRect(x, y, BS, BS);

  // Pipe body color (glowing green when active, steel-gray when cold)
  const pipeBody   = active ? "#1a3a2a" : "#1e202e";
  const pipeEdge   = active ? `rgba(34,197,94,${0.5 + 0.35 * Math.sin(time / 400)})` : "rgba(90,100,120,0.45)";
  const junctionC  = active ? `rgba(34,197,94,${0.7 + 0.3 * Math.sin(time / 320)})` : "rgba(80,90,110,0.4)";

  if (active) {
    ctx.shadowColor = "#22c55e";
    ctx.shadowBlur  = 7;
  }

  // Determine which arms to draw (at least H if nothing connects)
  const hasH = conn.left  || conn.right  || (!conn.top && !conn.bottom);
  const hasV = conn.top   || conn.bottom || (!conn.left && !conn.right);

  // Draw horizontal arm
  if (hasH) {
    const x1 = conn.left  ? x : cx - PW2 / 2;
    const x2 = conn.right ? x + BS : cx + PW2 / 2;
    ctx.fillStyle = pipeBody;
    ctx.fillRect(x1, cy - PW2 / 2, x2 - x1, PW2);
    // Inner highlight stripe
    ctx.fillStyle = pipeEdge;
    ctx.fillRect(x1, cy - PW2 / 2 + 1, x2 - x1, 2);
    ctx.fillRect(x1, cy + PW2 / 2 - 3, x2 - x1, 2);
  }
  // Draw vertical arm
  if (hasV) {
    const y1 = conn.top    ? y : cy - PW2 / 2;
    const y2 = conn.bottom ? y + BS : cy + PW2 / 2;
    ctx.fillStyle = pipeBody;
    ctx.fillRect(cx - PW2 / 2, y1, PW2, y2 - y1);
    // Inner highlight stripe
    ctx.fillStyle = pipeEdge;
    ctx.fillRect(cx - PW2 / 2 + 1, y1, 2, y2 - y1);
    ctx.fillRect(cx + PW2 / 2 - 3, y1, 2, y2 - y1);
  }

  // Junction center circle (bolt/coupling)
  ctx.fillStyle = junctionC;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();

  // Flowing data particles when powered
  if (active) {
    const flow1 = (time / 900) % 1.0;
    const flow2 = (time / 900 + 0.5) % 1.0;
    ctx.fillStyle = "rgba(180,255,180,0.85)";
    if (hasH) {
      const pX = x + flow1 * BS;
      ctx.fillRect(pX, cy - 1, 4, 2);
    }
    if (hasV) {
      const pY = y + flow2 * BS;
      ctx.fillRect(cx - 1, pY, 2, 4);
    }
  }

  ctx.shadowBlur  = 0;
  // Outer border
  ctx.strokeStyle = active ? "rgba(34,197,94,0.25)" : "rgba(100,100,120,0.18)";
  ctx.lineWidth   = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, BS - 1, BS - 1);
}

// ─── Water Splash renderer (drawn in world space) ─────────────────────────────
// Called from drawFrame after the flash layer. alpha: 1.0 (fresh) → 0.0 (faded).
function drawWaterSplash(ctx: CanvasRenderingContext2D, bx: number, by: number, alpha: number) {
  const cx = bx * BS + BS / 2;
  const cy = by * BS + BS / 2;
  const spread = (1 - alpha) * 22;  // particles fly outward as alpha drops

  // 8 droplet particles emanating from center
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const px = cx + Math.cos(angle) * spread;
    const py = cy + Math.sin(angle) * spread;
    ctx.fillStyle = `rgba(80,180,255,${alpha * 0.85})`;
    ctx.beginPath();
    ctx.arc(px, py, 2.5 * alpha + 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Center ripple ring
  ctx.strokeStyle = `rgba(130,210,255,${alpha * 0.6})`;
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, spread + 3, 0, Math.PI * 2);
  ctx.stroke();
  // Inner splash flash
  ctx.fillStyle = `rgba(200,240,255,${alpha * 0.35})`;
  ctx.fillRect(bx * BS + 4, by * BS + 4, BS - 8, BS - 8);
}

// ============================================================
// MAIN COMPONENT
// ============================================================
// Props passed from the /game/:worldName route in App.tsx.
// worldName is the Growtopia-style world name (e.g. "START", "FARM").
interface GameProps { worldName: string; }

export default function Game({ worldName }: GameProps) {
  // ── Auth — stored in localStorage after login ────────────────────────────
  const userId  = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";

  // Canvas DOM ref — all drawing happens here
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Layout measurement refs ──────────────────────────────────────────────
  // Refs for debug height measurement
  const gameRef    = useRef<HTMLDivElement>(null);
  const topHudRef  = useRef<HTMLDivElement>(null);
  const ctrlBarRef = useRef<HTMLDivElement>(null);
  const hotbarRef  = useRef<HTMLDivElement>(null);
  const [midH, setMidH] = useState<number>(0); // px height for the canvas row

  // ── Server data hooks ────────────────────────────────────────────────────
  // worldName comes from the route param — dynamic Growtopia-style multi-world
  const { data: world, refetch: refetchWorld } = useGetWorld(worldName, {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey(worldName) },
  });
  const { data: wallet, refetch: refetchWallet } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  const { data: inventory = [], refetch: refetchInventory } = useGetInventory({
    query: { enabled: !!userId, queryKey: getGetInventoryQueryKey(), refetchInterval: 5000 },
  });
  const gameAction    = useGameAction();
  // maintainMiner: POST /api/miner/maintain — apply thermal_paste or flush_cooling.
  // Consumes 1 item from inventory and resets (or flushes) the miner temperature.
  const maintainMiner = useMaintainMiner();
  const { toast } = useToast();
  // queryClient: used for optimistic gem counter updates on block break so the
  // HUD reflects the new gem balance instantly without waiting for a server refetch.
  const queryClient = useQueryClient();

  // ── Miner data — used for overheat detection in the world renderer ────────
  const { data: minerData } = useGetMiner({ query: { enabled: !!userId, refetchInterval: 8000 } });
  // Store overheat flag in a ref so drawFrame can read it without re-creating
  const overheatRef    = useRef(false);
  const critHeatRef    = useRef(false);

  // ── Physics state (ref = mutable, no re-render on every frame) ───────────
  const physRef = useRef({
    px: 5 * BS,        // world pixel X position
    py: 0,             // world pixel Y position
    vx: 0,             // horizontal velocity (px/s)
    vy: 0,             // vertical velocity   (px/s)
    onGround:    false,// true when player is standing on a solid block
    facingRight: true, // affects pickaxe/tool sprite direction
    spawned:     false,// true once the initial spawn has been set
    // ── Health system ──────────────────────────────────────────────────────
    hp:    100,        // current health (0 = dead)
    maxHp: 100,        // max health (always 100 for now)
    lastLavaDamageAt: 0,  // timestamp of last lava damage tick (prevents spam)
  });

  // ── Zoom + Camera refs (no re-render needed — used in drawFrame) ─────────
  // zoom: 1.0 = default, 2.0 = 2× magnified (fewer blocks visible)
  const zoomRef   = useRef(1.5);     // start slightly zoomed in
  // camera: world pixel coordinate of the top-left of the visible viewport
  const camRef    = useRef({ x: 0, y: 0 });

  // ── Input / loop refs ─────────────────────────────────────────────────────
  const keysRef   = useRef<Set<string>>(new Set());
  const worldRef  = useRef<string[][] | null>(null);
  const rafRef    = useRef(0);
  const lastTRef  = useRef(0);

  // ── Block breaking animation state ───────────────────────────────────────
  // "bx,by" → { hits: how many times clicked, maxHits: total needed }
  const breakingRef     = useRef<Map<string, { hits: number; maxHits: number }>>(new Map());
  // "bx,by" → flash alpha (0-1, fades each frame)
  const flashRef        = useRef<Map<string, number>>(new Map());
  // prevents double-firing while waiting for a server response
  const pendingBreakRef = useRef(false);

  // ── Water splash animations ───────────────────────────────────────────────
  // "bx,by" → remaining time in ms. Water splash fades over ~800ms.
  const waterSplashRef  = useRef<Map<string, number>>(new Map());

  // ── Sapling growth timers ──────────────────────────────────────────────────
  // "bx,by" → timestamp when the sapling was planted (ms).
  // A useEffect checks every second; once 15s have passed, sends the "grow"
  // action to convert the sapling into a full oak log.
  const saplingTimersRef = useRef<Map<string, number>>(new Map());

  // ── Light map: precomputed per-block brightness (0.0 = dark, 1.0 = lit) ──
  // Recomputed whenever world data changes. Stored as [row][col].
  // Sunlight enters from the top of each column and attenuates underground.
  const lightMapRef     = useRef<number[][] | null>(null);

  // ── Joystick UI state — only used for rendering the thumb position ────────
  const [joystickThumb, setJoystickThumb] = useState({ x: 0, y: 0 });
  const joystickActiveRef = useRef(false);
  const joystickBaseRef   = useRef({ x: 0, y: 0 });
  const JOYSTICK_R        = 34; // max thumb travel from center (px)

  // ── UI state ──────────────────────────────────────────────────────────────
  const [mode,          setMode]         = useState<"punch" | "place">("punch");
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [wizard,        setWizard]        = useState(false);
  const [wizardAns,     setWizardAns]     = useState("");
  const [chatOpen,      setChatOpen]      = useState(false);

  // ── Use-item selection (hotbar USE section) ───────────────────────────────
  // When set, clicking a compatible machine block applies the item instead of
  // mining it. Auto-switches to punch mode (use items are never "placed").
  const [selectedUseItem, setSelectedUseItem] = useState<string | null>(null);

  // ── Structure popup — shown when tapping a machine block with no use item ─
  // Shows live block + rig stats. Has a "Break Block" button for disassembly.
  const [structurePopup,  setStructurePopup]  = useState<{
    bx: number; by: number; blockType: string;
  } | null>(null);

  // ── Floating in-game windows (toggled from HUD icon buttons) ─────────────
  const [showMinerWin, setShowMinerWin] = useState(false);
  const [showInvWin,   setShowInvWin]   = useState(false);
  const [showStoreWin, setShowStoreWin] = useState(false);
  const [showLeadWin,  setShowLeadWin]  = useState(false);

  // ── Solar / daytime tracking — updates every 3s to keep badge accurate ──
  // dayFactor matches the canvas renderer's value so badge never lies.
  const [isDay, setIsDay] = useState(() => {
    const s = getSky(Date.now());
    return Math.max(0, 1 - s.alpha / 0.38) > 0.15;
  });

  // ── Player position persistence ───────────────────────────────────────────
  // savedPosRef is populated by the position-fetch effect below.
  // The spawn effect reads it once (when physRef.current.spawned is false) to
  // resume the player at their last location instead of the surface of column 5.
  const savedPosRef = useRef<{ x: number; y: number } | null>(null);

  const [chatMsgs,      setChatMsgs]      = useState<{ username: string; message: string }[]>([]);
  const [chatInput,     setChatInput]     = useState("");
  // Zoom display state (just for showing zoom% in the UI)
  const [zoomDisplay,   setZoomDisplay]   = useState(1.5);

  // ── WebSocket for multiplayer chat ───────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);

  // ── Static star positions (random once, reused every frame) ──────────────
  const starsRef = useRef(
    Array.from({ length: 90 }, () => ({
      x:       Math.random() * WW,
      y:       Math.random() * WH * 0.55,
      r:       Math.random() * 1.5 + 0.4,
      twinkle: Math.random() * Math.PI * 2,
    }))
  );

  // ── Minimap refs and toggle state ────────────────────────────────────────
  // minimapRef      — the small overlay <canvas> drawn into each rAF tick
  // minimapFrameRef — frame counter; minimap is only redrawn every 3 frames
  //                   (20fps update rate) to save GPU/CPU on low-end devices
  const minimapRef       = useRef<HTMLCanvasElement>(null);
  const minimapFrameRef  = useRef(0);
  // showMinimap: toggled by the MAP button in the HUD; persists in state so
  // players can hide it if it covers important screen real-estate on mobile.
  const [showMinimap, setShowMinimap] = useState(true);

  // ── World lock state ──────────────────────────────────────────────────────
  // worldLocked: true means only the owner can break/place blocks.
  // worldOwnerId: the numeric user_id of whoever locked the world (null = no owner).
  // Both are populated from the GET /api/world/:name response in the world-sync effect.
  const [worldLocked,  setWorldLocked]  = useState(false);
  const [worldOwnerId, setWorldOwnerId] = useState<number | null>(null);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: keep isDay in sync with the live getSky calculation.
  // Polling every 3 seconds is more than frequent enough for a 15-min cycle.
  // This drives the solar badge so it always reflects the actual dayFactor
  // used inside the canvas renderer (same formula: 1 - alpha/0.38 > 0.15).
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const tick = () => {
      const s = getSky(Date.now());
      setIsDay(Math.max(0, 1 - s.alpha / 0.38) > 0.15);
    };
    tick();                            // run immediately on mount
    const id = setInterval(tick, 3000);
    return () => clearInterval(id);
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: sync world data from server into the local ref used by the loop
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;

    // ── Sync world lock & owner from server response ───────────────────────────
    // The server always returns locked + ownerId in GET /api/world/:name.
    // Cast through unknown because the generated OpenAPI types don't include them yet.
    const wAny = world as unknown as { locked?: boolean; ownerId?: number | null };
    setWorldLocked(wAny.locked ?? false);
    setWorldOwnerId(wAny.ownerId ?? null);

    // First load only: resume at saved position or fall back to surface of column 5.
    // The server embeds savedPosition in the world response so no extra round-trip is needed.
    if (!physRef.current.spawned) {
      // Cast: savedPosition is not in the OpenAPI type but the server always returns it
      const saved = (world as unknown as { savedPosition?: { x: number; y: number } | null })
        .savedPosition;
      if (saved) {
        // Resume exactly where the player left off last time
        physRef.current.px = saved.x;
        physRef.current.py = saved.y;
      } else {
        // First visit — find the topmost air cell in column 5 (just left of centre)
        const bd = world.blockData;
        let spawnY = 0;
        for (let y = 0; y < bd.length; y++) {
          if (bd[y][5] === "air") { spawnY = y; break; }
        }
        physRef.current.py = spawnY * BS;
        physRef.current.px = 5 * BS + (BS - PW) / 2;
      }
      physRef.current.spawned = true;
    }

    // ── Recompute sunlight map when world changes ─────────────────────────
    // For each column, sunlight enters from the top and attenuates downward.
    // Surface blocks exposed to open sky = fully lit.
    // Underground blocks decay rapidly to near-black (players need machines/torches).
    const bd = world.blockData;
    const h  = bd.length;
    const w  = bd[0]?.length ?? 0;
    const lm: number[][] = Array.from({ length: h }, () => new Array(w).fill(0));

    for (let gx = 0; gx < w; gx++) {
      let reachedSurface = false;
      let depthBelow     = 0;
      for (let gy = 0; gy < h; gy++) {
        if (bd[gy][gx] === "air") {
          lm[gy][gx] = 1.0;            // sky / open air — full sunlight
        } else if (!reachedSurface) {
          lm[gy][gx] = 0.92;           // first solid surface block — almost fully lit
          reachedSurface = true;
          depthBelow = 1;
        } else {
          // Underground — each block deeper gets progressively darker
          lm[gy][gx] = Math.max(0.04, 0.85 - depthBelow * 0.14);
          depthBelow++;
        }
      }
    }
    // ── Second pass: spread light from lamp_block positions ──────────────
    // Lamp blocks count as local light sources in the static light map so that
    // nearby underground blocks have less darkness baked in during rendering.
    // We treat every lamp_block as always-lit here (power state depends on
    // dayFactor which changes per-frame; the darkness overlay still dims the
    // area at night, but block-level blackness is pre-reduced near lamps).
    const LAMP_REACH = 14; // illumination radius in blocks
    for (let gy = 0; gy < h; gy++) {
      for (let gx = 0; gx < w; gx++) {
        if (bd[gy][gx] !== "lamp_block") continue;
        // Spread warm light in a radius around each lamp
        for (let dy = -LAMP_REACH; dy <= LAMP_REACH; dy++) {
          for (let dx = -LAMP_REACH; dx <= LAMP_REACH; dx++) {
            const ny = gy + dy;
            const nx = gx + dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > LAMP_REACH) continue;
            // Linear falloff: lamp center = 0.92 brightness, edge = 0
            const lampContrib = 0.92 * (1 - dist / LAMP_REACH);
            lm[ny][nx] = Math.max(lm[ny][nx], lampContrib);
          }
        }
      }
    }

    lightMapRef.current = lm;
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: sync miner overheat state into refs (read in drawFrame)
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const temp         = (minerData as { temperature?: number })?.temperature ?? 0;
    overheatRef.current  = temp > 80;   // warning — orange glow
    critHeatRef.current  = temp > 95;   // critical — red pulse
  }, [minerData]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: open WebSocket for real-time world chat
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { username: string; message: string };
        setChatMsgs((prev) => [...prev.slice(-29), m]);  // keep last 30
      } catch { /* ignore malformed */ }
    };
    return () => ws.close();
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: autosave player position every 10 s + once on unmount.
  // The server stores (x, y) per (user, world) so the next visit resumes here.
  // Position is sent as world-pixel coordinates (same units as physRef.px/py).
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!userId || !worldName) return;

    const savePosition = () => {
      const { px, py } = physRef.current;
      fetch(`/api/world/${encodeURIComponent(worldName)}/position`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-user-id": userId },
        body:    JSON.stringify({ x: px, y: py }),
      }).catch(() => {/* best-effort — ignore network errors */});
    };

    // Periodic autosave
    const intervalId = setInterval(savePosition, 10_000);
    // Final save when the player navigates away or closes the tab
    return () => { clearInterval(intervalId); savePosition(); };
  }, [userId, worldName]);

  // ── Send chat message ─────────────────────────────────────────────────────
  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ username, message: chatInput.trim() }));
    setChatInput("");
  };

  // ════════════════════════════════════════════════════════════════════════
  // Helper: is block at grid position solid (non-air)?
  // Used by physics AABB collision every frame.
  //
  // fromAbove = true  → platform_block IS solid (player falls onto top surface)
  // fromAbove = false → platform_block is NOT solid (player jumps through / walks through)
  // This makes platform_block a one-way platform: passable from below/sides,
  // solid only when landing from above.
  // ════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx: number, by: number, fromAbove = false): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0)                        return false;  // open sky above
    if (by >= bd.length)               return true;   // solid floor below world
    if (bx < 0 || bx >= bd[0].length) return true;   // solid walls at edges
    const blk = bd[by][bx];
    if (blk === "air") return false;
    // Platform blocks are one-way — solid only when falling onto the top surface
    if (blk === "platform_block") return fromAbove;
    return true;
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // MAIN RENDER LOOP — executes every animation frame (~60fps)
  // Physics update → clear canvas → draw sky → draw blocks → draw player
  // ════════════════════════════════════════════════════════════════════════
  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Delta time in seconds, capped at 50ms to handle tab switching gracefully
    const dt = Math.min((now - lastTRef.current) / 1000, 0.05);
    lastTRef.current = now;

    const p    = physRef.current;
    const bd   = worldRef.current;
    const zoom = zoomRef.current;

    // ── PHYSICS ───────────────────────────────────────────────────────────
    if (bd) {
      // Horizontal movement with AABB wall collision
      const npx = p.px + p.vx * dt;
      const ty0 = Math.floor((p.py + 2)      / BS);   // top of player
      const ty1 = Math.floor((p.py + PH - 2) / BS);   // bottom of player

      if (p.vx > 0) {
        // Moving right — check right wall of bounding box
        const tx = Math.floor((npx + PW) / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = tx * BS - PW;
      } else if (p.vx < 0) {
        // Moving left — check left wall of bounding box
        const tx = Math.floor(npx / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = (tx + 1) * BS;
      }
      p.px = Math.max(0, Math.min(bd[0].length * BS - PW, p.px));

      // Vertical movement with gravity + floor/ceiling collision
      p.vy       = Math.min(p.vy + GRAVITY * dt, 850);  // terminal velocity
      const npy  = p.py + p.vy * dt;
      const tx0  = Math.floor((p.px + 2)      / BS);    // left edge
      const tx1  = Math.floor((p.px + PW - 2) / BS);    // right edge
      p.onGround = false;

      if (p.vy >= 0) {
        // Falling — check feet collision (fromAbove=true so platform_block is solid)
        const ty = Math.floor((npy + PH) / BS);
        if (solid(tx0, ty, true) || solid(tx1, ty, true)) {
          p.py = ty * BS - PH;   // land on top of block
          p.vy = 0;
          p.onGround = true;
        } else {
          p.py = npy;
        }
      } else {
        // Rising — check head collision (fromAbove=false so platform_block is passable)
        const ty = Math.floor(npy / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = (ty + 1) * BS;  // bump head
          p.vy = 0;
        } else {
          p.py = npy;
        }
      }
      p.py = Math.max(0, Math.min(bd.length * BS - PH, p.py));

      // ── LAVA DAMAGE ────────────────────────────────────────────────────
      // Check if the player's bounding box overlaps any lava block.
      // Drains 15 HP per 200ms (75 HP/s), giving players about 1.3s before death.
      // On death: respawn at column 5 with full HP, reset velocity.
      const lavaL = Math.floor(p.px / BS);
      const lavaR = Math.floor((p.px + PW - 1) / BS);
      const lavaT = Math.floor(p.py / BS);
      const lavaB = Math.floor((p.py + PH - 1) / BS);
      let touchingLava = false;
      lavaScan:
      for (let lavaRow = lavaT; lavaRow <= lavaB; lavaRow++) {
        for (let lavaCol = lavaL; lavaCol <= lavaR; lavaCol++) {
          if (bd[lavaRow]?.[lavaCol] === "block_lava") { touchingLava = true; break lavaScan; }
        }
      }
      if (touchingLava && now - p.lastLavaDamageAt > 200) {
        p.lastLavaDamageAt = now;
        p.hp = Math.max(0, p.hp - 15);
        if (p.hp <= 0) {
          // Respawn: find first air cell in column 5 from the top
          let spawnY = 0;
          for (let sy = 0; sy < bd.length; sy++) {
            if (bd[sy]?.[5] === "air") { spawnY = sy; break; }
          }
          p.hp  = 100;
          p.px  = 5 * BS + (BS - PW) / 2;
          p.py  = spawnY * BS;
          p.vx  = 0;
          p.vy  = 0;
        }
      }
    }

    // ── CAMERA: follow player, clamped to world bounds ────────────────────
    // Camera tracks the center of the player and clamps so we don't show
    // out-of-world black borders. The viewport in world-pixels is WW/zoom × WH/zoom.
    const vpW    = WW / zoom;   // visible width in world pixels
    const vpH    = WH / zoom;   // visible height in world pixels
    // Use actual grid size — world may have been expanded with gems
    const worldW = (bd?.[0]?.length ?? COLS) * BS;
    const worldH = (bd?.length        ?? ROWS) * BS;

    const targetCamX = (p.px + PW / 2) - vpW / 2;
    const targetCamY = (p.py + PH / 2) - vpH / 2;
    // Clamp so camera doesn't scroll past world edges
    const camX = Math.max(0, Math.min(worldW - vpW, targetCamX));
    const camY = Math.max(0, Math.min(worldH - vpH, targetCamY));
    camRef.current = { x: camX, y: camY };

    // ── CLEAR CANVAS ──────────────────────────────────────────────────────
    ctx.clearRect(0, 0, WW, WH);

    // ── SKY BACKGROUND (drawn before camera transform — always fills canvas) ──
    // Use Date.now() so the sky matches real-world time and is consistent
    // across all players in the same session (shared day/night cycle).
    const sky  = getSky(Date.now());
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) {
      // Night / deep dusk: use the dark sky color from getSky at top + near-black at bottom
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(1, "#04020a");
    } else {
      // Daytime / dawn / dusk transition: use the ACTUAL sky color from getSky.
      // During full day getSky returns r=135,g=206,b=235 (cornflower sky blue).
      // During dawn/dusk it returns warm orange/pink tones.
      // Gradient darkens slightly toward the horizon (bottom of sky band).
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(0.55, `rgb(${Math.round(sky.r * 0.78)},${Math.round(sky.g * 0.82)},${Math.round(sky.b * 0.88)})`);
      grad.addColorStop(1,    `rgb(${Math.round(sky.r * 0.55)},${Math.round(sky.g * 0.60)},${Math.round(sky.b * 0.68)})`);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WW, WH);

    // ── STARS (night only) ────────────────────────────────────────────────
    if (sky.stars && sky.alpha > 0.1) {
      const starAlpha = Math.min(1, (sky.alpha - 0.1) * 2);
      starsRef.current.forEach((s) => {
        const tw = 0.7 + 0.3 * Math.sin(now / 800 + s.twinkle);  // twinkle
        ctx.fillStyle = `rgba(255,255,255,${starAlpha * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // ── SUN / MOON ────────────────────────────────────────────────────────
    const t = (now % DAY_MS) / DAY_MS;
    if (sky.alpha < 0.4) {
      // Daytime: sun arc
      const sunAngle = t * Math.PI * 2 - Math.PI / 2;
      const sx = WW / 2 + Math.cos(sunAngle) * 320;
      const sy = WH * 0.5 + Math.sin(sunAngle) * 280;
      if (sy < WH * 0.55) {
        const sunGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28);
        sunGrad.addColorStop(0,   "rgba(255,240,100,1)");
        sunGrad.addColorStop(0.5, "rgba(255,180,0,0.8)");
        sunGrad.addColorStop(1,   "rgba(255,140,0,0)");
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, 28, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (sky.alpha > 0.5) {
      // Nighttime: crescent moon (filled circle with darker circle cut out)
      const moonAngle = (t + 0.5) * Math.PI * 2 - Math.PI / 2;
      const mx = WW / 2 + Math.cos(moonAngle) * 320;
      const my = WH * 0.5 + Math.sin(moonAngle) * 280;
      if (my < WH * 0.55) {
        ctx.fillStyle = "rgba(220,230,255,0.9)";
        ctx.beginPath(); ctx.arc(mx, my, 16, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(10,0,30,0.85)";
        ctx.beginPath(); ctx.arc(mx + 6, my - 4, 13, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ── APPLY CAMERA + ZOOM TRANSFORM ────────────────────────────────────
    // Everything below this save() is drawn in world space.
    // ctx.scale(zoom) makes 1 world pixel = zoom canvas pixels.
    // ctx.translate(-camX, -camY) shifts the origin so the camera position
    // appears at canvas (0,0).
    ctx.save();
    ctx.scale(zoom, zoom);
    ctx.translate(-camX, -camY);

    // ── BLOCKS ─────────────────────────────────────────────────────────────
    // dayFactor: 0.0 = full night, 1.0 = full sun.
    // Controls both solar panel power output AND sunlight intensity overlay.
    const dayFactor = Math.max(0, 1 - sky.alpha / 0.38);
    const lm        = lightMapRef.current;

    if (bd) {
      for (let gy = 0; gy < bd.length; gy++) {
        for (let gx = 0; gx < bd[gy].length; gx++) {
          const blk = bd[gy][gx];
          if (blk === "air") continue;

          // ── Machine blocks — special pixel-art rendering ───────────────
          if (blk === "machine_core") {
            // Powered only when BFS path reaches an exposed/daytime solar panel
            const powered = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawMachineCore(ctx, gx, gy, powered, now);

            // Overheat glow overlay — orange/red pulse when temperature is high
            if (overheatRef.current) {
              const pulse = 0.5 + 0.5 * Math.sin(now / 250);
              ctx.fillStyle = critHeatRef.current
                ? `rgba(220,30,0,${0.35 + pulse * 0.3})`
                : `rgba(255,120,0,${0.25 + pulse * 0.2})`;
              ctx.fillRect(gx * BS + 1, gy * BS + 1, BS - 2, BS - 2);
              // Overheat steam particles rising from the core
              const steamX = gx * BS + BS / 2 + (Math.random() - 0.5) * 10;
              const steamY = gy * BS + (1 - (now % 600) / 600) * BS;
              ctx.fillStyle = `rgba(200,200,255,${0.15 + Math.random() * 0.15})`;
              ctx.beginPath();
              ctx.arc(steamX, steamY, 3 + Math.random() * 3, 0, Math.PI * 2);
              ctx.fill();
            }

          } else if (blk === "solar_panel_block") {
            // Panel powered = wired to a cable AND has open sky AND is daytime
            const exposed = isSolarPanelExposed(bd, gx, gy, dayFactor);
            const wired   = isSolarPanelWired(bd, gx, gy);
            drawSolarPanel(ctx, gx, gy, exposed && wired, now);

            // No-sky warning: draw a red "blocked" X when panel has a roof
            if (!exposed && dayFactor > 0.15) {
              ctx.fillStyle = "rgba(220,40,40,0.55)";
              ctx.fillRect(gx * BS + 2, gy * BS + 2, BS - 4, BS - 4);
              ctx.strokeStyle = "rgba(255,80,80,0.9)";
              ctx.lineWidth   = 2;
              ctx.beginPath();
              ctx.moveTo(gx * BS + 6,        gy * BS + 6);
              ctx.lineTo(gx * BS + BS - 6,   gy * BS + BS - 6);
              ctx.moveTo(gx * BS + BS - 6,   gy * BS + 6);
              ctx.lineTo(gx * BS + 6,        gy * BS + BS - 6);
              ctx.stroke();
            }

          } else if (blk === "data_cable") {
            // Pipe active if BFS can reach it from an exposed solar panel
            const conn   = getPipeConns(bd, gx, gy);
            // A cable segment is "live" if it touches the powered network:
            // BFS the cable's position as if it were a core (same algorithm)
            const active = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawPipe(ctx, gx, gy, active, now, conn);

          } else if (blk === "lamp_block") {
            // Lamp lights up when connected to an active solar network via BFS
            const lit = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawLampBlock(ctx, gx, gy, lit, now);

          } else if (blk === "battery_block") {
            // Battery is "active" whenever it is part of any powered network.
            // Pass fuelPct (charge level) and conns (pipe wiring) for visual feedback.
            const charged  = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            const fuelPct  = Math.max(0, Math.min(1, (minerData?.fuel ?? 100) / 500));
            const conns    = getPipeConns(bd, gx, gy);
            drawBatteryBlock(ctx, gx, gy, charged, now, fuelPct, conns);

          } else if (blk === "generator_block") {
            // Generator shows fuel gauge + steam + pipe nubs for cable connections.
            const fuelPct  = Math.max(0, Math.min(1, (minerData?.fuel ?? 100) / 500));
            const genActive = (minerData?.fuel ?? 100) > 0;
            const conns    = getPipeConns(bd, gx, gy);
            drawGeneratorBlock(ctx, gx, gy, genActive, now, fuelPct, conns);

          } else if (blk === "mining_rig") {
            // Mining Rig — ASIC hardware block. Active when connected to power via BFS.
            // Each block placed = +1 TH (tracked server-side by scanMachineCluster).
            const rigActive = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawMiningRig(ctx, gx, gy, rigActive, now);

          } else if (blk === "fan_block") {
            // Cooling Fan — reduces temperature rise per server tick.
            // Shows as active (spinning) when part of a powered machine cluster.
            const fanActive = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawFanBlock(ctx, gx, gy, fanActive, now);

          } else if (blk === "clock_block") {
            // In-Game Clock — shows a live analog clock face mapped to the DAY_MS cycle.
            // Powered when the BFS power network reaches this block from an active source.
            const clockPowered = isCoreConnectedToPower(bd, gx, gy, dayFactor);
            drawClockBlock(ctx, gx, gy, clockPowered, now);

          } else if (blk === "block_oak_log") {
            // Oak log — dark brown trunk with vertical wood grain lines.
            // Breaks in 1 punch and drops oak_wood + 50% chance of a seed.
            ctx.fillStyle = "#92400e";
            ctx.fillRect(gx * BS, gy * BS, BS, BS);
            // Inner lighter heartwood strip
            ctx.fillStyle = "#a16207";
            ctx.fillRect(gx * BS + 5, gy * BS, BS - 10, BS);
            // Vertical grain lines
            ctx.fillStyle = "rgba(0,0,0,0.18)";
            for (let g = 0; g < 4; g++) {
              ctx.fillRect(gx * BS + 5 + g * 9, gy * BS, 2, BS);
            }
            // End-grain rings at top and bottom
            ctx.fillStyle = "rgba(180,110,30,0.45)";
            ctx.fillRect(gx * BS, gy * BS,           BS, 4);
            ctx.fillRect(gx * BS, gy * BS + BS - 4,  BS, 4);
            ctx.strokeStyle = "rgba(0,0,0,0.35)";
            ctx.lineWidth   = 1;
            ctx.strokeRect(gx * BS + 0.5, gy * BS + 0.5, BS - 1, BS - 1);

          } else if (blk === "block_oak_leaf") {
            // Oak leaf cluster — fluffy green canopy. Breaks in 1 punch, no drops.
            // Rendered as layered green squares with a slight checkerboard texture.
            ctx.fillStyle = "#15803d";
            ctx.fillRect(gx * BS, gy * BS, BS, BS);
            ctx.fillStyle = "#16a34a";
            ctx.fillRect(gx * BS + 3, gy * BS + 3, BS - 6, BS - 6);
            // Leaf texture: bright spots to look leafy
            ctx.fillStyle = "rgba(74,222,128,0.28)";
            for (let lxi = 0; lxi < 3; lxi++) {
              for (let lyi = 0; lyi < 3; lyi++) {
                if ((lxi + lyi) % 2 === 0) {
                  ctx.fillRect(gx * BS + 4 + lxi * 11, gy * BS + 4 + lyi * 11, 8, 8);
                }
              }
            }
            ctx.strokeStyle = "rgba(0,0,0,0.2)";
            ctx.lineWidth   = 1;
            ctx.strokeRect(gx * BS + 0.5, gy * BS + 0.5, BS - 1, BS - 1);

          } else if (blk === "platform_block") {
            // Platform block — one-way: players land on top, jump through from below.
            // Rendered as a thin wooden plank occupying only the lower half of the block,
            // leaving the upper half visually open to signal that it's passable.
            const pY = gy * BS + Math.round(BS * 0.38);   // plank starts 38% down
            const pH = Math.round(BS * 0.62);              // plank takes lower 62%
            // Plank body
            ctx.fillStyle = "#7c4e1e";
            ctx.fillRect(gx * BS, pY, BS, pH);
            // Top highlight edge — bright stripe signals "land here from above"
            ctx.fillStyle = "#b36b28";
            ctx.fillRect(gx * BS, pY, BS, 4);
            // Wood plank grain lines
            ctx.fillStyle = "rgba(0,0,0,0.15)";
            for (let g = 0; g < 3; g++) {
              ctx.fillRect(gx * BS + 7 + g * (BS - 14) / 2, pY + 5, 2, pH - 6);
            }
            ctx.strokeStyle = "rgba(0,0,0,0.3)";
            ctx.lineWidth   = 1;
            ctx.strokeRect(gx * BS + 0.5, pY + 0.5, BS - 1, pH - 1);

          } else {
            // Standard terrain block: base color + top highlight + border
            ctx.fillStyle = BLOCK_COLORS[blk] ?? "#1e293b";
            ctx.fillRect(gx * BS, gy * BS, BS, BS);

            const tint = BLOCK_TINTS[blk] ?? "rgba(255,255,255,0.07)";
            ctx.fillStyle = tint;
            ctx.fillRect(gx * BS + 1, gy * BS + 1, BS - 2, 5);

            ctx.strokeStyle = "rgba(0,0,0,0.4)";
            ctx.lineWidth   = 1;
            ctx.strokeRect(gx * BS + 0.5, gy * BS + 0.5, BS - 1, BS - 1);
          }

          // ── SUNLIGHT SHADOW OVERLAY (per block) ───────────────────────
          // During full daytime (dayFactor = 1) there is zero darkness —
          // sunlight illuminates everything. As the sun sets, nightFactor
          // rises from 0 → 1 and shadow builds up block by block.
          // Machine blocks emit their own glow so never go fully dark.
          if (lm) {
            const baseLight  = lm[gy]?.[gx] ?? 0.1;
            const isMachine  = MACHINE_BLOCKS.has(blk);
            // Machines glow so they're clamped to a minimum brightness
            const lightLevel = isMachine ? Math.max(0.35, baseLight) : baseLight;
            // nightFactor: 0 at noon (no shadow), 1 at midnight (full shadow)
            const nightFactor = 1 - dayFactor;
            // Underground shadow is proportional to depth AND how dark it is outside
            const baseDark   = (1 - lightLevel) * 0.88 * nightFactor;
            // Extra blanket darkness — scaled by (1-lightLevel) so lamp-lit
            // blocks are NOT smothered by ambient night darkness.
            // At lightLevel=1 (fully lit by lamp), nightBoost → 0.
            const nightBoost = nightFactor * 0.45 * (1 - lightLevel);
            const darkness   = Math.min(0.92, baseDark + nightBoost);
            if (darkness > 0.03) {
              ctx.fillStyle = `rgba(0,0,12,${darkness})`;
              ctx.fillRect(gx * BS, gy * BS, BS, BS);
            }
          }
        }
      }

      // ── CRACK OVERLAYS (on top of blocks) ─────────────────────────────
      breakingRef.current.forEach(({ hits, maxHits }, key) => {
        const [bxStr, byStr] = key.split(",");
        drawCracks(ctx, parseInt(bxStr), parseInt(byStr), hits / maxHits);
      });

      // ── PUNCH FLASH (brief white hit indicator, fades per frame) ──────
      flashRef.current.forEach((alpha, key) => {
        const [bxStr, byStr] = key.split(",");
        drawPunchFlash(ctx, parseInt(bxStr), parseInt(byStr), alpha);
        const next = alpha - 0.18;
        if (next <= 0) flashRef.current.delete(key);
        else           flashRef.current.set(key, next);
      });

      // ── WATER SPLASH ANIMATIONS ────────────────────────────────────────
      // Water bucket dropped on a machine core shows a blue splash + ripple.
      waterSplashRef.current.forEach((timeLeft, key) => {
        const [bxStr, byStr] = key.split(",");
        const splashAlpha    = timeLeft / 800;  // 1.0 fresh → 0.0 faded
        drawWaterSplash(ctx, parseInt(bxStr), parseInt(byStr), splashAlpha);
        const next = timeLeft - 16;
        if (next <= 0) waterSplashRef.current.delete(key);
        else           waterSplashRef.current.set(key, next);
      });
    }

    // ── PLAYER SPRITE ─────────────────────────────────────────────────────
    const { px, py, facingRight: fr } = p;

    // Body (dark green shirt)
    ctx.fillStyle = "#1e4d2b";
    ctx.fillRect(px + 5, py + 14, PW - 10, PH - 14);

    // Head (skin tone)
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(px + 3, py + 2, PW - 6, 14);

    // Eye (faces movement direction)
    ctx.fillStyle = "#000";
    ctx.fillRect(fr ? px + 13 : px + 5, py + 7, 4, 4);

    // Neon green eye glow
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(fr ? px + 14 : px + 6, py + 8, 2, 2);

    // Tool indicator in hand
    if (mode === "place" && selectedBlock && MACHINE_BLOCKS.has(selectedBlock)) {
      // Holding a machine component — show a small circuit-colored square
      ctx.fillStyle = "#22c55e";
      ctx.shadowColor = "#22c55e";
      ctx.shadowBlur  = 6;
      ctx.fillRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
      ctx.shadowBlur = 0;
    } else if (mode === "place" && selectedBlock) {
      // Holding a terrain block — show its color
      ctx.fillStyle = BLOCK_COLORS[selectedBlock] ?? "#aaa";
      ctx.fillRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth   = 1;
      ctx.strokeRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
    } else {
      // Pickaxe (gray shaft + darker head)
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(fr ? px + PW + 1 : px - 5, py + 16, 4, 14);
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(fr ? px + PW : px - 6,     py + 13, 6, 6);
    }

    // ── LAMP & LANTERN LIGHT HALOS (world space, before restore) ─────────
    // For every powered lamp_block or lantern_block in the grid, draw a warm
    // radial glow using globalCompositeOperation = "lighter" which ADDS light
    // on top of the per-block darkness, illuminating a radius around each lamp.
    // Lanterns use a warmer orange tone vs the lamp's cooler amber.
    if (bd) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";  // additive blend — brightens pixels below
      for (let gy = 0; gy < bd.length; gy++) {
        for (let gx = 0; gx < bd[gy].length; gx++) {
          const blkH = bd[gy][gx];
          const isLamp    = blkH === "lamp_block";
          const isLantern = blkH === "lantern_block";
          if (!isLamp && !isLantern) continue;
          const lit = isCoreConnectedToPower(bd, gx, gy, dayFactor);
          if (!lit) continue;

          const cx = gx * BS + BS / 2;   // world-space center of the light
          const cy = gy * BS + BS / 2;

          // Lantern is brighter and warmer than lamp (open flame vs enclosed bulb).
          // nightBoost scales halo alpha with the time of day:
          //   dayFactor = 1.0 (full sun) → nightBoost = 0.05  (barely visible glow)
          //   dayFactor = 0.0 (full night) → nightBoost = 1.0  (full brightness)
          // This prevents the halo from looking garish in daylight while ensuring
          // it actually illuminates the scene after the night overlay is applied.
          const nightBoost = Math.max(0.05, 1 - dayFactor);

          // Lamp halo radius: BS*10 for lamp, BS*6 for lantern.
          // Light map (LAMP_REACH=14) handles per-block brightness;
          // halo gives the warm visible glow that extends well beyond the source.
          const r     = isLantern ? BS * 6 : BS * 10;
          const pulse = isLantern
            ? 0.70 + 0.30 * Math.sin(now / 120 + gx * 1.7)  // flicker like a flame
            : 0.80 + 0.20 * Math.sin(now / 300);             // gentle breath for lamp

          const innerColor = isLantern
            ? `rgba(255,160,30,${0.70 * pulse * nightBoost})`
            : `rgba(255,215,100,${0.65 * pulse * nightBoost})`;
          const midColor   = isLantern
            ? `rgba(255,100,15,${0.40 * pulse * nightBoost})`
            : `rgba(255,175,55,${0.40 * pulse * nightBoost})`;
          const outerColor = isLantern
            ? `rgba(255,60,0,${0.10 * pulse * nightBoost})`
            : `rgba(255,140,20,${0.18 * pulse * nightBoost})`;

          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
          grad.addColorStop(0,    innerColor);
          grad.addColorStop(0.20, midColor);
          grad.addColorStop(0.55, outerColor);
          grad.addColorStop(1,    "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        }
      }
      ctx.restore();
    }

    // ── RESTORE from camera+zoom transform ───────────────────────────────
    ctx.restore();

    // ── NIGHT OVERLAY (applied after restore — covers full canvas) ────────
    if (sky.alpha > 0) {
      ctx.fillStyle = `rgba(0,0,20,${sky.alpha * 0.45})`;
      ctx.fillRect(0, 0, WW, WH);
    }

    // ── PLAYER HEALTH BAR (screen space, after night overlay) ─────────────
    // 90×8px green→amber→red bar at top-left showing current HP.
    // Always drawn on top of the night overlay so darkness never dims it.
    {
      const hpPct   = Math.max(0, physRef.current.hp / physRef.current.maxHp);
      const BAR_W   = 90, BAR_H = 8, BAR_X = 10, BAR_Y = 10;
      // Background fill
      ctx.fillStyle = "rgba(0,0,0,0.60)";
      ctx.fillRect(BAR_X - 2, BAR_Y - 2, BAR_W + 4, BAR_H + 4);
      // HP fill — green → amber → red
      ctx.fillStyle = hpPct > 0.5 ? "#22c55e" : hpPct > 0.25 ? "#f59e0b" : "#ef4444";
      const barFill = Math.max(0, Math.round(BAR_W * hpPct));
      if (barFill > 0) ctx.fillRect(BAR_X, BAR_Y, barFill, BAR_H);
      // Border
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth   = 1;
      ctx.strokeRect(BAR_X, BAR_Y, BAR_W, BAR_H);
      // "HP" label above the bar
      ctx.fillStyle   = "rgba(255,255,255,0.60)";
      ctx.font        = "7px monospace";
      ctx.fillText(`HP ${physRef.current.hp}`, BAR_X + 2, BAR_Y - 3);
    }

    // ── CRT SCANLINE EFFECT (very subtle retro texture) ───────────────────
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    for (let scanY = 0; scanY < WH; scanY += 4) {
      ctx.fillRect(0, scanY, WW, 2);
    }

    // ── MINIMAP — redrawn every 3 frames (~20fps) to keep CPU cost low ────
    // Each block in the world grid is mapped to a single pixel on an internal
    // canvas that matches the world dimensions. CSS then scales it up to 160×80
    // with pixelated rendering. The viewport rectangle and player dot are drawn
    // on top of the pixel image each update.
    minimapFrameRef.current = (minimapFrameRef.current + 1) % 3;
    if (minimapFrameRef.current === 0) {
      const mmCanvas = minimapRef.current;
      if (mmCanvas && bd) {
        const mmCtx = mmCanvas.getContext("2d");
        if (mmCtx) {
          const rows = bd.length;
          const cols = bd[0]?.length ?? 0;

          // Resize internal canvas to match world size — happens on world expand
          if (mmCanvas.width !== cols || mmCanvas.height !== rows) {
            mmCanvas.width  = cols;
            mmCanvas.height = rows;
          }

          // ── Block type → minimap RGB color ────────────────────────────────
          // Colors mirror the main BLOCK_COLORS palette so the minimap palette
          // feels intuitive to players who know the world renderer.
          const MM_COLORS: Record<string, [number, number, number]> = {
            block_grass:       [ 21, 128,  61],  // dark green surface
            block_dirt:        [120,  53,  15],  // earthy brown
            block_rock:        [ 55,  65,  81],  // dark slate gray
            block_iron:        [107, 114, 128],  // steel gray ore
            block_gold:        [180, 130,   9],  // warm gold ore
            block_diamond:     [ 14, 116, 144],  // cyan diamond ore
            block_lava:        [185,  28,  28],  // bright red hazard
            block_oak_log:     [146,  64,  14],  // brown wood trunk (matches BLOCK_COLORS)
            block_oak_sapling: [ 34, 197,  94],  // bright green sapling
            block_oak_leaf:    [ 22, 163,  74],  // medium green leaf canopy
            platform_block:    [ 92,  61,  30],  // brown wooden plank
            // Machine blocks glow bright so players can spot their rig at a glance
            machine_core:      [ 34, 197,  94],  // bright green — CPU block
            mining_rig:        [ 74, 222, 128],  // lighter green — ASIC hardware
            solar_panel_block: [234, 179,   8],  // yellow — solar power source
            data_cable:        [ 52, 211, 153],  // teal — data/power pipe
            lamp_block:        [245, 158,  11],  // amber — underground light
            battery_block:     [134, 239, 172],  // pale green — energy storage
            generator_block:   [249, 115,  22],  // orange — diesel generator
            fan_block:         [ 34, 211, 238],  // cyan — cooling fan
          };

          // Precompute surface row per column so we can distinguish sky air
          // (above first solid block) from underground air (enclosed caves).
          // Sky shows as a pale blue, caves as a near-black void.
          const surfaceRow = new Uint16Array(cols).fill(rows);
          for (let gx = 0; gx < cols; gx++) {
            for (let gy = 0; gy < rows; gy++) {
              if (bd[gy][gx] !== "air") { surfaceRow[gx] = gy; break; }
            }
          }

          // Draw each block as 1 pixel using ImageData (fastest method — no
          // per-call canvas API overhead, single putImageData flush at the end)
          const imgData = mmCtx.createImageData(cols, rows);
          const data    = imgData.data;

          for (let gy = 0; gy < rows; gy++) {
            for (let gx = 0; gx < cols; gx++) {
              const blk = bd[gy][gx];
              let r: number, g: number, b: number;
              if (blk === "air") {
                // Sky air (above surface): pale blue — makes terrain contour readable
                // Underground air (caves): near-black void
                if (gy < surfaceRow[gx]) { r = 30;  g = 55;  b = 100; }
                else                     { r = 8;   g = 10;  b = 28;  }
              } else {
                const c = MM_COLORS[blk];
                if (c) { r = c[0]; g = c[1]; b = c[2]; }
                else   { r = 80;   g = 80;   b = 90; }  // unknown — dim gray
              }
              const idx   = (gy * cols + gx) * 4;
              data[idx]   = r;
              data[idx+1] = g;
              data[idx+2] = b;
              data[idx+3] = 255;
            }
          }
          mmCtx.putImageData(imgData, 0, 0);

          // ── Viewport rectangle — white outline of what the camera sees ────
          // camRef.current was updated this frame (line ~1420) so it is current.
          const vx = camRef.current.x / BS;
          const vy = camRef.current.y / BS;
          const vw = (WW / zoom)       / BS;
          const vh = (WH / zoom)       / BS;
          mmCtx.strokeStyle = "rgba(255,255,255,0.80)";
          mmCtx.lineWidth   = 0.5;
          mmCtx.strokeRect(vx, vy, vw, vh);

          // ── Player dot — 2×2 white square at the player's grid position ───
          const ppx = physRef.current.px / BS;
          const ppy = physRef.current.py / BS;
          mmCtx.fillStyle = "#ffffff";
          mmCtx.fillRect(ppx - 0.5, ppy - 0.5, 2, 2);
        }
      }
    }

    // Schedule next frame
    rafRef.current = requestAnimationFrame(drawFrame);
  }, [solid, mode, selectedBlock]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: start / restart the game loop
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    lastTRef.current = performance.now();
    rafRef.current   = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: keyboard controls (WASD / Arrow keys / Space)
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      const p = physRef.current;

      // Horizontal movement
      if (["ArrowLeft",  "a", "A"].includes(e.key)) { p.vx = -MOVE_SPEED; p.facingRight = false; }
      if (["ArrowRight", "d", "D"].includes(e.key)) { p.vx =  MOVE_SPEED; p.facingRight = true;  }

      // Jump — only from ground
      if ([" ", "ArrowUp", "w", "W"].includes(e.key) && p.onGround) {
        p.vy = JUMP_VY;
        p.onGround = false;
        e.preventDefault();  // prevent page scroll on Space
      }
    };

    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      const keys = keysRef.current;
      // Stop if no horizontal keys still held
      const goLeft  = keys.has("ArrowLeft")  || keys.has("a") || keys.has("A");
      const goRight = keys.has("ArrowRight") || keys.has("d") || keys.has("D");
      if      (!goLeft && !goRight) physRef.current.vx = 0;
      else if (goLeft)              { physRef.current.vx = -MOVE_SPEED; physRef.current.facingRight = false; }
      else                          { physRef.current.vx =  MOVE_SPEED; physRef.current.facingRight = true;  }
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup",   up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup",   up);
    };
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // Zoom handler — called by scroll wheel and zoom buttons
  // ════════════════════════════════════════════════════════════════════════
  const adjustZoom = useCallback((delta: number) => {
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current + delta));
    zoomRef.current = newZoom;
    setZoomDisplay(newZoom);  // update UI label
  }, []);

  // Scroll wheel zoom (desktop) — preventDefault stops page from scrolling instead
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      adjustZoom(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [adjustZoom]);

  // Pinch-to-zoom (mobile) — two-finger pinch gesture on the canvas
  // We capture the initial distance + zoom level when the second finger touches,
  // then scale zoom proportionally as the fingers spread or squeeze.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Distance between two touch points (Pythagorean)
    const getTouchDist = (touches: TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    let initDist = 0;   // finger distance at start of pinch
    let initZoom = 1;   // zoom level at start of pinch

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // Two fingers just placed — record baseline for this pinch gesture
        initDist = getTouchDist(e.touches);
        initZoom = zoomRef.current;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault(); // stop browser native pinch-zoom from taking over
        const dist  = getTouchDist(e.touches);
        const scale = dist / initDist;   // > 1 = spreading (zoom in), < 1 = pinching (zoom out)
        const newZ  = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, initZoom * scale));
        zoomRef.current = newZ;
        setZoomDisplay(newZ);
      }
    };

    // passive: false so we can call preventDefault() inside onTouchMove
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove",  onTouchMove,  { passive: false });
    return () => {
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove",  onTouchMove);
    };
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // Canvas click handler — mine blocks OR place blocks
  // Click coordinates must be converted through zoom + camera to world coords.
  // ════════════════════════════════════════════════════════════════════════
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    const zoom = zoomRef.current;
    const cam  = camRef.current;

    // Convert screen → logical canvas (handles CSS scaling)
    const logicalX = ((e.clientX - rect.left)  / rect.width)  * WW;
    const logicalY = ((e.clientY - rect.top)   / rect.height) * WH;

    // Convert logical canvas → world pixel → world block coordinate
    const worldX = logicalX / zoom + cam.x;
    const worldY = logicalY / zoom + cam.y;
    const bx     = Math.floor(worldX / BS);
    const by     = Math.floor(worldY / BS);

    const bd = worldRef.current;
    if (!bd) return;
    if (bx < 0 || by < 0 || bx >= bd[0].length || by >= bd.length) return;

    // Distance check: player must be within reach
    const p   = physRef.current;
    const pcx = (p.px + PW / 2) / BS;
    const pcy = (p.py + PH / 2) / BS;
    const dist = Math.sqrt((bx - pcx) ** 2 + (by - pcy) ** 2);

    if (dist > REACH) {
      toast({
        title: "OUT OF REACH",
        description: "Move closer to mine or place.",
        className: "bg-black border-border text-muted-foreground font-mono text-xs",
      });
      return;
    }

    // ── WORLD LOCK CHECK ─────────────────────────────────────────────────────
    // If the world is locked and the current player is NOT the owner, block all
    // break/place actions. Visiting is still allowed (read-only exploration).
    const currentNumericId = parseInt(userId ?? "0") || 0;
    if (worldLocked && currentNumericId !== (worldOwnerId ?? -1)) {
      toast({
        title: "🔒 WORLD LOCKED",
        description: "This world is private. Only the owner can build here.",
        className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs",
      });
      return;
    }

    // ── USE ITEM HANDLERS ─────────────────────────────────────────────────────
    // When a use-item is equipped (thermal_paste / water_bucket / diesel_can),
    // the click applies the item effect and never breaks the block.

    // ── THERMAL PASTE — tap machine_core to lower temperature ─────────────────
    if (selectedUseItem === "thermal_paste") {
      if (bd[by][bx] !== "machine_core") {
        toast({ title: "WRONG TARGET", description: "Tap the Machine Core to apply thermal paste.", className: "bg-black border-orange-500 text-orange-400 font-mono text-xs" });
        return;
      }
      maintainMiner.mutate(
        { data: { type: "thermal_paste" } },
        {
          onSuccess: () => {
            toast({ title: "🧴 PASTE APPLIED", description: "Temperature reduced — rig cooling down.", className: "bg-black border-primary text-primary font-mono text-xs" });
            setSelectedUseItem(null);
            refetchInventory();
          },
          onError: (err: unknown) => {
            const msg = (err as { data?: { message?: string } })?.data?.message ?? "No thermal paste in inventory.";
            toast({ title: "APPLY FAILED", description: msg, variant: "destructive" });
          },
        }
      );
      return;
    }

    // ── DIESEL CAN — tap generator or battery block to refuel ─────────────────
    if (selectedUseItem === "diesel_can") {
      const tgt = bd[by][bx];
      if (tgt !== "generator_block" && tgt !== "battery_block") {
        toast({ title: "WRONG TARGET", description: "Tap a Generator or Battery Block to refuel.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }
      gameAction.mutate(
        { data: { actionType: "refuel", worldName, x: bx, y: by } },
        {
          onSuccess: (data) => {
            if ((data as { success?: boolean }).success) {
              toast({ title: "⛽ REFUELED", description: "Generator fuel +100.", className: "bg-black border-yellow-400 text-yellow-300 font-mono text-xs" });
              setSelectedUseItem(null);
            } else {
              toast({ title: "REFUEL FAILED", description: (data as { error?: string }).error ?? "No diesel can.", variant: "destructive" });
            }
            refetchInventory();
          },
        }
      );
      return;
    }

    // ── WATER BUCKET — tap machine_core for a large cooling flush ─────────────
    if (selectedUseItem === "water_bucket") {
      if (bd[by][bx] !== "machine_core") {
        toast({ title: "WRONG TARGET", description: "Tap the Machine Core to cool it with water.", className: "bg-black border-blue-500 text-blue-400 font-mono text-xs" });
        return;
      }
      const splashKey = `${bx},${by}`;
      waterSplashRef.current.set(splashKey, 800);
      toast({ title: "💧 COOLING FLUSH", description: "Water applied — temperature dropping!", className: "bg-black border-blue-400 text-blue-300 font-mono text-xs" });
      maintainMiner.mutate(
        { data: { type: "flush_cooling" } },
        {
          onSuccess: () => {
            setSelectedUseItem(null);
            refetchInventory();
          },
        }
      );
      return;
    }

    // ── SEED PLANTING — seed_oak triggers the "plant" action (not "place") ──
    // Unlike regular blocks, seeds use a special server action that validates
    // ground underneath and tracks sapling growth timers server-side.
    if (mode === "place" && selectedBlock === "seed_oak") {
      if (bd[by][bx] !== "air") {
        toast({ title: "BLOCKED", description: "Plant in an empty space above solid ground.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }
      if ((bd[by + 1]?.[bx] ?? "air") === "air") {
        toast({ title: "NO GROUND", description: "Must plant on solid ground — step to an open patch of dirt or grass.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }
      // Optimistic: show sapling immediately
      const updatedP = bd.map((row) => [...row]);
      updatedP[by][bx] = "block_oak_sapling";
      worldRef.current = updatedP;
      const plantKey = `${bx},${by}`;
      saplingTimersRef.current.set(plantKey, Date.now());
      gameAction.mutate(
        { data: { actionType: "plant" as never, worldName, x: bx, y: by } },
        {
          onSuccess: (data) => {
            if (!(data as { success?: boolean }).success) {
              worldRef.current = bd;
              saplingTimersRef.current.delete(plantKey);
              toast({ title: "CAN'T PLANT HERE", variant: "destructive" });
            } else {
              refetchInventory();
              toast({ title: "🌱 PLANTED!", description: "Sapling grows in ~15 seconds → oak wood + seed.", className: "bg-black border-green-500 text-green-400 font-mono text-xs" });
            }
          },
          onError: () => { worldRef.current = bd; saplingTimersRef.current.delete(plantKey); },
        }
      );
      return;
    }

    // ── PLACE MODE ────────────────────────────────────────────────────────
    if (mode === "place" && selectedBlock) {
      if (bd[by][bx] !== "air") {
        toast({ title: "BLOCKED", description: "That space is occupied.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }

      // Optimistically update local world grid for instant feedback
      const updated = bd.map((row) => [...row]);
      updated[by][bx] = selectedBlock;
      worldRef.current = updated;

      gameAction.mutate(
        { data: { actionType: "place", worldName, x: bx, y: by, placeBlock: selectedBlock } },
        {
          onSuccess: (data) => {
            if (data.success) {
              // Show contextual tip when machine blocks are placed
              if ((data as { machineUpdated?: boolean }).machineUpdated) {
                // Give build-order guidance based on which machine block was just placed
                const guide =
                  selectedBlock === "machine_core"  ? "Now add Mining Rig + Solar Panel blocks adjacent to the Core!" :
                  selectedBlock === "mining_rig"     ? "Connect to a Machine Core + Solar Panel via Data Cables!" :
                  selectedBlock === "solar_panel_block" ? "Connect to a Machine Core with Data Cables to power rigs!" :
                  "Machine structure changed — check your Miner!";
                toast({
                  title: "⚡ RIG UPDATED",
                  description: guide,
                  className: "bg-black border-primary text-primary font-mono text-xs",
                });
              }
              refetchWorld();
              refetchInventory();
            } else {
              worldRef.current = bd;  // revert optimistic
              toast({ title: "PLACE FAILED", variant: "destructive" });
            }
          },
          onError: () => { worldRef.current = bd; },
        }
      );
      return;
    }

    // ── MACHINE BLOCK PUNCH → show structure status popup ─────────────────────
    // Clicking a machine block in punch mode (with no use item selected) shows
    // the StructurePopup rather than mining it. The popup has a "Break Block"
    // button for intentional disassembly.
    if (bd[by][bx] !== "air" && MACHINE_BLOCKS.has(bd[by][bx])) {
      setStructurePopup({ bx, by, blockType: bd[by][bx] });
      return;
    }

    // ── PUNCH MODE ────────────────────────────────────────────────────────
    if (bd[by][bx] === "air") return;

    const key     = `${bx},${by}`;
    const blkType = bd[by][bx];
    const maxHits = BLOCK_HITS[blkType] ?? 3;
    const current = breakingRef.current.get(key) ?? { hits: 0, maxHits };

    flashRef.current.set(key, 1.0);              // trigger punch flash
    physRef.current.facingRight = bx >= pcx;    // face the block being punched

    const newHits = current.hits + 1;

    if (newHits >= maxHits) {
      // Block is fully broken — send to server
      if (pendingBreakRef.current) return;
      pendingBreakRef.current = true;
      breakingRef.current.delete(key);

      // Optimistic: remove block immediately
      const updated = bd.map((row) => [...row]);
      updated[by][bx] = "air";
      worldRef.current = updated;

      gameAction.mutate(
        { data: { actionType: "break", worldName, x: bx, y: by } },
        {
          onSuccess: (data) => {
            pendingBreakRef.current = false;
            if (data.wizardChallenge) { setWizard(true); return; }
            if (data.success) {
              const resp = data as typeof data & { gemsGained?: number; dropQty?: number; selfQty?: number };

              // ── Optimistic gem counter update ──────────────────────────────
              // Update the wallet cache immediately so the HUD gem count ticks
              // up the moment the server confirms the break — no refetch needed.
              const gained = resp.gemsGained ?? 0;
              if (gained > 0) {
                queryClient.setQueryData(
                  getGetWalletQueryKey(),
                  (old: { gems?: number; actionCount?: number } | undefined) =>
                    old ? { ...old, gems: (old.gems ?? 0) + gained } : old
                );
              }

              // ── Drop toast — show quantity when > 1 ───────────────────────
              // selfQty: how many of the block itself came back (e.g. 3 dirt)
              // dropQty: how many of the secondary item dropped (usually 1 ore)
              const selfQty = resp.selfQty ?? 0;
              const dropQty = resp.dropQty ?? 1;
              if (selfQty > 1) {
                // e.g. "+3 DIRT" when dirt rolls 3 on the 1–5 range
                toast({
                  title: `+${selfQty} ${blkType.replace("block_", "").toUpperCase().replace(/_/g, " ")}`,
                  className: "border-yellow-500 bg-black text-yellow-300 font-mono uppercase text-xs",
                });
              } else if (data.dropItem) {
                const label = data.dropItem.toUpperCase().replace(/_/g, " ");
                toast({
                  title: dropQty > 1 ? `+${dropQty} ${label}` : `+1 ${label}`,
                  className: "border-primary bg-black text-primary font-mono uppercase text-xs",
                });
              }

              refetchWorld();
              refetchInventory();
            }
          },
          onError: () => {
            pendingBreakRef.current = false;
            worldRef.current = bd;  // revert on error
          },
        }
      );
    } else {
      // Record hit progress (crack animation)
      breakingRef.current.set(key, { hits: newHits, maxHits });
    }
  }, [mode, selectedBlock, selectedUseItem, setSelectedUseItem, setStructurePopup, maintainMiner, gameAction, refetchWorld, refetchInventory, toast]);

  // Clear crack state when world refreshes (blocks reset)
  useEffect(() => { breakingRef.current.clear(); }, [world]);

  // ── Sapling growth timer ─────────────────────────────────────────────────
  // Checks every second whether any planted sapling is ≥15s old.
  // When mature, sends the "grow" action to the server which converts the
  // block_oak_sapling to block_oak_log (2 blocks tall if space allows).
  useEffect(() => {
    const interval = setInterval(() => {
      const bd = worldRef.current;
      if (!bd) return;
      const timers = saplingTimersRef.current;
      timers.forEach((plantedAt, key) => {
        if (Date.now() - plantedAt < 15_000) return;  // not ready yet
        const [bxStr, byStr] = key.split(",");
        const bx = parseInt(bxStr, 10);
        const by = parseInt(byStr, 10);
        // If the sapling was already broken or grown, discard the timer
        if (bd[by]?.[bx] !== "block_oak_sapling") { timers.delete(key); return; }
        timers.delete(key);
        // Optimistic update: show the grown log immediately
        const updated = bd.map((r) => [...r]);
        updated[by][bx] = "block_oak_log";
        if (by > 0 && updated[by - 1]?.[bx] === "air") updated[by - 1][bx] = "block_oak_log";
        worldRef.current = updated;
        gameAction.mutate(
          { data: { actionType: "grow" as never, worldName, x: bx, y: by } },
          {
            onSuccess: () => refetchWorld(),
            onError:   () => { worldRef.current = bd; },
          }
        );
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [gameAction, refetchWorld]);

  // ════════════════════════════════════════════════════════════════════════
  // Joystick pointer handlers — drives player movement + jump
  // The joystick base is centred in its div; thumb clamped to JOYSTICK_R.
  // Horizontal displacement → velocity; upward pull → jump.
  // ════════════════════════════════════════════════════════════════════════
  const handleJoystickDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);  // lock pointer to this div
    joystickActiveRef.current = true;
    const rect = e.currentTarget.getBoundingClientRect();
    joystickBaseRef.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }, []);

  const handleJoystickMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!joystickActiveRef.current) return;
    const base = joystickBaseRef.current;
    const dx   = e.clientX - base.x;
    const dy   = e.clientY - base.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Clamp thumb within joystick radius
    const cx   = dist > JOYSTICK_R ? (dx / dist) * JOYSTICK_R : dx;
    const cy   = dist > JOYSTICK_R ? (dy / dist) * JOYSTICK_R : dy;
    setJoystickThumb({ x: cx, y: cy });

    // Drive player — dead zone of 6px to avoid drift when thumb is centred
    const p = physRef.current;
    if      (cx < -6) { p.vx = -MOVE_SPEED * Math.min(1, Math.abs(cx) / JOYSTICK_R); p.facingRight = false; }
    else if (cx >  6) { p.vx =  MOVE_SPEED * Math.min(1, cx / JOYSTICK_R);            p.facingRight = true;  }
    else              { p.vx = 0; }

    // Jump: drag thumb upward past 40% of radius
    if (cy < -JOYSTICK_R * 0.40 && p.onGround) {
      p.vy = JUMP_VY;
      p.onGround = false;
    }
  }, [JOYSTICK_R]);

  const handleJoystickUp = useCallback(() => {
    joystickActiveRef.current = false;
    setJoystickThumb({ x: 0, y: 0 });
    physRef.current.vx = 0;   // stop when thumb released
  }, []);

  // ── Hotbar: placeable items from inventory (terrain + machine blocks) ────
  const hotbarItems = inventory.filter((i) => PLACEABLE.has(i.itemId) && i.quantity > 0);

  // ── Water bucket indicator from inventory ────────────────────────────────
  const hasWaterBucket = inventory.some((i) => i.itemId === "water_bucket" && i.quantity > 0);

  // ── Diesel can indicator — enables the direct Refuel button in StructurePopup ──
  // Checked against live inventory so it updates immediately after a purchase.
  const hasDieselCan = inventory.some((i) => i.itemId === "diesel_can" && i.quantity > 0);

  // Helper: shared style for on-screen control buttons
  const ctrlBtn = "select-none touch-none transition-all active:scale-90";

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  return (
    // CSS Grid layout: 4 named rows.
    //   Row 1 (auto)  — TopHUD bar
    //   Row 2 (1fr)   — canvas + chat; 1fr fills ALL remaining space
    //   Row 3 (auto)  — controls bar (movement buttons, etc.)
    //   Row 4 (auto)  — hotbar strip
    //
    // Using CSS Grid (not flex-col) because flex-col cannot give the canvas
    // row a "remaining height after fixed rows" without flex-grow conflicts.
    // With Grid, the 1fr row is exactly: total height − sum of auto rows.
    // height: 100% is explicit so the grid has a definite size to divide.
    <motion.div
      ref={gameRef}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="flex-1 min-h-0 bg-background overflow-hidden flex flex-col"
    >

      {/* ── TOP HUD ────────────────────────────────────────────────────── */}
      <div ref={topHudRef} className="flex justify-between items-center px-3 py-1.5 bg-sidebar/95 border-b border-border z-10 shrink-0 gap-2">

        {/* Player callsign badge */}
        <div className="flex items-center gap-2 font-mono text-xs">
          <div className="bg-black/50 px-2 py-1 rounded border border-primary/20">
            <span className="text-muted-foreground uppercase block leading-none text-[10px] mb-0.5">Callsign</span>
            <span className="text-white font-bold">{username}</span>
          </div>
        </div>

        {/* Right: stats + chat toggle */}
        <div className="flex items-center gap-1.5">

          {/* Mode indicator pill */}
          <div
            className={`px-2 py-1 rounded border font-mono text-[10px] font-bold uppercase cursor-pointer transition-colors ${
              mode === "punch"
                ? "border-red-600 text-red-400 bg-red-600/10"
                : "border-blue-500 text-blue-400 bg-blue-500/10"
            }`}
            onClick={() => {
              if (mode === "punch") { setMode("place"); }
              else { setMode("punch"); setSelectedBlock(null); }
            }}
            title="Click to toggle Punch/Place mode"
          >
            {mode === "punch" ? "👊 PUNCH" : "🧱 PLACE"}
          </div>

          {/* Energy counter */}
          <div className="bg-black/50 px-2 py-1 rounded border border-accent/30 text-xs font-mono hidden sm:block">
            <span className="text-muted-foreground uppercase block leading-none text-[10px] mb-0.5">Energy</span>
            <div className="flex items-center text-accent font-bold">
              <Zap className="w-3 h-3 mr-0.5" />{wallet?.actionCount ?? 0}/100
            </div>
          </div>

          {/* Gems */}
          <div className="bg-black/50 px-2 py-1 rounded border border-primary/30 text-xs font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[10px] mb-0.5">Gems</span>
            <span className="text-primary font-bold">{wallet?.gems ?? 0} 💎</span>
          </div>

          {/* Current world name badge — clicking navigates back to WorldSelect. */}
          {/* Lock icon shown when the world is locked (visible to all players).  */}
          <button
            onClick={() => { history.back(); }}
            className="hidden sm:flex items-center gap-1 px-2 py-1 rounded border border-primary/30 font-mono text-[10px] font-bold uppercase text-primary/70 hover:border-primary hover:text-primary transition-colors max-w-[110px] truncate"
            title={`Current world: ${worldName}${worldLocked ? " (LOCKED)" : ""} — click to switch`}
          >
            {worldLocked ? "🔒" : "🌍"} {worldName}
          </button>

          {/* ── World Lock / Unlock button ────────────────────────────────────
               Visible only to the world owner (or to anyone if world is unlocked
               and they have a World Lock item in their inventory).
               Calls POST /api/world/:name/lock or /unlock and updates local state. */}
          {(() => {
            const currentNumId = parseInt(userId ?? "0") || 0;
            const isOwner      = worldOwnerId === currentNumId || worldOwnerId === null;
            if (!isOwner && !worldLocked) return null; // non-owner, unlocked = nothing to show
            if (!isOwner && worldLocked)  return null; // non-owner can't unlock
            return (
              <button
                className={`hidden sm:flex items-center gap-1 px-2 py-1 rounded border font-mono text-[10px] font-bold uppercase transition-colors ${
                  worldLocked
                    ? "border-yellow-500/60 text-yellow-400 hover:bg-yellow-500/10"
                    : "border-border text-muted-foreground hover:border-yellow-500/60 hover:text-yellow-400"
                }`}
                title={worldLocked ? "Click to unlock world (owner only)" : "Click to lock world (costs 1 World Lock from inventory)"}
                onClick={async () => {
                  const action = worldLocked ? "unlock" : "lock";
                  try {
                    const resp = await fetch(`/api/world/${encodeURIComponent(worldName)}/${action}`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", "x-user-id": userId ?? "" },
                    });
                    const json = await resp.json();
                    if (json.success) {
                      setWorldLocked(json.locked);
                      toast({ title: json.locked ? "🔒 WORLD LOCKED" : "🔓 WORLD UNLOCKED", description: json.message, className: "bg-black border-yellow-500 text-yellow-300 font-mono text-xs" });
                    } else {
                      toast({ title: "FAILED", description: json.error ?? "Could not change lock.", variant: "destructive" });
                    }
                  } catch {
                    toast({ title: "NETWORK ERROR", description: "Could not reach server.", variant: "destructive" });
                  }
                }}
              >
                {worldLocked ? "🔓 Unlock" : "🔒 Lock"}
              </button>
            );
          })()}

          {/* ── Floating window toggles (Miner / Inventory / Store / Leaderboard) ──
               Hidden on mobile — those pages are reachable via the bottom nav tab bar.
               Shown on sm+ where floating overlays make sense alongside the canvas.  */}
          <div className="hidden sm:flex items-center gap-1.5">
            <button
              onClick={() => { setShowMinerWin(s => !s); setShowInvWin(false); setShowStoreWin(false); setShowLeadWin(false); }}
              className={`p-1.5 rounded border transition-colors ${showMinerWin ? "border-accent text-accent bg-accent/10" : "border-border text-muted-foreground hover:text-accent"}`}
              title="Toggle Miner window"
            ><Server className="w-3.5 h-3.5" /></button>
            <button
              onClick={() => { setShowInvWin(s => !s); setShowMinerWin(false); setShowStoreWin(false); setShowLeadWin(false); }}
              className={`p-1.5 rounded border transition-colors ${showInvWin ? "border-white text-white bg-white/10" : "border-border text-muted-foreground hover:text-white"}`}
              title="Toggle Inventory window"
            ><Package className="w-3.5 h-3.5" /></button>
            <button
              onClick={() => { setShowStoreWin(s => !s); setShowMinerWin(false); setShowInvWin(false); setShowLeadWin(false); }}
              className={`p-1.5 rounded border transition-colors ${showStoreWin ? "border-accent text-accent bg-accent/10" : "border-border text-muted-foreground hover:text-accent"}`}
              title="Toggle Store window"
            ><ShoppingCart className="w-3.5 h-3.5" /></button>
            <button
              onClick={() => { setShowLeadWin(s => !s); setShowMinerWin(false); setShowInvWin(false); setShowStoreWin(false); }}
              className={`p-1.5 rounded border transition-colors ${showLeadWin ? "border-accent text-accent bg-accent/10" : "border-border text-muted-foreground hover:text-accent"}`}
              title="Toggle Leaderboard window"
            ><Trophy className="w-3.5 h-3.5" /></button>
          </div>

          {/* Chat toggle */}
          <button
            onClick={() => setChatOpen((s) => !s)}
            className={`p-1.5 rounded border transition-colors ${
              chatOpen ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-primary"
            }`}
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── CANVAS + CHAT PANEL ─────────────────────────────────────────── */}
      {/* flex: 1 1 0% means flex-basis=0 so this starts at ZERO height   */}
      {/* and grows to fill all remaining space. flex-basis:0 is critical  */}
      {/* because it prevents the canvas's 800×600 HTML intrinsic size    */}
      {/* from leaking into the flex algorithm as the item's "natural"    */}
      {/* height. All other rows have shrink-0, so this row = remainder.  */}
      <div className="flex overflow-hidden" style={{ flex: "1 1 0%", minHeight: 0 }}>

        {/* ── Canvas container — flex center so canvas stays at its natural    */}
        {/* aspect ratio (800×600 = 4:3). On portrait mobile this prevents the */}
        {/* canvas from stretching vertically when the container is taller than */}
        {/* wide. Letterboxing (black bars) keep the game looking correct.      */}
        {/* Click coords are normalized via getBoundingClientRect so they work  */}
        {/* correctly regardless of how big or small the canvas is rendered.    */}
        <div className="flex-1 min-h-0 bg-[#050d14] overflow-hidden relative flex items-center justify-center">
          <canvas
            ref={canvasRef}
            width={WW}
            height={WH}
            onClick={handleCanvasClick}
            className="block"
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              width: "auto",
              height: "auto",
              aspectRatio: `${WW} / ${WH}`,
              imageRendering: "pixelated",
              cursor: mode === "place" ? "cell" : "crosshair",
            }}
          />

          {/* ── VIRTUAL JOYSTICK OVERLAY ─────────────────────────────────── */}
          {/* Positioned absolute bottom-left of the canvas container.       */}
          {/* Pointer capture keeps tracking even if finger leaves the div.  */}
          <div
            className="absolute bottom-4 left-4 z-20 select-none touch-none"
            style={{ width: 90, height: 90, touchAction: "none" }}
            onPointerDown={handleJoystickDown}
            onPointerMove={handleJoystickMove}
            onPointerUp={handleJoystickUp}
            onPointerCancel={handleJoystickUp}
          >
            {/* Base ring — semi-transparent dark circle with green outline */}
            <svg width="90" height="90" className="absolute inset-0 pointer-events-none">
              {/* Outer glow ring */}
              <circle cx="45" cy="45" r="43"
                fill="rgba(0,0,0,0.55)"
                stroke="rgba(34,197,94,0.35)"
                strokeWidth="2" />
              {/* Inner dead-zone indicator ring */}
              <circle cx="45" cy="45" r="10"
                fill="none"
                stroke="rgba(34,197,94,0.15)"
                strokeWidth="1" />
              {/* Cardinal direction arrows */}
              <text x="45" y="13" textAnchor="middle" fill="rgba(34,197,94,0.7)" fontSize="11" fontFamily="monospace">▲</text>
              <text x="45" y="84" textAnchor="middle" fill="rgba(34,197,94,0.3)" fontSize="11" fontFamily="monospace">▼</text>
              <text x="9"  y="50" textAnchor="middle" fill="rgba(34,197,94,0.7)" fontSize="11" fontFamily="monospace">◀</text>
              <text x="81" y="50" textAnchor="middle" fill="rgba(34,197,94,0.7)" fontSize="11" fontFamily="monospace">▶</text>
            </svg>

            {/* Draggable thumb — slides within the base */}
            <div
              className="absolute rounded-full border-2 pointer-events-none"
              style={{
                width:  34,
                height: 34,
                left:   45 - 17 + joystickThumb.x,
                top:    45 - 17 + joystickThumb.y,
                background:  "radial-gradient(circle at 40% 35%, rgba(34,197,94,0.55), rgba(10,60,20,0.8))",
                borderColor: joystickActiveRef.current ? "rgba(34,197,94,0.9)" : "rgba(34,197,94,0.5)",
                boxShadow:   joystickActiveRef.current ? "0 0 12px rgba(34,197,94,0.6)" : "none",
                transition:  joystickActiveRef.current ? "none" : "left 0.1s, top 0.1s",
              }}
            />
          </div>

          {/* ── Solar power status badge (top-right of canvas) ───────────── */}
          {/* isDay state updates every 3s and uses the same dayFactor       */}
          {/* formula as the canvas renderer — badge always matches reality. */}
          <div className={`absolute top-2 right-2 z-10 px-2 py-1 rounded border font-mono text-[9px] font-bold ${
            isDay
              ? "border-yellow-500/50 text-yellow-300 bg-black/70"
              : "border-zinc-600 text-zinc-400 bg-black/70"
          }`}>
            {isDay ? "☀ SOLAR ACTIVE" : "🌙 NIGHT — no solar"}
          </div>

          {/* ── MINIMAP OVERLAY — bottom-right corner ────────────────────── */}
          {/* The internal canvas is 1px per block; CSS scales it up to      */}
          {/* 160×80 with pixelated rendering so each pixel stays crisp.     */}
          {/* drawFrame redraws it every 3 frames (~20fps). Toggle with MAP. */}
          <div className="absolute bottom-4 right-3 z-20 flex flex-col items-end gap-1">
            {/* MAP toggle button — sits above the minimap */}
            <button
              onClick={() => setShowMinimap((v) => !v)}
              className="font-mono text-[8px] px-1.5 py-0.5 rounded border border-primary/40 text-primary/70 bg-black/70 hover:bg-primary/10 leading-none tracking-widest"
              title="Toggle minimap"
            >
              {showMinimap ? "MAP ▾" : "MAP ▸"}
            </button>

            {showMinimap && (
              /* Dark framed panel wrapping the canvas + legend */
              <div
                style={{
                  background:   "rgba(0,0,0,0.78)",
                  border:       "1px solid rgba(34,197,94,0.40)",
                  borderRadius:  4,
                  padding:       3,
                  boxShadow:    "0 0 10px rgba(34,197,94,0.15)",
                  lineHeight:    0,
                }}
              >
                {/* "MAP" label at the top */}
                <div style={{
                  fontFamily:    "monospace",
                  fontSize:       7,
                  color:         "rgba(34,197,94,0.65)",
                  textAlign:     "center",
                  letterSpacing:  2,
                  lineHeight:    "1.4",
                  marginBottom:   2,
                }}>
                  MAP
                </div>

                {/* The minimap canvas — internal size matches the world (1px/block);  */}
                {/* CSS width/height scale it up; imageRendering keeps pixels sharp.    */}
                <canvas
                  ref={minimapRef}
                  style={{
                    display:        "block",
                    width:           160,
                    height:           80,
                    imageRendering: "pixelated",
                  }}
                />

                {/* ── Ore legend — 4 key colors so new players can decode the map ── */}
                <div style={{
                  display:        "flex",
                  gap:             5,
                  marginTop:       3,
                  justifyContent: "center",
                  lineHeight:     "1",
                }}>
                  {([
                    { color: "#b48209", label: "Gold"  },
                    { color: "#0e7490", label: "Dia"   },
                    { color: "#b91c1c", label: "Lava"  },
                    { color: "#22c55e", label: "Rig"   },
                  ] as { color: string; label: string }[]).map(({ color, label }) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      <div style={{ width: 6, height: 6, background: color, borderRadius: 1, flexShrink: 0 }} />
                      <span style={{ fontFamily: "monospace", fontSize: 7, color: "rgba(200,200,200,0.65)" }}>
                        {label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── CHAT PANEL (collapsible sidebar) ──────────────────────────── */}
        {chatOpen && (
          <div className="w-52 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0 z-10">
            <div className="px-3 py-2 border-b border-border text-primary font-bold text-[10px] uppercase tracking-widest">
              World Chat
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
              {chatMsgs.length === 0 && (
                <p className="text-muted-foreground italic text-[10px]">No messages yet — say hi!</p>
              )}
              {chatMsgs.map((m, i) => (
                <div key={i} className="break-words leading-tight">
                  <span className="text-primary font-bold">{m.username}: </span>
                  <span className="text-gray-300">{m.message}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-1 p-2 border-t border-border">
              <Input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
                placeholder="Say something..."
                className="h-6 text-[10px] bg-black/50 border-border px-2 py-0"
              />
              <button onClick={sendChat} className="text-primary shrink-0">
                <SendHorizonal className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── CONTROLS BAR — mode toggle + zoom. Joystick lives on the canvas. */}
      {/* The old d-pad is gone — movement is handled by the joystick overlay. */}
      <div ref={ctrlBarRef} className="flex items-center gap-2 px-3 py-1.5 bg-black/90 border-t border-border shrink-0">

        {/* ── Joystick hint label (reminds player how to move) ────────── */}
        <span className="text-[9px] font-mono text-primary/50 shrink-0 hidden sm:block">
          🕹 joystick to move/jump
        </span>
        <div className="w-px h-6 bg-border mx-1 shrink-0 hidden sm:block" />

        {/* ── Mode: Mine / Place ───────────────────────────────────────── */}
        <button
          onClick={() => { setMode("punch"); setSelectedBlock(null); }}
          className={`${ctrlBtn} px-3 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider ${
            mode === "punch"
              ? "bg-red-600/80 border-red-500 text-white"
              : "bg-zinc-900 border-white/15 text-white/50 hover:text-red-400"
          }`}
        >⛏ Mine</button>

        <button
          onClick={() => setMode("place")}
          className={`${ctrlBtn} px-3 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider ${
            mode === "place"
              ? "bg-blue-600/80 border-blue-500 text-white"
              : "bg-zinc-900 border-white/15 text-white/50 hover:text-blue-400"
          }`}
        >🧱 Place</button>

        <div className="w-px h-6 bg-border mx-1 shrink-0" />

        {/* ── Zoom controls ────────────────────────────────────────────── */}
        <button
          onClick={() => adjustZoom(ZOOM_STEP)}
          className={`${ctrlBtn} w-7 h-7 rounded bg-zinc-900 border border-border text-primary flex items-center justify-center hover:bg-primary/20`}
          title="Zoom in"
        ><ZoomIn className="w-3.5 h-3.5" /></button>
        <span className="text-[9px] font-mono text-muted-foreground w-9 text-center">
          {Math.round(zoomDisplay * 100)}%
        </span>
        <button
          onClick={() => adjustZoom(-ZOOM_STEP)}
          className={`${ctrlBtn} w-7 h-7 rounded bg-zinc-900 border border-border text-muted-foreground flex items-center justify-center hover:bg-primary/20`}
          title="Zoom out"
        ><ZoomOut className="w-3.5 h-3.5" /></button>

        {/* ── Overheat indicator ────────────────────────────────────────── */}
        {overheatRef.current && (
          <div className={`ml-auto shrink-0 px-2 py-1 rounded border font-mono text-[9px] font-bold ${
            critHeatRef.current
              ? "border-red-500 text-red-400 bg-red-900/30 animate-pulse"
              : "border-orange-500 text-orange-400 bg-orange-900/20"
          }`}>
            {critHeatRef.current ? "🔥 CRITICAL HEAT" : "♨ OVERHEAT"} — use H₂O
          </div>
        )}

        {/* ── Solar panel tip (when no exposed panel visible) ──────────── */}
        {!overheatRef.current && hotbarItems.some(i => i.itemId === "solar_panel_block") && (
          <span className="ml-auto text-[9px] font-mono text-yellow-400/70 shrink-0 hidden sm:block">
            ☀ Solar panels need <b>open sky</b> + <b>daytime</b> to power rigs
          </span>
        )}
      </div>

      {/* ── HOTBAR ──────────────────────────────────────────────────────── */}
      {/* Shows placeable items from inventory. Machine blocks glow green. */}
      <div ref={hotbarRef} className="flex items-center gap-1.5 px-3 py-2 bg-black/90 border-t border-border shrink-0 overflow-x-auto">
        <span className="text-muted-foreground text-[10px] uppercase font-mono tracking-wider whitespace-nowrap mr-1 shrink-0">
          Hotbar:
        </span>

        {hotbarItems.length === 0 ? (
          <span className="text-muted-foreground text-[10px] font-mono italic">
            Mine blocks or craft Machine Core + Solar Panels to build your rig
          </span>
        ) : (
          hotbarItems.map((item) => {
            const isMachine = MACHINE_BLOCKS.has(item.itemId);
            const isSelected = selectedBlock === item.itemId && mode === "place";
            return (
              <button
                key={item.itemId}
                onClick={() => { setSelectedBlock(item.itemId); setMode("place"); }}
                className={`flex flex-col items-center px-2 py-1.5 rounded border text-[10px] font-mono transition-all shrink-0 ${
                  isSelected
                    ? isMachine
                      ? "border-primary bg-primary/20 text-primary shadow-[0_0_8px_rgba(34,197,94,0.4)]"
                      : "border-blue-400 bg-blue-400/20 text-white"
                    : isMachine
                      ? "border-primary/30 bg-primary/5 text-primary hover:border-primary/60"
                      : "border-border bg-black/50 text-muted-foreground hover:border-white/30"
                }`}
                title={`Place ${BLOCK_LABELS[item.itemId] ?? item.itemId}`}
              >
                {/* Color swatch */}
                <span
                  className="w-6 h-6 rounded-sm mb-0.5 border border-black/30 flex items-center justify-center text-sm"
                  style={{ backgroundColor: BLOCK_COLORS[item.itemId] ?? "#888" }}
                >
                  {isMachine && (item.itemId === "machine_core" ? "⚙" : item.itemId === "solar_panel_block" ? "☀" : "〜")}
                </span>
                <span className="uppercase">{BLOCK_LABELS[item.itemId] ?? item.itemId}</span>
                <span className={`font-bold ${isMachine ? "text-primary" : "text-primary"}`}>×{item.quantity}</span>
              </button>
            );
          })
        )}

        {/* ── USE ITEMS section ────────────────────────────────────────────── */}
        {/* thermal_paste, water_bucket, diesel_can from inventory. */}
        {/* Equip one → click the target machine block to apply the effect.  */}
        {(() => {
          const useItems = inventory.filter(i => USE_ITEMS.has(i.itemId) && i.quantity > 0);
          if (useItems.length === 0) return null;
          return (
            <>
              <div className="w-px h-8 bg-border shrink-0 mx-1" />
              <span className="text-muted-foreground text-[10px] uppercase font-mono tracking-wider whitespace-nowrap shrink-0">
                Use:
              </span>
              {useItems.map((item) => {
                const isSelected = selectedUseItem === item.itemId;
                const emoji = item.itemId === "thermal_paste" ? "🧴" : item.itemId === "water_bucket" ? "💧" : "⛽";
                return (
                  <button
                    key={item.itemId}
                    onClick={() => {
                      // Toggle: clicking again deselects; also exits place mode
                      if (isSelected) { setSelectedUseItem(null); }
                      else { setSelectedUseItem(item.itemId); setMode("punch"); setSelectedBlock(null); }
                    }}
                    className={`flex flex-col items-center px-2 py-1.5 rounded border text-[10px] font-mono transition-all shrink-0 ${
                      isSelected
                        ? "border-orange-400 bg-orange-400/20 text-orange-300 shadow-[0_0_8px_rgba(251,146,60,0.4)]"
                        : "border-border bg-black/50 text-muted-foreground hover:border-orange-400/50"
                    }`}
                    title={`Use: ${BLOCK_LABELS[item.itemId] ?? item.itemId}`}
                  >
                    <span className="text-sm leading-none mb-0.5">{emoji}</span>
                    <span className="uppercase text-[9px]">{BLOCK_LABELS[item.itemId] ?? item.itemId}</span>
                    <span className="font-bold text-orange-400 text-[9px]">×{item.quantity}</span>
                  </button>
                );
              })}
            </>
          );
        })()}

        {/* Cancel place mode or deselect use item */}
        {(mode === "place" || selectedUseItem) && (
          <button
            onClick={() => { setMode("punch"); setSelectedBlock(null); setSelectedUseItem(null); }}
            className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1 rounded hover:bg-red-400/10"
          >
            ✕ Cancel
          </button>
        )}
      </div>

      {/* ── FLOATING WINDOWS + STRUCTURE POPUP ──────────────────────────── */}
      {/* Uses fixed positioning so the game's overflow-hidden doesn't clip  */}
      {/* the windows. pointer-events-none on the wrapper, auto on children. */}
      {/* DOM order determines stacking: backdrop renders FIRST (below),      */}
      {/* window divs render AFTER (above), so clicks inside a window do NOT  */}
      {/* reach the backdrop — only true outside-clicks close all panels.     */}
      <div className="fixed inset-0 z-40 pointer-events-none">

        {/* ── Click-outside backdrop ─────────────────────────────────────── */}
        {/* Transparent full-screen div that fires when the player taps       */}
        {/* anywhere outside an open window. Closes every floating panel.     */}
        {/* Rendered first so window divs (later in DOM) sit on top of it.    */}
        {(structurePopup || showMinerWin || showInvWin || showStoreWin || showLeadWin) && (
          <div
            className="absolute inset-0 pointer-events-auto"
            onClick={() => {
              // Dismiss all panels at once
              setStructurePopup(null);
              setShowMinerWin(false);
              setShowInvWin(false);
              setShowStoreWin(false);
              setShowLeadWin(false);
            }}
          />
        )}

        {/* ── Structure status popup — shown when tapping a machine block ── */}
        {/* Rendered AFTER backdrop so it receives clicks before the backdrop */}
        {structurePopup && (
          <div className="absolute top-16 right-2 pointer-events-auto">
            <StructurePopup
              blockType={structurePopup.blockType}
              bx={structurePopup.bx}
              by={structurePopup.by}
              minerData={minerData as Parameters<typeof StructurePopup>[0]["minerData"]}
              hasDieselCan={hasDieselCan}
              onClose={() => setStructurePopup(null)}
              onBreak={() => {
                // Directly break the block (bypass per-hit counter for machines)
                const { bx, by } = structurePopup;
                const bd = worldRef.current;
                if (!bd) return;
                breakingRef.current.delete(`${bx},${by}`);
                const updated = bd.map((row) => [...row]);
                updated[by][bx] = "air";
                worldRef.current = updated;
                gameAction.mutate(
                  { data: { actionType: "break", worldName, x: bx, y: by } },
                  {
                    onSuccess: () => { setStructurePopup(null); refetchWorld(); refetchInventory(); },
                    onError:   () => { worldRef.current = bd; },
                  }
                );
              }}
              onRefuel={() => {
                // Consume one diesel_can from inventory and add DIESEL_PER_CAN fuel to the miner.
                // Server validates the target block is a generator_block before accepting.
                const { bx, by } = structurePopup;
                gameAction.mutate(
                  { data: { actionType: "refuel", worldName, x: bx, y: by } },
                  {
                    onSuccess: (data) => {
                      if ((data as { success?: boolean }).success) {
                        toast({
                          title: "⛽ REFUELED",
                          description: "Diesel can consumed — generator fuel +100.",
                          className: "bg-black border-yellow-500 text-yellow-400 font-mono uppercase",
                        });
                        setStructurePopup(null);
                      } else {
                        toast({ title: "REFUEL FAILED", description: (data as { error?: string }).error ?? "Unknown error.", variant: "destructive" });
                      }
                      refetchInventory();
                    },
                    onError: () => {
                      toast({ title: "REFUEL FAILED", description: "No diesel can or wrong block.", variant: "destructive" });
                    },
                  }
                );
              }}
            />
          </div>
        )}

        {/* ── Miner stats window ─────────────────────────────────────────── */}
        {showMinerWin && (
          <div className="absolute top-16 right-2 pointer-events-auto">
            <MinerWindow
              minerData={minerData as Parameters<typeof MinerWindow>[0]["minerData"]}
              onClose={() => setShowMinerWin(false)}
            />
          </div>
        )}

        {/* ── Inventory window ───────────────────────────────────────────── */}
        {showInvWin && (
          <div className="absolute top-16 right-2 pointer-events-auto">
            <InventoryWindow
              inventory={inventory}
              onClose={() => setShowInvWin(false)}
            />
          </div>
        )}

        {/* ── Store window ───────────────────────────────────────────────── */}
        {showStoreWin && (
          <div className="absolute top-16 right-2 pointer-events-auto">
            <StoreWindow
              gems={wallet?.gems ?? 0}
              onClose={() => setShowStoreWin(false)}
              onBuy={() => { refetchInventory(); }}
            />
          </div>
        )}

        {/* ── Leaderboard window ─────────────────────────────────────────── */}
        {showLeadWin && (
          <div className="absolute top-16 right-2 pointer-events-auto">
            <LeaderboardWindow onClose={() => setShowLeadWin(false)} />
          </div>
        )}
      </div>

      {/* ── WIZARD CHALLENGE MODAL (anti-cheat) ─────────────────────────── */}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center tracking-widest uppercase text-sm">
              <TriangleAlert className="mr-2 w-4 h-4" /> Anti-Bot Verification
            </DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground text-sm">High action rate detected. Solve to continue:</p>
            <p className="text-3xl font-black text-white">2 + 3 = ?</p>
            <Input
              value={wizardAns}
              onChange={(e) => setWizardAns(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (wizardAns === "5") { setWizard(false); setWizardAns(""); }
                  else toast({ title: "WRONG", variant: "destructive" });
                }
              }}
              className="text-center text-2xl font-bold text-primary border-primary/50 bg-black"
              placeholder="?"
            />
          </div>
          <DialogFooter>
            <Button
              className="w-full bg-destructive hover:bg-destructive/80 font-bold uppercase tracking-widest"
              onClick={() => {
                if (wizardAns === "5") {
                  setWizard(false);
                  setWizardAns("");
                  toast({ title: "VERIFIED ✓", className: "bg-black border-primary text-primary" });
                } else {
                  toast({ title: "WRONG ANSWER", variant: "destructive" });
                }
              }}
            >
              Submit Answer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
