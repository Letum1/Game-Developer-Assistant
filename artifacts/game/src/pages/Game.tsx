// ============================================================
// Game.tsx — Growtopia-style 2D block-building world
//
// Features:
//   • Gravity physics with AABB collision detection
//   • Mine blocks (click/tap) — multi-hit crack animation
//   • Place blocks from inventory (Growtopia mechanic)
//   • Solar Panel, Machine Core, Data Cable — placeable machines
//   • Day/night cycle with sun, moon, and stars
//   • Multiplayer chat over WebSocket
//   • Mobile D-pad controller (◀ JUMP ▶)
//   • Pinch-zoom guard — D-pad never fires during two-finger zoom
//   • Canvas tap support — mine/place by tapping directly on mobile
// ============================================================

import { useEffect, useRef, useState, useCallback } from "react";
import {
  useGetWorld, useGameAction, useGetWallet, useGetInventory,
  getGetWorldQueryKey, getGetWalletQueryKey, getGetInventoryQueryKey,
} from "@workspace/api-client-react";
import { motion } from "framer-motion";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button }  from "@/components/ui/button";
import { Input }   from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert, MessageSquare, SendHorizonal, X } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// WORLD / CANVAS CONSTANTS
// The canvas is 800×600 pixels = 20×15 blocks at 40px each (like Growtopia).
// ─────────────────────────────────────────────────────────────────────────────
const BS = 40;    // Block Size in pixels — every grid cell is 40×40
const WW = 800;   // Canvas Width  in pixels (20 blocks × 40px)
const WH = 600;   // Canvas Height in pixels (15 blocks × 40px)

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICS CONSTANTS
// Gravity and movement feel tuned to match a Growtopia-like game feel.
// ─────────────────────────────────────────────────────────────────────────────
const GRAVITY    = 900;   // Downward acceleration in px/s² — heavy, snappy feel
const JUMP_VY    = -420;  // Initial jump velocity (negative = upward)
const MOVE_SPEED = 175;   // Horizontal walk speed in px/s
const PW         = 26;    // Player hitbox Width  in pixels
const PH         = 36;    // Player hitbox Height in pixels

