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
import {
  useGetWorld, useGameAction, useGetWallet, useGetInventory, useGetMiner,
  getGetWorldQueryKey, getGetWalletQueryKey, getGetInventoryQueryKey,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert, MessageSquare, SendHorizonal, ZoomIn, ZoomOut } from "lucide-react";

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
  machine_core:      1,   // Machine component — 1-shot so you can rearrange
  solar_panel_block: 1,   // Power source — 1-shot to rearrange
  data_cable:        1,   // Connector — 1-shot to rearrange
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
  machine_core:      "#0a1628",   // dark navy — circuit board feel
  solar_panel_block: "#0d2b2b",   // dark teal — solar panel base
  data_cable:        "#1a1a2e",   // very dark — cable conduit
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
  machine_core:      "rgba(34,197,94,0.15)",   // faint green circuit glow
  solar_panel_block: "rgba(255,220,50,0.20)",  // gold tint — solar cells
  data_cable:        "rgba(34,197,94,0.10)",   // faint green data line
};

// ─── Hotbar label names ───────────────────────────────────────────────────────
const BLOCK_LABELS: Record<string, string> = {
  block_grass:       "Grass",
  block_dirt:        "Dirt",
  block_rock:        "Rock",
  machine_core:      "M.Core",
  solar_panel_block: "SolarPnl",
  data_cable:        "Pipe",
  water_bucket:      "H₂O",
};

// ─── Block fill colors for hotbar swatches ────────────────────────────────────
// water_bucket gets a blue swatch; actual placement is handled specially.

// ─── Which inventory items can be placed as world blocks ─────────────────────
// Includes terrain blocks (collected by mining) AND machine components (crafted).
// water_bucket is special: it triggers a cooldown splash, not a real block place.
const PLACEABLE = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
  "machine_core",
  "solar_panel_block",
  "data_cable",
  "water_bucket",
]);

// ─── Machine block types set (for special rendering / detection) ─────────────
const MACHINE_BLOCKS = new Set(["machine_core", "solar_panel_block", "data_cable"]);

// ─── Max punch reach in block-units ─────────────────────────────────────────
const REACH = 3.5;

// ─── Zoom limits ─────────────────────────────────────────────────────────────
const ZOOM_MIN  = 0.75;  // zoomed out — see more of the world
const ZOOM_MAX  = 3.0;   // zoomed in  — pixel-level detail
const ZOOM_STEP = 0.15;  // each zoom button press changes by this much

