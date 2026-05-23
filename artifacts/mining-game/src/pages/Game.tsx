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
  useGetWorld, useGameAction, useGetWallet, useGetInventory,
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
  data_cable:        "D.Cable",
};

// ─── Which inventory items can be placed as world blocks ─────────────────────
// Includes terrain blocks (collected by mining) AND machine components (crafted).
const PLACEABLE = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
  "machine_core",
  "solar_panel_block",
  "data_cable",
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

// Returns true if a solar panel at (gx,gy) is adjacent to any machine component
// (cable or core) — used so panels also glow when wired up.
function isSolarPanelPowered(grid: string[][], gx: number, gy: number): boolean {
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  return dirs.some(([dx, dy]) => {
    const nx = gx + dx, ny = gy + dy;
    if (ny < 0 || ny >= grid.length || nx < 0 || nx >= grid[0].length) return false;
    return MACHINE_BLOCKS.has(grid[ny][nx]);
  });
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
  }, [world]);

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

    // ── BLOCKS ────────────────────────────────────────────────────────────
    if (bd) {
      for (let gy = 0; gy < bd.length; gy++) {
        for (let gx = 0; gx < bd[gy].length; gx++) {
          const blk = bd[gy][gx];
          if (blk === "air") continue;

          // ── Machine blocks get special pixel-art rendering ─────────────
          if (blk === "machine_core") {
            const active = isMachineCoreActive(bd, gx, gy);
            drawMachineCore(ctx, gx, gy, active, now);
          } else if (blk === "solar_panel_block") {
            const powered = isSolarPanelPowered(bd, gx, gy);
            drawSolarPanel(ctx, gx, gy, powered, now);
          } else if (blk === "data_cable") {
            // Cable is active if it's adjacent to any machine block
            const active = [[0,-1],[0,1],[-1,0],[1,0]].some(([dx,dy]) => {
              const nx = gx+dx, ny = gy+dy;
              if (ny<0||ny>=bd.length||nx<0||nx>=bd[0].length) return false;
              return MACHINE_BLOCKS.has(bd[ny][nx]);
            });
            drawDataCable(ctx, gx, gy, active, now);
          } else {
            // Standard block: colored fill + highlight tint + dark border
            ctx.fillStyle = BLOCK_COLORS[blk] ?? "#1e293b";
            ctx.fillRect(gx * BS, gy * BS, BS, BS);

            const tint = BLOCK_TINTS[blk] ?? "rgba(255,255,255,0.07)";
            ctx.fillStyle = tint;
            ctx.fillRect(gx * BS + 1, gy * BS + 1, BS - 2, 5);

            ctx.strokeStyle = "rgba(0,0,0,0.4)";
            ctx.lineWidth   = 1;
            ctx.strokeRect(gx * BS + 0.5, gy * BS + 0.5, BS - 1, BS - 1);
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
  // Touch / on-screen controls — Growtopia/Terraria style
  // These are always visible (not just mobile), overlaid on the canvas.
  // ════════════════════════════════════════════════════════════════════════
  const mobileMove = useCallback((dir: "left" | "right" | "stop" | "jump") => {
    const p = physRef.current;
    if (dir === "left")  { p.vx = -MOVE_SPEED; p.facingRight = false; }
    if (dir === "right") { p.vx =  MOVE_SPEED; p.facingRight = true;  }
    if (dir === "stop")  { p.vx = 0; }
    if (dir === "jump" && p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
  }, []);

  // ── Hotbar: placeable items from inventory (terrain + machine blocks) ────
  const hotbarItems = inventory.filter((i) => PLACEABLE.has(i.itemId) && i.quantity > 0);

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

      {/* ── CONTROLS BAR — always rendered below canvas, no GPU layer clash ─ */}
      {/* Placed between canvas and hotbar so it's always visible on screen.  */}
      {/* Keyboard (WASD/arrows/space) still works; this is for touch + mouse. */}
      <div ref={ctrlBarRef} className="flex items-center gap-2 px-3 py-1.5 shrink-0" style={{ background: "red", minHeight: "52px", zIndex: 999, position: "relative" }}>

        {/* ── Movement: ◄ JUMP ► ─────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <button
            className={`${ctrlBtn} w-10 h-10 rounded-lg bg-zinc-800 border border-white/20 text-white text-lg font-bold active:bg-white/20`}
            onPointerDown={() => mobileMove("left")}
            onPointerUp={() => mobileMove("stop")}
            onPointerLeave={() => mobileMove("stop")}
            onTouchStart={(e) => { e.preventDefault(); mobileMove("left"); }}
            onTouchEnd={() => mobileMove("stop")}
            title="Move left"
          >◀</button>

          <button
            className={`${ctrlBtn} w-14 h-10 rounded-lg bg-primary/30 border border-primary text-primary text-xs font-bold uppercase tracking-wide active:bg-primary active:text-black`}
            onPointerDown={() => mobileMove("jump")}
            onTouchStart={(e) => { e.preventDefault(); mobileMove("jump"); }}
            title="Jump"
          >▲ JUMP</button>

          <button
            className={`${ctrlBtn} w-10 h-10 rounded-lg bg-zinc-800 border border-white/20 text-white text-lg font-bold active:bg-white/20`}
            onPointerDown={() => mobileMove("right")}
            onPointerUp={() => mobileMove("stop")}
            onPointerLeave={() => mobileMove("stop")}
            onTouchStart={(e) => { e.preventDefault(); mobileMove("right"); }}
            onTouchEnd={() => mobileMove("stop")}
            title="Move right"
          >▶</button>
        </div>

        {/* ── Divider ──────────────────────────────────────────────────── */}
        <div className="w-px h-8 bg-border mx-1 shrink-0" />

        {/* ── Mode: Punch / Place ───────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setMode("punch"); setSelectedBlock(null); }}
            className={`${ctrlBtn} px-3 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider ${
              mode === "punch"
                ? "bg-red-600 border-red-500 text-white"
                : "bg-zinc-800 border-white/20 text-white/60 hover:text-red-400"
            }`}
          >👊 Punch</button>

          <button
            onClick={() => setMode("place")}
            className={`${ctrlBtn} px-3 py-1.5 rounded border text-[10px] font-mono font-bold uppercase tracking-wider ${
              mode === "place"
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-zinc-800 border-white/20 text-white/60 hover:text-blue-400"
            }`}
          >🧱 Place</button>
        </div>

        {/* ── Divider ──────────────────────────────────────────────────── */}
        <div className="w-px h-8 bg-border mx-1 shrink-0" />

        {/* ── Zoom controls ────────────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => adjustZoom(ZOOM_STEP)}
            className={`${ctrlBtn} w-7 h-7 rounded bg-zinc-800 border border-border text-primary flex items-center justify-center hover:bg-primary/20`}
            title="Zoom in"
          ><ZoomIn className="w-3.5 h-3.5" /></button>

          <span className="text-[9px] font-mono text-muted-foreground w-9 text-center">
            {Math.round(zoomDisplay * 100)}%
          </span>

          <button
            onClick={() => adjustZoom(-ZOOM_STEP)}
            className={`${ctrlBtn} w-7 h-7 rounded bg-zinc-800 border border-border text-muted-foreground flex items-center justify-center hover:bg-primary/20`}
            title="Zoom out"
          ><ZoomOut className="w-3.5 h-3.5" /></button>
        </div>

        {/* ── Machine rig hint (when machine blocks are in hotbar) ──────── */}
        {hotbarItems.some(i => MACHINE_BLOCKS.has(i.itemId)) && (
          <span className="ml-auto text-[9px] font-mono text-primary shrink-0 hidden sm:block">
            💡 Place <b>Core</b> + <b>Solar Panels</b> side-by-side to build your rig
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