// ─────────────────────────────────────────────────────────────────────────────
// DAY/NIGHT CYCLE
// One full cycle = 8 minutes (480,000 ms). Sky changes from dawn → day → dusk → night.
// ─────────────────────────────────────────────────────────────────────────────
const DAY_MS = 480_000;

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK HIT COUNTS
// How many taps/clicks are needed to break each block type.
// Lower = easier. Grass is instant (1 hit), Diamond needs 5.
// Machine blocks break in 2 hits so you can rearrange your rig easily.
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_HITS: Record<string, number> = {
  block_grass:        1,  // Surface layer — very quick to mine
  block_dirt:         2,  // Sub-surface — needs two hits
  block_rock:         3,  // Stone layer — medium difficulty
  block_iron:         4,  // Iron ore — harder to mine
  block_gold:         3,  // Gold ore — medium (reward justifies effort)
  block_diamond:      5,  // Diamond ore — hardest in the game
  block_lava:         4,  // Lava — dangerous and hard
  machine_core:       2,  // Machine block — 2 hits to pick up
  solar_panel_block:  2,  // Solar panel — 2 hits to pick up
  data_cable:         1,  // Cable — fragile, 1 hit to remove
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK COLORS (canvas fillStyle)
// Natural blocks use earthy tones. Machine blocks use electric/tech colors.
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass:        "#15803d",  // Deep green
  block_dirt:         "#78350f",  // Dark brown
  block_rock:         "#374151",  // Dark gray
  block_iron:         "#6b7280",  // Steel gray
  block_gold:         "#b45309",  // Amber gold
  block_diamond:      "#0e7490",  // Cyan-teal
  block_lava:         "#b91c1c",  // Deep red
  machine_core:       "#1e1b4b",  // Deep indigo — CPU brain
  solar_panel_block:  "#065f46",  // Dark emerald — solar cell
  data_cable:         "#7f1d1d",  // Dark crimson — cable conduit
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK TINTS (top-edge shimmer to give a 3D carved look)
// A thin strip of translucent color is drawn over the top few pixels of each block.
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_TINTS: Record<string, string> = {
  block_grass:        "rgba(74,222,128,0.25)",
  block_dirt:         "rgba(180,130,80,0.20)",
  block_rock:         "rgba(200,200,220,0.12)",
  block_iron:         "rgba(210,220,230,0.20)",
  block_gold:         "rgba(255,220,50,0.35)",
  block_diamond:      "rgba(100,240,255,0.30)",
  block_lava:         "rgba(255,120,0,0.40)",
  machine_core:       "rgba(150,120,255,0.40)",
  solar_panel_block:  "rgba(50,255,160,0.40)",
  data_cable:         "rgba(255,80,80,0.30)",
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK DISPLAY LABELS (used in hotbar and toast messages)
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_LABELS: Record<string, string> = {
  block_grass:        "Grass",
  block_dirt:         "Dirt",
  block_rock:         "Rock",
  machine_core:       "Machine",
  solar_panel_block:  "Solar ☀️",
  data_cable:         "Cable",
};

// ─────────────────────────────────────────────────────────────────────────────
// PLACEABLE BLOCKS
// Which inventory items can be placed back into the world.
// Natural blocks (grass/dirt/rock) are collected when mined and re-placed to build.
// Machine blocks (core/solar/cable) are crafted and placed to build a Data Rig.
// ─────────────────────────────────────────────────────────────────────────────
const PLACEABLE = new Set([
  "block_grass",
  "block_dirt",
  "block_rock",
  "machine_core",       // The CPU — place this + solar panels to start earning
  "solar_panel_block",  // Power source — each one adds to miner income rate
  "data_cable",         // Connector — links machine blocks across gaps
]);

// ─────────────────────────────────────────────────────────────────────────────
// REACH
// Max distance (in block-units) the player can mine or place blocks.
// Player must walk close enough to interact — adds exploration challenge.
// ─────────────────────────────────────────────────────────────────────────────
const REACH = 3.5;

// ─────────────────────────────────────────────────────────────────────────────
// SKY STATE CALCULATOR
// Returns sky color and atmosphere settings based on current time in the day cycle.
// t=0 is midnight, t=0.5 is solar noon.
// ─────────────────────────────────────────────────────────────────────────────
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };

function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS; // 0.0 → 1.0 over the full day

  if (t < 0.12) {
    // Midnight transitioning to first light — reddish glow
    const f = t / 0.12;
    return { r: 255, g: Math.round(80 * f), b: 0, alpha: 0.70 - 0.60 * f, stars: f < 0.6 };
  } else if (t < 0.22) {
    // Dawn — orange fading to pale blue
    const f = (t - 0.12) / 0.10;
    return { r: 255, g: Math.round(80 + 140 * f), b: Math.round(160 * f), alpha: 0.10 - 0.10 * f, stars: false };
  } else if (t < 0.55) {
    // Full daytime — clear sky, no overlay
    return { r: 135, g: 206, b: 235, alpha: 0, stars: false };
  } else if (t < 0.68) {
    // Dusk — warm orange tint
    const f = (t - 0.55) / 0.13;
    return { r: 255, g: Math.round(200 - 120 * f), b: Math.round(50 - 50 * f), alpha: 0.12 * f, stars: false };
  } else if (t < 0.78) {
    // Twilight — darkening fast, stars appear
    const f = (t - 0.68) / 0.10;
    return { r: 255, g: Math.round(80 - 80 * f), b: 0, alpha: 0.12 + 0.58 * f, stars: f > 0.5 };
  }
  // Full night — dark purple sky with stars
  return { r: 0, g: 0, b: 20, alpha: 0.70, stars: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRACK OVERLAY RENDERER
// Draws progressive crack patterns over a block as it takes damage.
// progress: 0.0 (fresh) → 1.0 (just before it breaks).
// Stages 1-4 add more lines, darker fill, and corner chips.
// ─────────────────────────────────────────────────────────────────────────────
function drawCracks(ctx: CanvasRenderingContext2D, bx: number, by: number, progress: number) {
  const x = bx * BS;
  const y = by * BS;

  // No cracks below 20% damage
  if (progress < 0.2) return;

  const stage = Math.min(4, Math.floor(progress * 5)); // 1, 2, 3, or 4

  // Darken block progressively as it takes damage
  ctx.fillStyle = `rgba(0,0,0,${progress * 0.55})`;
  ctx.fillRect(x + 1, y + 1, BS - 2, BS - 2);

  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 2;

  // Stage 1: small crack from top-left corner
  if (stage >= 1) {
    ctx.beginPath();
    ctx.moveTo(x + 8,  y + 6);
    ctx.lineTo(x + 18, y + 16);
    ctx.lineTo(x + 14, y + 22);
    ctx.stroke();
  }
  // Stage 2: second crack from right side
  if (stage >= 2) {
    ctx.beginPath();
    ctx.moveTo(x + 30, y + 8);
    ctx.lineTo(x + 22, y + 20);
    ctx.lineTo(x + 28, y + 30);
    ctx.stroke();
  }
  // Stage 3: crack across middle + corner chip
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
  // Stage 4: severe cracking — crossing fault lines + all 4 corner chips
  if (stage >= 4) {
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 2, y + 20); ctx.lineTo(x + 38, y + 18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + 20, y + 2); ctx.lineTo(x + 18, y + 38); ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x + 1,  y + 1,  4, 4);
    ctx.fillRect(x + 35, y + 1,  4, 4);
    ctx.fillRect(x + 1,  y + 35, 4, 4);
    ctx.fillRect(x + 35, y + 35, 4, 4);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNCH FLASH RENDERER
// Draws a brief bright flash over a block the moment it is hit.
// Alpha fades over several frames — called in the main game loop.
// ─────────────────────────────────────────────────────────────────────────────
function drawPunchFlash(ctx: CanvasRenderingContext2D, bx: number, by: number, alpha: number) {
  ctx.fillStyle = `rgba(255,255,200,${alpha * 0.5})`;
  ctx.fillRect(bx * BS + 2, by * BS + 2, BS - 4, BS - 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE BLOCK RENDERER
// Special pixel-art visuals for placeable machine components:
//   machine_core        → glowing purple CPU with circuit lines
//   solar_panel_block   → green 3×3 solar cell grid
//   data_cable          → red cable conduit
// ─────────────────────────────────────────────────────────────────────────────
function drawMachineBlock(ctx: CanvasRenderingContext2D, blk: string, gx: number, gy: number) {
  const px = gx * BS; // pixel X of this block
  const py = gy * BS; // pixel Y of this block

  if (blk === "machine_core") {
    // Background — deep indigo
    ctx.fillStyle = "#312e81";
    ctx.fillRect(px + 1, py + 1, BS - 2, BS - 2);
    // Glowing inner square
    ctx.fillStyle = "rgba(167,139,250,0.8)";
    ctx.fillRect(px + 8, py + 8, BS - 16, BS - 16);
    // Inner border glow
    ctx.strokeStyle = "rgba(196,181,253,0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px + 8, py + 8, BS - 16, BS - 16);
    // Circuit lines radiating from center — North, South, East, West
    ctx.strokeStyle = "rgba(167,139,250,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px +  4, py + 20); ctx.lineTo(px +  8, py + 20); ctx.stroke(); // West
    ctx.beginPath(); ctx.moveTo(px + 32, py + 20); ctx.lineTo(px + 36, py + 20); ctx.stroke(); // East
    ctx.beginPath(); ctx.moveTo(px + 20, py +  4); ctx.lineTo(px + 20, py +  8); ctx.stroke(); // North
    ctx.beginPath(); ctx.moveTo(px + 20, py + 32); ctx.lineTo(px + 20, py + 36); ctx.stroke(); // South
    // Outer border
    ctx.strokeStyle = "rgba(99,102,241,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 1, py + 1, BS - 2, BS - 2);

  } else if (blk === "solar_panel_block") {
    // Background — dark emerald
    ctx.fillStyle = "#064e3b";
    ctx.fillRect(px + 1, py + 1, BS - 2, BS - 2);
    // Draw 3×3 solar cells with alternating shades
    const cellSize = (BS - 8) / 3;
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        // Checkerboard pattern — slight shade variation
        ctx.fillStyle = (cx + cy) % 2 === 0 ? "#065f46" : "#047857";
        ctx.fillRect(px + 4 + cx * cellSize, py + 4 + cy * cellSize, cellSize - 1, cellSize - 1);
      }
    }
    // Glow border — green energy
    ctx.strokeStyle = "rgba(52,211,153,0.7)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px + 2, py + 2, BS - 4, BS - 4);
    // Tiny sun symbol in center
    ctx.fillStyle = "rgba(250,204,21,0.8)";
    ctx.beginPath();
    ctx.arc(px + BS / 2, py + BS / 2, 3, 0, Math.PI * 2);
    ctx.fill();

  } else if (blk === "data_cable") {
    // Background — very dark red
    ctx.fillStyle = "#450a0a";
    ctx.fillRect(px + 1, py + 1, BS - 2, BS - 2);
    // Cable pipe — vertical channel
    ctx.fillStyle = "#dc2626";
    ctx.fillRect(px + 14, py + 2, 12, BS - 4);
    // Highlight stripe through center of cable
    ctx.fillStyle = "#fca5a5";
    ctx.fillRect(px + 18, py + 4, 4, BS - 8);
    // Border
    ctx.strokeStyle = "rgba(239,68,68,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 2, py + 2, BS - 4, BS - 4);
    // Horizontal connectors at top and bottom
    ctx.fillStyle = "#b91c1c";
    ctx.fillRect(px + 2,  py + 4,  12, 6); // left top
    ctx.fillRect(px + 26, py + 4,  12, 6); // right top
    ctx.fillRect(px + 2,  py + BS - 10, 12, 6); // left bottom
    ctx.fillRect(px + 26, py + BS - 10, 12, 6); // right bottom
  }
}

// ============================================================
// MAIN GAME COMPONENT
// ============================================================
export default function Game() {

  // ── User identity loaded from localStorage after login ─────────────────────
  const userId   = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";

  // Canvas ref — the 2D surface everything is drawn onto each frame
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Server data hooks ───────────────────────────────────────────────────────
  // World grid: 20×15 array of block names (e.g. "block_dirt", "air")
  const { data: world, refetch: refetchWorld } = useGetWorld("start", {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") },
  });
  // Player wallet: gems, energy (action_count), real_balance
  const { data: wallet } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  // Inventory: list of { itemId, quantity } the player carries
  const { data: inventory = [], refetch: refetchInventory } = useGetInventory({
    query: { enabled: !!userId, queryKey: getGetInventoryQueryKey(), refetchInterval: 5000 },
  });

  // Server mutation — sends break/place actions to the API
  const gameAction = useGameAction();
  const { toast }  = useToast();

  // ── Physics state (ref, not state, so it never triggers re-renders) ─────────
  // Updated every animation frame, read by the renderer and collision system.
  const physRef = useRef({
    px:           5 * BS,  // X position in pixels
    py:           0,       // Y position in pixels (set on first world load)
    vx:           0,       // Horizontal velocity (px/s)
    vy:           0,       // Vertical velocity (px/s)
    onGround:     false,   // Is the player standing on solid ground?
    facingRight:  true,    // Which way the player faces (affects tool rendering)
    spawned:      false,   // Has spawn position been set after world loaded?
  });

  // Set of keyboard keys currently held down — checked every frame for movement
  const keysRef  = useRef<Set<string>>(new Set());
  // Local world grid copy — lives in a ref to avoid React re-render lag in the loop
  const worldRef = useRef<string[][] | null>(null);
  // requestAnimationFrame handle — stored for cleanup on unmount
  const rafRef   = useRef(0);
  // Timestamp of the previous frame — used for delta-time physics
  const lastTRef = useRef(0);

  // ── Breaking animation state ────────────────────────────────────────────────
  // Maps "x,y" → { hits, maxHits } — tracks crack progress per block
  const breakingRef     = useRef<Map<string, { hits: number; maxHits: number }>>(new Map());
  // Maps "x,y" → flash alpha (0-1) — punch impact flash, fades each frame
  const flashRef        = useRef<Map<string, number>>(new Map());
  // Prevents double-sending a break request before the first one resolves
  const pendingBreakRef = useRef(false);

  // ── Mobile pinch-zoom detection ─────────────────────────────────────────────
  // When the user puts TWO fingers on screen (pinch), we set isPinchingRef = true.
  // The D-pad buttons check this and refuse to fire movement while pinching.
  // This stops the accidental left/right movement when the user tries to zoom.
  const isPinchingRef = useRef(false);

  // ── UI state (React state — these DO trigger re-renders) ───────────────────
  const [mode,          setMode]         = useState<"punch" | "place">("punch");
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [wizard,        setWizard]        = useState(false);
  const [wizardAns,     setWizardAns]     = useState("");
  const [chatOpen,      setChatOpen]      = useState(false);
  const [chatMsgs,      setChatMsgs]      = useState<{ username: string; message: string }[]>([]);
  const [chatInput,     setChatInput]     = useState("");

  // ── WebSocket ref for multiplayer chat ─────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);

  // ── Static star field (generated once, reused every night frame) ────────────
  // Each star has a fixed x/y/radius and an individual twinkle phase offset.
  const starsRef = useRef(
    Array.from({ length: 90 }, () => ({
      x:       Math.random() * WW,
      y:       Math.random() * WH * 0.55,   // Stars only appear in the upper sky
      r:       Math.random() * 1.5 + 0.4,
      twinkle: Math.random() * Math.PI * 2, // Random phase so they don't all twinkle together
    }))
  );

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Sync world data from server into local ref
  // Also sets spawn position the very first time the world loads.
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;

    // First load — find the topmost air block in column 5 and spawn player there
    if (!physRef.current.spawned) {
      const bd = world.blockData;
      let spawnY = 0;
      for (let y = 0; y < bd.length; y++) {
        if (bd[y][5] === "air") { spawnY = y; break; }
      }
      physRef.current.py      = spawnY * BS;
      physRef.current.px      = 5 * BS + (BS - PW) / 2;
      physRef.current.spawned = true;
    }
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Connect to multiplayer chat via WebSocket
  // Messages from all players appear in the chat panel.
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws    = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;

    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { username: string; message: string };
        // Keep a rolling window of the last 30 messages
        setChatMsgs((prev) => [...prev.slice(-29), m]);
      } catch { /* Ignore malformed packets */ }
    };

    return () => ws.close(); // Disconnect on component unmount
  }, []);

  // Send a chat message to all players in the world
  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ username, message: chatInput.trim() }));
    setChatInput("");
  };

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: solid(bx, by)
  // Returns true if the block at grid position (bx, by) is solid (non-air).
  // Used every frame for AABB physics collision against the world grid.
  // ════════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx: number, by: number): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0)  return false;                      // Above world = open sky
    if (by >= bd.length) return true;               // Below world = solid floor
    if (bx < 0 || bx >= bd[0].length) return true; // Side edges = solid walls
    return bd[by][bx] !== "air";
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN GAME LOOP — drawFrame(now)
  // Runs every animation frame (~60fps via requestAnimationFrame).
  // Order: physics → clear → sky → stars → sun/moon → blocks → player → overlays
  // ════════════════════════════════════════════════════════════════════════════
  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx)   return;

    // Delta time: seconds since last frame (capped at 50ms to prevent tunnelling on tab switch)
    const dt = Math.min((now - lastTRef.current) / 1000, 0.05);
    lastTRef.current = now;

    const p  = physRef.current;
    const bd = worldRef.current;

    // ── PHYSICS UPDATE ──────────────────────────────────────────────────────
    if (bd) {
      // Horizontal movement — check AABB collision on both top and bottom of player
      const npx = p.px + p.vx * dt;
      const ty0 = Math.floor((p.py + 2)      / BS); // top of player box
      const ty1 = Math.floor((p.py + PH - 2) / BS); // bottom of player box

      if (p.vx > 0) {
        // Moving right — check right edge
        const tx = Math.floor((npx + PW) / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = tx * BS - PW; // snap to wall
      } else if (p.vx < 0) {
        // Moving left — check left edge
        const tx = Math.floor(npx / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = (tx + 1) * BS; // snap to wall
      }
      // Clamp to horizontal world bounds
      p.px = Math.max(0, Math.min(bd[0].length * BS - PW, p.px));

      // Vertical movement — apply gravity, then check floor/ceiling
      p.vy = Math.min(p.vy + GRAVITY * dt, 850); // cap at terminal velocity 850px/s
      const npy = p.py + p.vy * dt;
      const tx0 = Math.floor((p.px + 2)      / BS); // left side of player
      const tx1 = Math.floor((p.px + PW - 2) / BS); // right side of player
      p.onGround = false;

      if (p.vy >= 0) {
        // Falling — check feet hitting a block
        const ty = Math.floor((npy + PH) / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = ty * BS - PH; // land on top of block
          p.vy = 0;
          p.onGround = true;
        } else { p.py = npy; }
      } else {
        // Rising — check head hitting a block above
        const ty = Math.floor(npy / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = (ty + 1) * BS; // bump head, stop upward movement
          p.vy = 0;
        } else { p.py = npy; }
      }
      // Clamp to vertical world bounds
      p.py = Math.max(0, Math.min(bd.length * BS - PH, p.py));
    }

    // ── CLEAR CANVAS ────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, WW, WH);

    // ── SKY GRADIENT ────────────────────────────────────────────────────────
    const sky  = getSky(now);
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) {
      // Night gradient — dark with atmospheric glow at horizon
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(1, "#0a0010");
    } else {
      // Day gradient — deep blue sky with slightly lighter horizon
      grad.addColorStop(0,   "#1a3a5c");
      grad.addColorStop(0.5, "#0f2035");
      grad.addColorStop(1,   "#050d14");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WW, WH);

    // ── STARS (visible at night) ─────────────────────────────────────────────
    if (sky.stars && sky.alpha > 0.1) {
      const starAlpha = Math.min(1, (sky.alpha - 0.1) * 2);
      starsRef.current.forEach((s) => {
        // Each star twinkles at its own phase and speed
        const tw = 0.7 + 0.3 * Math.sin(now / 800 + s.twinkle);
        ctx.fillStyle = `rgba(255,255,255,${starAlpha * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // ── SUN OR MOON ──────────────────────────────────────────────────────────
    const t = (now % DAY_MS) / DAY_MS;
    if (sky.alpha < 0.4) {
      // Daytime — radial gradient sun traversing a wide arc
      const sunAngle = t * Math.PI * 2 - Math.PI / 2;
      const sx = WW / 2 + Math.cos(sunAngle) * 320;
      const sy = WH * 0.5 + Math.sin(sunAngle) * 280;
      if (sy < WH * 0.55) {
        const sunGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28);
        sunGrad.addColorStop(0,   "rgba(255,240,100,1)");
        sunGrad.addColorStop(0.5, "rgba(255,180,0,0.8)");
        sunGrad.addColorStop(1,   "rgba(255,140,0,0)");
        ctx.fillStyle = sunGrad;
        ctx.beginPath(); ctx.arc(sx, sy, 28, 0, Math.PI * 2); ctx.fill();
      }
    } else if (sky.alpha > 0.5) {
      // Nighttime — crescent moon (circle with offset circle "biting" out of it)
      const moonAngle = (t + 0.5) * Math.PI * 2 - Math.PI / 2;
      const mx = WW / 2 + Math.cos(moonAngle) * 320;
      const my = WH * 0.5 + Math.sin(moonAngle) * 280;
      if (my < WH * 0.55) {
        ctx.fillStyle = "rgba(220,230,255,0.9)";
        ctx.beginPath(); ctx.arc(mx, my, 16, 0, Math.PI * 2); ctx.fill();
        // "Bite" out a piece to create the crescent shape
        ctx.fillStyle = "rgba(10,0,30,0.85)";
        ctx.beginPath(); ctx.arc(mx + 6, my - 4, 13, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ── BLOCKS ───────────────────────────────────────────────────────────────
    if (bd) {
      for (let y = 0; y < bd.length; y++) {
        for (let x = 0; x < bd[y].length; x++) {
          const blk = bd[y][x];
          if (blk === "air") continue; // Air cells are transparent — skip

          // Machine blocks use their own special renderer
          if (blk === "machine_core" || blk === "solar_panel_block" || blk === "data_cable") {
            drawMachineBlock(ctx, blk, x, y);
          } else {
            // Natural blocks — filled rectangle + shimmer tint + dark border
            ctx.fillStyle = BLOCK_COLORS[blk] ?? "#1e293b";
            ctx.fillRect(x * BS, y * BS, BS, BS);

            // Top-edge highlight for a subtle carved look
            ctx.fillStyle = BLOCK_TINTS[blk] ?? "rgba(255,255,255,0.07)";
            ctx.fillRect(x * BS + 1, y * BS + 1, BS - 2, 5);

            // Thin dark border separating blocks
            ctx.strokeStyle = "rgba(0,0,0,0.4)";
            ctx.lineWidth = 1;
            ctx.strokeRect(x * BS + 0.5, y * BS + 0.5, BS - 1, BS - 1);
          }
        }
      }

      // ── CRACK OVERLAYS — drawn on top of blocks being mined ──────────────
      breakingRef.current.forEach(({ hits, maxHits }, key) => {
        const [bxStr, byStr] = key.split(",");
        drawCracks(ctx, parseInt(bxStr), parseInt(byStr), hits / maxHits);
      });

      // ── PUNCH FLASH — bright impact flash, fades over ~6 frames ──────────
      flashRef.current.forEach((alpha, key) => {
        const [bxStr, byStr] = key.split(",");
        drawPunchFlash(ctx, parseInt(bxStr), parseInt(byStr), alpha);
        const newAlpha = alpha - 0.18; // fade amount per frame
        if (newAlpha <= 0) flashRef.current.delete(key);
        else               flashRef.current.set(key, newAlpha);
      });
    }

    // ── PLAYER SPRITE ────────────────────────────────────────────────────────
    const { px, py, facingRight: fr } = p;

    // Body — dark green shirt
    ctx.fillStyle = "#1e4d2b";
    ctx.fillRect(px + 5, py + 14, PW - 10, PH - 14);

    // Head — warm skin tone
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(px + 3, py + 2, PW - 6, 14);

    // Eye — black pupil facing direction of movement
    ctx.fillStyle = "#000";
    ctx.fillRect(fr ? px + 13 : px + 5, py + 7, 4, 4);

    // Eye glow — green highlight (hacker aesthetic)
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(fr ? px + 14 : px + 6, py + 8, 2, 2);

    // Tool held by player — block swatch in place mode, pickaxe in punch mode
    if (mode === "place" && selectedBlock) {
      // Colored block indicator showing what will be placed
      ctx.fillStyle = BLOCK_COLORS[selectedBlock] ?? "#aaa";
      ctx.fillRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1;
      ctx.strokeRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
    } else {
      // Pickaxe — gray handle + darker head
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(fr ? px + PW + 1 : px - 5, py + 16, 4, 14);
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(fr ? px + PW : px - 6, py + 13, 6, 6);
    }

    // ── NIGHT OVERLAY — darkens whole scene as sky darkens ───────────────────
    if (sky.alpha > 0) {
      ctx.fillStyle = `rgba(0,0,20,${sky.alpha * 0.45})`;
      ctx.fillRect(0, 0, WW, WH);
    }

    // ── CRT SCANLINES — subtle retro effect (every 4 pixels) ─────────────────
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    for (let scanY = 0; scanY < WH; scanY += 4) {
      ctx.fillRect(0, scanY, WW, 2);
    }

    // Schedule next frame
    rafRef.current = requestAnimationFrame(drawFrame);
  }, [solid, mode, selectedBlock]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Start the game loop on mount, cancel it on unmount
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    lastTRef.current = performance.now();
    rafRef.current   = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Keyboard controls (WASD / Arrow keys / Space)
  // Keydown starts movement; keyup stops when no keys in that direction remain.
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      const p = physRef.current;
      if (["ArrowLeft",  "a", "A"].includes(e.key)) { p.vx = -MOVE_SPEED; p.facingRight = false; }
      if (["ArrowRight", "d", "D"].includes(e.key)) { p.vx =  MOVE_SPEED; p.facingRight = true;  }
      if ([" ", "ArrowUp", "w", "W"].includes(e.key) && p.onGround) {
        p.vy = JUMP_VY; p.onGround = false;
        e.preventDefault(); // Prevent page scroll on Space
      }
    };

    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      const keys   = keysRef.current;
      const goLeft  = keys.has("ArrowLeft")  || keys.has("a") || keys.has("A");
      const goRight = keys.has("ArrowRight") || keys.has("d") || keys.has("D");
      // Only stop if no other direction key is still held
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

  // ════════════════════════════════════════════════════════════════════════════
  // CORE BLOCK INTERACTION — shared by both mouse click and canvas touch tap
  // Converts screen coordinates to grid cell, checks reach, then breaks or places.
  // ════════════════════════════════════════════════════════════════════════════
  const interactBlock = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Convert screen coords → canvas logical coords → block grid cell
    // The canvas is CSS-scaled so we divide by rect dimensions, then multiply by logical size
    const bx = Math.floor(((clientX - rect.left) / rect.width)  * WW / BS);
    const by = Math.floor(((clientY - rect.top)  / rect.height) * WH / BS);
    const bd = worldRef.current;
    if (!bd) return;

    // Bounds check — ignore clicks outside the world
    if (bx < 0 || by < 0 || bx >= bd[0].length || by >= bd.length) return;

    // Player center in block-units (for reach distance check)
    const p   = physRef.current;
    const pcx = (p.px + PW / 2) / BS;
    const pcy = (p.py + PH / 2) / BS;
    const dist = Math.sqrt((bx - pcx) ** 2 + (by - pcy) ** 2);

    // Enforce reach limit — player must walk close enough
    if (dist > REACH) {
      toast({
        title: "OUT OF REACH",
        description: "Walk closer to mine or place.",
        className: "bg-black border-border text-muted-foreground font-mono text-xs",
      });
      return;
    }

    // ── PLACE MODE: place selected block on an empty (air) cell ────────────
    if (mode === "place" && selectedBlock) {
      if (bd[by][bx] !== "air") {
        toast({ title: "BLOCKED", description: "That space is occupied.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }
      // Optimistic update — show the block immediately before server confirms
      const updated = bd.map((row) => [...row]);
      updated[by][bx] = selectedBlock;
      worldRef.current = updated;

      gameAction.mutate(
        { data: { actionType: "place", worldName: "start", x: bx, y: by, placeBlock: selectedBlock } },
        {
          onSuccess: (data) => {
            if (data.success) {
              // Show machine activation hint when a machine block is placed
              if ((data as { machineUpdated?: boolean }).machineUpdated) {
                toast({ title: "⚡ MACHINE UPDATED", description: "Place solar panels adjacent to the core to power it!", className: "bg-black border-violet-500 text-violet-400 font-mono text-xs" });
              }
              refetchWorld();
              refetchInventory();
            } else {
              // Revert optimistic update on server rejection
              worldRef.current = bd;
              toast({ title: "PLACE FAILED", variant: "destructive" });
            }
          },
          onError: () => { worldRef.current = bd; },
        }
      );
      return;
    }

    // ── PUNCH MODE: mine a block using the multi-hit crack system ──────────
    if (bd[by][bx] === "air") return; // Nothing to punch here

    const key     = `${bx},${by}`;
    const blkType = bd[by][bx];
    const maxHits = BLOCK_HITS[blkType] ?? 3;
    const current = breakingRef.current.get(key) ?? { hits: 0, maxHits };

    // Show punch flash and turn player to face the block
    flashRef.current.set(key, 1.0);
    physRef.current.facingRight = bx >= pcx;

    const newHits = current.hits + 1;

    if (newHits >= maxHits) {
      // ── Block fully broken — send to server ──────────────────────────────
      if (pendingBreakRef.current) return; // debounce
      pendingBreakRef.current = true;
      breakingRef.current.delete(key);

      // Optimistic: immediately remove block so the game feels snappy
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
            worldRef.current = bd; // Revert on error
          },
        }
      );
    } else {
      // ── Block still has health — record hit progress ──────────────────────
      breakingRef.current.set(key, { hits: newHits, maxHits });
    }
  }, [mode, selectedBlock, gameAction, refetchWorld, refetchInventory, toast]);

  // Mouse click → interact
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    interactBlock(e.clientX, e.clientY);
  }, [interactBlock]);

  // Touch tap on canvas → interact (single finger only — ignores pinch)
  const handleCanvasTouch = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    // Only process single-finger taps, never fire during pinch zoom
    if (e.changedTouches.length !== 1 || isPinchingRef.current) return;
    e.preventDefault(); // Prevent the tap from also firing a mouse click event
    const touch = e.changedTouches[0];
    interactBlock(touch.clientX, touch.clientY);
  }, [interactBlock]);

  // Clear crack progress when world refreshes (blocks regenerate to full health)
  useEffect(() => {
    breakingRef.current.clear();
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════════
  // MOBILE D-PAD MOVEMENT
  // Called by the ◀ JUMP ▶ buttons. Checks isPinchingRef before moving —
  // if the user has two fingers on screen (zooming), this does nothing.
  // ════════════════════════════════════════════════════════════════════════════
  const mobileMove = (dir: "left" | "right" | "stop" | "jump") => {
    // Guard: never fire movement during pinch-zoom (2+ fingers on screen)
    if (isPinchingRef.current) return;
    const p = physRef.current;
    if (dir === "left")  { p.vx = -MOVE_SPEED; p.facingRight = false; }
    if (dir === "right") { p.vx =  MOVE_SPEED; p.facingRight = true;  }
    if (dir === "stop")  { p.vx = 0; }
    if (dir === "jump" && p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
  };

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Global pinch-zoom detection
  // Listens for touchstart/touchend on the entire window.
  // When 2+ fingers are down anywhere, isPinchingRef = true.
  // The D-pad and canvas touch handler both check this flag.
  // This prevents accidental left/right movement when the user pinches to zoom.
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) {
        // Two or more fingers — user is pinching, disable movement
        isPinchingRef.current = true;
        physRef.current.vx    = 0; // Stop any current movement immediately
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      // Re-enable movement once fewer than 2 fingers remain on screen
      if (e.touches.length < 2) {
        isPinchingRef.current = false;
      }
    };

    // passive: true — we never call preventDefault here, so this is safe
    window.addEventListener("touchstart",  onTouchStart, { passive: true });
    window.addEventListener("touchend",    onTouchEnd,   { passive: true });
    window.addEventListener("touchcancel", onTouchEnd,   { passive: true });

    return () => {
      window.removeEventListener("touchstart",  onTouchStart);
      window.removeEventListener("touchend",    onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // ── Filter inventory to only placeable blocks for the hotbar ─────────────
  // Players collect blocks when mining and can place them back to build worlds.
  // Machine blocks appear here after crafting them at the workbench.
  const hotbarItems = inventory.filter((i) => PLACEABLE.has(i.itemId) && i.quantity > 0);

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // Layout: Top HUD → Canvas (+ Chat panel) → Block Hotbar → Mobile D-Pad
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col h-full bg-background overflow-hidden select-none"
    >

      {/* ── TOP HUD ──────────────────────────────────────────────────────────
          Shows: Player name | Mine/Place mode toggle | Energy | Gems | Chat */}
      <div className="flex justify-between items-center px-2 py-1.5 bg-black/95 border-b border-border z-10 shrink-0 gap-2 flex-wrap">

        {/* Player name badge */}
        <div className="bg-black/60 px-2 py-1 rounded border border-primary/20 font-mono">
          <span className="text-muted-foreground uppercase block leading-none text-[9px]">Player</span>
          <span className="text-white font-bold text-xs">{username}</span>
        </div>

        {/* Right-side controls */}
        <div className="flex items-center gap-1.5 flex-wrap">

          {/* Mine / Place mode toggle
              MINE (red)  — click blocks to break them
              PLACE (blue) — click empty cells to place the selected block */}
          <div className="flex border border-border rounded overflow-hidden font-mono text-[10px]">
            <button
              onClick={() => setMode("punch")}
              className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${
                mode === "punch"
                  ? "bg-red-600 text-white"
                  : "bg-black/40 text-muted-foreground hover:text-red-400"
              }`}
            >
              ⛏ Mine
            </button>
            <button
              onClick={() => setMode("place")}
              className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${
                mode === "place"
                  ? "bg-blue-600 text-white"
                  : "bg-black/40 text-muted-foreground hover:text-blue-400"
              }`}
            >
              🧱 Place
            </button>
          </div>

          {/* Energy counter — decreases with each action (anti-grind) */}
          <div className="bg-black/60 px-2 py-1 rounded border border-accent/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Energy</span>
            <div className="flex items-center text-accent font-bold">
              <Zap className="w-3 h-3 mr-0.5" />{wallet?.actionCount ?? 0}/100
            </div>
          </div>

          {/* Gem balance */}
          <div className="bg-black/60 px-2 py-1 rounded border border-primary/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Gems</span>
            <span className="text-primary font-bold">{wallet?.gems ?? 0} 💎</span>
          </div>

          {/* Chat toggle button */}
          <button
            onClick={() => setChatOpen((s) => !s)}
            className={`p-1.5 rounded border transition-colors ${
              chatOpen
                ? "border-primary text-primary bg-primary/10"
                : "border-border text-muted-foreground hover:text-primary"
            }`}
            title="World Chat"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── CANVAS + CHAT PANEL ──────────────────────────────────────────────
          The canvas fills available space. Chat panel slides in from the right. */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Game canvas wrapper — touch-action:none prevents browser pinch-zoom
            from interfering with the canvas itself while still allowing the
            rest of the page to zoom normally. */}
        <div
          className="flex-1 bg-[#050d14] flex items-center justify-center relative overflow-hidden"
          style={{ touchAction: "none" }}
        >
          <canvas
            ref={canvasRef}
            width={WW}
            height={WH}
            onClick={handleCanvasClick}
            onTouchEnd={handleCanvasTouch}   // Mobile tap-to-mine/place
            className="max-w-full max-h-full object-contain border border-border/30"
            style={{
              imageRendering: "pixelated",   // Crisp pixel art (no anti-aliasing)
              cursor: mode === "place" ? "cell" : "crosshair",
              touchAction: "none",           // Prevent browser zoom on canvas touch
            }}
          />

          {/* Mode indicator floating over canvas — tells mobile users what mode they're in */}
          <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase pointer-events-none ${
            mode === "place" ? "bg-blue-600/80 text-white" : "bg-red-600/80 text-white"
          }`}>
            {mode === "place"
              ? `📦 PLACE: ${selectedBlock ? (BLOCK_LABELS[selectedBlock] ?? selectedBlock) : "pick block below"}`
              : "⛏ TAP BLOCKS TO MINE"}
          </div>
        </div>

        {/* Chat panel — collapsible side panel showing world chat */}
        {chatOpen && (
          <div className="w-48 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0">
            {/* Chat header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-primary font-bold text-[10px] uppercase tracking-widest">World Chat</span>
              <button onClick={() => setChatOpen(false)}>
                <X className="w-3 h-3 text-muted-foreground hover:text-white" />
              </button>
            </div>
            {/* Message list */}
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
            {/* Message input */}
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

      {/* ── GROWTOPIA-STYLE BLOCK HOTBAR ────────────────────────────────────
          Shows all placeable blocks from inventory.
          Clicking a block: selects it and switches to Place mode.
          Machine blocks (Solar, Core, Cable) appear here after crafting. */}
      <div className="flex items-center gap-1.5 px-2 py-2 bg-black/90 border-t border-border shrink-0 overflow-x-auto">
        <span className="text-muted-foreground text-[9px] uppercase font-mono tracking-wider whitespace-nowrap mr-1 shrink-0">
          Blocks:
        </span>

        {hotbarItems.length === 0 ? (
          // Empty hotbar message
          <span className="text-muted-foreground text-[9px] font-mono italic">
            Mine blocks or craft machines to build
          </span>
        ) : (
          hotbarItems.map((item) => (
            <button
              key={item.itemId}
              onClick={() => {
                // Select this block and automatically switch to place mode
                setSelectedBlock(item.itemId);
                setMode("place");
              }}
              className={`flex flex-col items-center px-2 py-1.5 rounded border text-[9px] font-mono transition-all shrink-0 min-w-[48px] ${
                selectedBlock === item.itemId && mode === "place"
                  ? "border-blue-400 bg-blue-400/20 text-white shadow-[0_0_8px_rgba(96,165,250,0.4)]" // selected highlight
                  : "border-border bg-black/50 text-muted-foreground hover:border-white/30 hover:text-white"
              }`}
              title={`Place ${BLOCK_LABELS[item.itemId] ?? item.itemId}`}
            >
              {/* Color swatch matching the block's in-world color */}
              <span
                className="w-6 h-6 rounded-sm mb-0.5 border border-black/40 block"
                style={{ backgroundColor: BLOCK_COLORS[item.itemId] ?? "#888" }}
              />
              <span className="uppercase leading-none">{BLOCK_LABELS[item.itemId] ?? item.itemId}</span>
              {/* Stack count badge */}
              <span className="text-primary font-bold">×{item.quantity}</span>
            </button>
          ))
        )}

        {/* Cancel place mode button — visible only when in place mode */}
        {mode === "place" && (
          <button
            onClick={() => { setMode("punch"); setSelectedBlock(null); }}
            className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1.5 rounded hover:bg-red-400/10"
            title="Cancel place mode"
          >
            ✕ Cancel
          </button>
        )}
      </div>

      {/* ── MOBILE D-PAD CONTROLLER ─────────────────────────────────────────
          Hidden on desktop (md:hidden). Layout: [◀] [  JUMP  ] [▶]
          touch-action:none on the wrapper ensures the browser does NOT intercept
          these touches for page scrolling, so taps register instantly.
          All buttons check isPinchingRef — if the user has 2 fingers on screen
          (pinch zoom), movement is blocked until they lift back to 1 finger. */}
      <div
        className="md:hidden flex items-center gap-2 px-3 py-2 bg-black/95 border-t border-border shrink-0"
        style={{ touchAction: "manipulation" }} // Tells browser: tap only, no scroll
      >
        {/* Left arrow button */}
        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold
                     active:bg-primary/20 active:border-primary select-none flex items-center justify-center
                     transition-colors"
          onPointerDown={(e) => { e.preventDefault(); mobileMove("left");  }}
          onPointerUp={(e)   => { e.preventDefault(); mobileMove("stop");  }}
          onPointerLeave={(e)=> { e.preventDefault(); mobileMove("stop");  }}
          style={{ touchAction: "none" }} // Disable all browser touch behaviour on this button
        >
          ◀
        </button>

        {/* Jump button — wide, center */}
        <button
          className="flex-1 h-14 rounded-xl bg-primary/20 border-2 border-primary text-primary font-black
                     text-sm uppercase tracking-widest active:bg-primary active:text-black select-none
                     transition-colors"
          onPointerDown={(e) => { e.preventDefault(); mobileMove("jump"); }}
          style={{ touchAction: "none" }}
        >
          JUMP
        </button>

        {/* Right arrow button */}
        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold
                     active:bg-primary/20 active:border-primary select-none flex items-center justify-center
                     transition-colors"
          onPointerDown={(e) => { e.preventDefault(); mobileMove("right"); }}
          onPointerUp={(e)   => { e.preventDefault(); mobileMove("stop");  }}
          onPointerLeave={(e)=> { e.preventDefault(); mobileMove("stop");  }}
          style={{ touchAction: "none" }}
        >
          ▶
        </button>
      </div>

      {/* ── ANTI-BOT WIZARD CHALLENGE MODAL ─────────────────────────────────
          Appears when the server detects too many rapid actions (>30 in 2 min).
          Player must answer a simple math question to continue playing.
          This is a lightweight anti-cheat to slow bots — not meant to be hard. */}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center tracking-widest uppercase text-sm">
              <TriangleAlert className="mr-2 w-4 h-4" /> Anti-Bot Verification
            </DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground text-sm">
              High action rate detected. Solve to continue:
            </p>
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