// ─── Day/Night sky color computation ─────────────────────────────────────────
// Returns sky gradient data and star/overlay info based on time in the cycle.
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };
function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS;  // 0.0 (midnight) → 1.0 (next midnight)

  if (t < 0.12) {
    // Midnight → dawn break — dark with reddish horizon
    const f = t / 0.12;
    return { r: 255, g: Math.round(80 * f), b: 0, alpha: 0.70 - 0.60 * f, stars: f < 0.6 };
  } else if (t < 0.22) {
    // Dawn — orange warming to blue sky
    const f = (t - 0.12) / 0.10;
    return { r: 255, g: Math.round(80 + 140 * f), b: Math.round(160 * f), alpha: 0.10 - 0.10 * f, stars: false };
  } else if (t < 0.55) {
    // Full daytime — clear bright sky, no overlay
    return { r: 135, g: 206, b: 235, alpha: 0, stars: false };
  } else if (t < 0.68) {
    // Dusk — sky warming to orange/red
    const f = (t - 0.55) / 0.13;
    return { r: 255, g: Math.round(200 - 120 * f), b: Math.round(50 - 50 * f), alpha: 0.12 * f, stars: false };
  } else if (t < 0.78) {
    // Dusk → full night — darkening overlay, stars appear
    const f = (t - 0.68) / 0.10;
    return { r: 255, g: Math.round(80 - 80 * f), b: 0, alpha: 0.12 + 0.58 * f, stars: f > 0.5 };
  }
  // Full night — dark overlay, all stars visible
  return { r: 0, g: 0, b: 20, alpha: 0.70, stars: true };
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
// Returns true if machine_core at (gx,gy) has a cable/block path back to a
// solar panel that is BOTH exposed to open sky AND daytime.
// At night or when panels are covered = all cores go offline.
function isCoreConnectedToPower(grid: string[][], gx: number, gy: number, dayFactor: number): boolean {
  const visited = new Set<string>();
  const queue: [number, number][] = [];

  // Seed BFS only from solar panels that are actually generating power right now
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < (grid[y]?.length ?? 0); x++) {
      if (grid[y][x] === "solar_panel_block" && isSolarPanelExposed(grid, x, y, dayFactor)) {
        const k = `${x},${y}`;
        visited.add(k);
        queue.push([x, y]);
      }
    }
  }

  // Flood-fill through cables and machine blocks to reach target core
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
export default function Game() {
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
  const { data: world, refetch: refetchWorld } = useGetWorld("start", {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") },
  });
  const { data: wallet } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  const { data: inventory = [], refetch: refetchInventory } = useGetInventory({
    query: { enabled: !!userId, queryKey: getGetInventoryQueryKey(), refetchInterval: 5000 },
  });
  const gameAction = useGameAction();
  const { toast } = useToast();

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

  // ════════════════════════════════════════════════════════════════════════
  // Effect: sync world data from server into the local ref used by the loop
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;

    // First load only: find an air cell in column 5 to spawn the player
    if (!physRef.current.spawned) {
      const bd = world.blockData;
      let spawnY = 0;
      for (let y = 0; y < bd.length; y++) {
        if (bd[y][5] === "air") { spawnY = y; break; }
      }
      physRef.current.py = spawnY * BS;
      physRef.current.px = 5 * BS + (BS - PW) / 2;
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
  // ════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx: number, by: number): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0)                        return false;  // open sky above
    if (by >= bd.length)               return true;   // solid floor below world
    if (bx < 0 || bx >= bd[0].length) return true;   // solid walls at edges
    return bd[by][bx] !== "air";
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
        // Falling — check feet collision
        const ty = Math.floor((npy + PH) / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = ty * BS - PH;   // land on top of block
          p.vy = 0;
          p.onGround = true;
        } else {
          p.py = npy;
        }
      } else {
        // Rising — check head collision
        const ty = Math.floor(npy / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = (ty + 1) * BS;  // bump head
          p.vy = 0;
        } else {
          p.py = npy;
        }
      }
      p.py = Math.max(0, Math.min(bd.length * BS - PH, p.py));
    }

    // ── CAMERA: follow player, clamped to world bounds ────────────────────
    // Camera tracks the center of the player and clamps so we don't show
    // out-of-world black borders. The viewport in world-pixels is WW/zoom × WH/zoom.
    const vpW    = WW / zoom;   // visible width in world pixels
    const vpH    = WH / zoom;   // visible height in world pixels
    const worldW = COLS * BS;
    const worldH = ROWS * BS;

    const targetCamX = (p.px + PW / 2) - vpW / 2;
    const targetCamY = (p.py + PH / 2) - vpH / 2;
    // Clamp so camera doesn't scroll past world edges
    const camX = Math.max(0, Math.min(worldW - vpW, targetCamX));
    const camY = Math.max(0, Math.min(worldH - vpH, targetCamY));
    camRef.current = { x: camX, y: camY };

    // ── CLEAR CANVAS ──────────────────────────────────────────────────────
    ctx.clearRect(0, 0, WW, WH);

    // ── SKY BACKGROUND (drawn before camera transform — always fills canvas) ──
    const sky  = getSky(now);
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) {
      // Night sky: dark with reddish/deep tones
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(1, "#0a0010");
    } else {
      // Day sky: blue gradient
      grad.addColorStop(0,   "#1a3a5c");
      grad.addColorStop(0.5, "#0f2035");
      grad.addColorStop(1,   "#050d14");
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
          // Underground blocks are dark; surface/sky blocks are lit by the sun.
          // Machine blocks emit their own light so get a lighter overlay.
          if (lm) {
            const baseLight  = lm[gy]?.[gx] ?? 0.1;
            const isMachine  = MACHINE_BLOCKS.has(blk);
            // Machines glow, so they never go fully dark (min 0.35 light)
            const lightLevel = isMachine ? Math.max(0.35, baseLight) : baseLight;
            // At night, even lit surface blocks get an extra darkness penalty
            const nightBoost = (1 - dayFactor) * 0.45;
            const darkness   = Math.min(0.92, (1 - lightLevel) * 0.88 + nightBoost);
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

    // ── RESTORE from camera+zoom transform ───────────────────────────────
    ctx.restore();

    // ── NIGHT OVERLAY (applied after restore — covers full canvas) ────────
    if (sky.alpha > 0) {
      ctx.fillStyle = `rgba(0,0,20,${sky.alpha * 0.45})`;
      ctx.fillRect(0, 0, WW, WH);
    }

    // ── CRT SCANLINE EFFECT (very subtle retro texture) ───────────────────
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    for (let scanY = 0; scanY < WH; scanY += 4) {
      ctx.fillRect(0, scanY, WW, 2);
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

    // ── WATER BUCKET — special: splash on/near machine_core for cooling ──────
    // Player must physically walk next to the core and "throw" the bucket.
    if (mode === "place" && selectedBlock === "water_bucket") {
      // Accept clicks on the core itself OR on any adjacent air tile next to it
      const isCore = bd[by][bx] === "machine_core";
      const adjCore = !isCore && [[0,-1],[0,1],[-1,0],[1,0]].some(([dx, dy]) => {
        const nx = bx + dx, ny2 = by + dy;
        if (ny2 < 0 || ny2 >= bd.length || nx < 0 || nx >= bd[0].length) return false;
        return bd[ny2][nx] === "machine_core";
      });
      if (!isCore && !adjCore) {
        toast({ title: "NO CORE NEARBY", description: "Walk next to the Machine Core to cool it.", className: "bg-black border-blue-500 text-blue-400 font-mono text-xs" });
        return;
      }
      // Trigger water splash animation at the core block
      const splashKey = `${bx},${by}`;
      waterSplashRef.current.set(splashKey, 800);
      toast({ title: "COOLING FLUSH", description: "Water applied — temperature dropping!", className: "bg-black border-blue-400 text-blue-300 font-mono text-xs" });
      // Fire the miner maintain action (type: water_bucket) via game action
      gameAction.mutate(
        { data: { actionType: "maintain", worldName: "start", x: bx, y: by } as Parameters<typeof gameAction.mutate>[0]["data"] },
        { onSuccess: () => { refetchInventory(); } }
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
        { data: { actionType: "place", worldName: "start", x: bx, y: by, placeBlock: selectedBlock } },
        {
          onSuccess: (data) => {
            if (data.success) {
              // Show tip when machine block is placed
              if ((data as { machineUpdated?: boolean }).machineUpdated) {
                toast({
                  title: "⚡ RIG UPDATED",
                  description: "Machine structure changed — check your Miner!",
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
        { data: { actionType: "break", worldName: "start", x: bx, y: by } },
        {
          onSuccess: (data) => {
            pendingBreakRef.current = false;
            if (data.wizardChallenge) { setWizard(true); return; }
            if (data.success) {
              if (data.dropItem) {
                toast({
                  title: `+1 ${data.dropItem.toUpperCase().replace(/_/g, " ")}`,
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
  }, [mode, selectedBlock, gameAction, refetchWorld, refetchInventory, toast]);

  // Clear crack state when world refreshes (blocks reset)
  useEffect(() => { breakingRef.current.clear(); }, [world]);

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

        {/* ── Canvas container — position:relative so canvas can be absolute ─ */}
        {/* Canvas uses absolute inset-0 so its HTML intrinsic size (800×600)   */}
        {/* doesn't participate in the CSS layout algorithm at all.              */}
        {/* The container height comes entirely from the CSS Grid 1fr track.    */}
        <div className="flex-1 min-h-0 bg-[#050d14] overflow-hidden relative">
          <canvas
            ref={canvasRef}
            width={WW}
            height={WH}
            onClick={handleCanvasClick}
            className="block"
            style={{
              position: "absolute", inset: 0,
              width: "100%", height: "100%",
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

          {/* ── Jump button (top-right of joystick area, easier thumb reach) ── */}
          <button
            className="absolute bottom-4 left-24 z-20 select-none touch-none w-11 h-11 rounded-full border-2 border-primary/50 bg-black/60 text-primary text-xs font-bold font-mono active:bg-primary/30 active:border-primary"
            style={{ touchAction: "none" }}
            onPointerDown={() => {
              const p = physRef.current;
              if (p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
            }}
            title="Jump (or drag joystick UP)"
          >
            <span className="block text-center leading-none text-[10px] mt-0.5 text-primary/60">JMP</span>
            <span className="block text-center leading-none">▲</span>
          </button>

          {/* ── Solar power status badge (top-right of canvas) ───────────── */}
          {(() => {
            const t2 = (performance.now() % DAY_MS) / DAY_MS;
            const isNight = t2 < 0.12 || t2 > 0.68;
            return (
              <div className={`absolute top-2 right-2 z-10 px-2 py-1 rounded border font-mono text-[9px] font-bold ${
                isNight
                  ? "border-zinc-600 text-zinc-400 bg-black/70"
                  : "border-yellow-500/50 text-yellow-300 bg-black/70"
              }`}>
                {isNight ? "🌙 NIGHT — no solar" : "☀ SOLAR ACTIVE"}
              </div>
            );
          })()}
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

        {/* Cancel place mode */}
        {mode === "place" && (
          <button
            onClick={() => { setMode("punch"); setSelectedBlock(null); }}
            className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1 rounded hover:bg-red-400/10"
          >
            ✕ Cancel
          </button>
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
