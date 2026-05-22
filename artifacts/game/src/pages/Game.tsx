// ============================================================
// Game.tsx — Main 2D game world with Growtopia-style mechanics
// Features: gravity physics, crack animation, block placing,
//           day/night cycle, multiplayer chat, wrench tool
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert, MessageSquare, SendHorizonal } from "lucide-react";

// ─── World / Canvas constants ────────────────────────────────────────────────
const BS   = 40;          // Block size: every grid cell is 40×40 pixels
const WW   = 800;         // Canvas pixel width  (20 blocks × 40px)
const WH   = 600;         // Canvas pixel height (15 blocks × 40px)

// ─── Physics constants ───────────────────────────────────────────────────────
const GRAVITY    = 900;   // Gravity acceleration (px/s²) — feel of weight
const JUMP_VY    = -420;  // Jump initial velocity (negative = upward)
const MOVE_SPEED = 175;   // Horizontal walk speed (px/s)
const PW         = 26;    // Player hitbox width  (px)
const PH         = 36;    // Player hitbox height (px)

// ─── Day/Night cycle ─────────────────────────────────────────────────────────
const DAY_MS = 480_000;   // Full day/night cycle = 8 minutes

// ─── Mining balance (hit counts per block type) ──────────────────────────────
// Growtopia-style: each block requires N punches before it breaks.
// Lower number = easier to mine. Grass is instant (1 punch), diamond needs 5.
const BLOCK_HITS: Record<string, number> = {
  block_grass:   1,  // Surface layer — very easy
  block_dirt:    2,  // Sub-surface    — easy
  block_rock:    3,  // Stone layer    — medium
  block_iron:    4,  // Iron ore       — harder
  block_gold:    3,  // Gold ore       — medium (reward outweighs effort)
  block_diamond: 5,  // Diamond ore    — hardest
  block_lava:    4,  // Lava block     — dangerous, hard
};

// ─── Block visual colors (canvas fillStyle) ──────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass:   "#15803d",
  block_dirt:    "#78350f",
  block_rock:    "#374151",
  block_iron:    "#6b7280",
  block_gold:    "#b45309",
  block_diamond: "#0e7490",
  block_lava:    "#b91c1c",
};

// ─── Block highlight tints (top edge shimmer) ────────────────────────────────
const BLOCK_TINTS: Record<string, string> = {
  block_grass:   "rgba(74,222,128,0.25)",
  block_dirt:    "rgba(180,130,80,0.20)",
  block_rock:    "rgba(200,200,220,0.12)",
  block_iron:    "rgba(210,220,230,0.20)",
  block_gold:    "rgba(255,220,50,0.35)",
  block_diamond: "rgba(100,240,255,0.30)",
  block_lava:    "rgba(255,120,0,0.40)",
};

// ─── Display names for hotbar labels ─────────────────────────────────────────
const BLOCK_LABELS: Record<string, string> = {
  block_grass: "Grass",
  block_dirt:  "Dirt",
  block_rock:  "Rock",
};

// ─── Which inventory items can be placed as world blocks ─────────────────────
// Players get these items back when they mine the corresponding block,
// and can place them back anywhere in the world (Growtopia mechanic)
const PLACEABLE = new Set(["block_grass", "block_dirt", "block_rock"]);

// ─── Max punch reach in block-units ─────────────────────────────────────────
// Player can mine/place blocks up to 3.5 cells away from their center
const REACH = 3.5;

// ─── Day/Night sky computation ───────────────────────────────────────────────
// Returns sky color and overlay alpha based on current time in the cycle.
// t=0 is midnight, t=0.5 is noon.
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };
function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS;
  if (t < 0.12) {
    // Midnight → first light
    const f = t / 0.12;
    return { r: 255, g: Math.round(80 * f), b: 0, alpha: 0.70 - 0.60 * f, stars: f < 0.6 };
  } else if (t < 0.22) {
    // Dawn — orange to blue
    const f = (t - 0.12) / 0.10;
    return { r: 255, g: Math.round(80 + 140 * f), b: Math.round(160 * f), alpha: 0.10 - 0.10 * f, stars: false };
  } else if (t < 0.55) {
    // Full daytime — clear sky
    return { r: 135, g: 206, b: 235, alpha: 0, stars: false };
  } else if (t < 0.68) {
    // Dusk
    const f = (t - 0.55) / 0.13;
    return { r: 255, g: Math.round(200 - 120 * f), b: Math.round(50 - 50 * f), alpha: 0.12 * f, stars: false };
  } else if (t < 0.78) {
    // Dusk → night
    const f = (t - 0.68) / 0.10;
    return { r: 255, g: Math.round(80 - 80 * f), b: 0, alpha: 0.12 + 0.58 * f, stars: f > 0.5 };
  }
  // Full night
  return { r: 0, g: 0, b: 20, alpha: 0.70, stars: true };
}

// ─── Crack overlay renderer ──────────────────────────────────────────────────
// Draws progressive crack patterns over a block as it takes damage.
// progress: 0.0 (fresh) → 1.0 (about to break). stage 1-4 adds more cracks.
function drawCracks(ctx: CanvasRenderingContext2D, bx: number, by: number, progress: number) {
  const x = bx * BS;
  const y = by * BS;

  // Stage 0: no cracks yet (below 20% damage)
  if (progress < 0.2) return;

  const stage = Math.min(4, Math.floor(progress * 5)); // 1-4

  // Darken the block as it takes more damage
  ctx.fillStyle = `rgba(0,0,0,${progress * 0.55})`;
  ctx.fillRect(x + 1, y + 1, BS - 2, BS - 2);

  // Draw crack lines — deterministic patterns per stage
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 2;

  // Stage 1: one small crack from top-left area
  if (stage >= 1) {
    ctx.beginPath();
    ctx.moveTo(x + 8,  y + 6);
    ctx.lineTo(x + 18, y + 16);
    ctx.lineTo(x + 14, y + 22);
    ctx.stroke();
  }

  // Stage 2: second crack from the right side
  if (stage >= 2) {
    ctx.beginPath();
    ctx.moveTo(x + 30, y + 8);
    ctx.lineTo(x + 22, y + 20);
    ctx.lineTo(x + 28, y + 30);
    ctx.stroke();
  }

  // Stage 3: crack across the middle + corner chip
  if (stage >= 3) {
    ctx.beginPath();
    ctx.moveTo(x + 4,  y + 28);
    ctx.lineTo(x + 16, y + 22);
    ctx.lineTo(x + 26, y + 34);
    ctx.stroke();
    // Corner chip
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x + 2, y + 2, 5, 5);
    ctx.fillRect(x + 33, y + 30, 5, 5);
  }

  // Stage 4: severe cracking, multiple radiating lines
  if (stage >= 4) {
    ctx.lineWidth = 2;
    // Horizontal fault line
    ctx.beginPath();
    ctx.moveTo(x + 2,  y + 20);
    ctx.lineTo(x + 38, y + 18);
    ctx.stroke();
    // Vertical crack
    ctx.beginPath();
    ctx.moveTo(x + 20, y + 2);
    ctx.lineTo(x + 18, y + 38);
    ctx.stroke();
    // Extra corner chips
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(x + 1,  y + 1,  4, 4);
    ctx.fillRect(x + 35, y + 1,  4, 4);
    ctx.fillRect(x + 1,  y + 35, 4, 4);
    ctx.fillRect(x + 35, y + 35, 4, 4);
  }

  ctx.restore();
}

// ─── Punch flash renderer ────────────────────────────────────────────────────
// Draws a brief bright flash over a block when it's punched
function drawPunchFlash(ctx: CanvasRenderingContext2D, bx: number, by: number, alpha: number) {
  ctx.fillStyle = `rgba(255,255,200,${alpha * 0.5})`;
  ctx.fillRect(bx * BS + 2, by * BS + 2, BS - 4, BS - 4);
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function Game() {
  // ── Auth (stored in localStorage after login) ───────────────────────────
  const userId  = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";

  // Canvas element ref — the 2D drawing surface
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Server data hooks ────────────────────────────────────────────────────
  // World grid: 20×15 array of block names (e.g. "block_dirt", "air")
  const { data: world, refetch: refetchWorld } = useGetWorld("start", {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") },
  });
  // Player wallet: gems, energy (action_count), real_balance
  const { data: wallet } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  // Inventory: list of {itemId, quantity} the player is carrying
  const { data: inventory = [], refetch: refetchInventory } = useGetInventory({
    query: { enabled: !!userId, queryKey: getGetInventoryQueryKey(), refetchInterval: 5000 },
  });

  // Server-side action mutation (break/place blocks)
  const gameAction = useGameAction();
  const { toast } = useToast();

  // ── Physics state (stored in ref to avoid re-renders every frame) ────────
  const physRef = useRef({
    px: 5 * BS,       // X position in pixels
    py: 0,            // Y position in pixels (set properly once world loads)
    vx: 0,            // Horizontal velocity (px/s)
    vy: 0,            // Vertical velocity (px/s)
    onGround: false,  // Whether player is standing on a solid block
    facingRight: true,// Direction player faces (affects tool/sprite rendering)
    spawned: false,   // Has the initial spawn position been set?
  });

  // Set of currently held keys (e.g. "ArrowLeft", "d") for smooth movement
  const keysRef   = useRef<Set<string>>(new Set());
  // Local copy of world grid for the game loop (avoids React re-render lag)
  const worldRef  = useRef<string[][] | null>(null);
  // requestAnimationFrame handle for cleanup
  const rafRef    = useRef(0);
  // Timestamp of the last frame (for delta-time physics)
  const lastTRef  = useRef(0);

  // ── Breaking animation state ─────────────────────────────────────────────
  // Maps "x,y" → { hits: currentHits, maxHits: blocksRequiredHits }
  const breakingRef = useRef<Map<string, { hits: number; maxHits: number }>>(new Map());
  // Maps "x,y" → flash alpha (0-1, fades over a few frames)
  const flashRef    = useRef<Map<string, number>>(new Map());
  // Tracks if we're waiting for a server response (to prevent double-clicks)
  const pendingBreakRef = useRef(false);

  // ── UI state (mode, selection, dialogs, chat) ────────────────────────────
  // "punch" = break blocks by clicking; "place" = place selected block
  const [mode,          setMode]         = useState<"punch" | "place">("punch");
  const [selectedBlock, setSelectedBlock] = useState<string | null>(null);
  const [wizard,        setWizard]        = useState(false);
  const [wizardAns,     setWizardAns]     = useState("");
  const [chatOpen,      setChatOpen]      = useState(false);
  const [chatMsgs,      setChatMsgs]      = useState<{ username: string; message: string }[]>([]);
  const [chatInput,     setChatInput]     = useState("");

  // ── WebSocket for multiplayer chat ───────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);

  // ── Static star positions (computed once, reused every frame) ────────────
  const starsRef = useRef(
    Array.from({ length: 90 }, () => ({
      x:       Math.random() * WW,
      y:       Math.random() * WH * 0.55,
      r:       Math.random() * 1.5 + 0.4,
      twinkle: Math.random() * Math.PI * 2,  // phase offset for twinkling
    }))
  );

  // ════════════════════════════════════════════════════════════════════════
  // Effect: Sync world data from server into the local ref
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;

    // On first load: find the first air block in column 5 and spawn player there
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
  // Effect: Connect to WebSocket chat server
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { username: string; message: string };
        // Keep last 30 messages in memory
        setChatMsgs((prev) => [...prev.slice(-29), m]);
      } catch { /* ignore malformed messages */ }
    };
    return () => ws.close();
  }, []);

  // Send a chat message over WebSocket
  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ username, message: chatInput.trim() }));
    setChatInput("");
  };

  // ════════════════════════════════════════════════════════════════════════
  // Helper: Is block at grid position (bx, by) solid (non-air)?
  // Used for physics collision detection every frame.
  // ════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx: number, by: number): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0)  return false;                   // Above world = open sky
    if (by >= bd.length) return true;             // Below world = solid ground
    if (bx < 0 || bx >= bd[0].length) return true; // World edges = walls
    return bd[by][bx] !== "air";
  }, []);

  // ════════════════════════════════════════════════════════════════════════
  // Main render/physics loop — runs every animation frame (~60fps)
  // ════════════════════════════════════════════════════════════════════════
  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Delta time: seconds since last frame (capped at 50ms to handle tab switching)
    const dt = Math.min((now - lastTRef.current) / 1000, 0.05);
    lastTRef.current = now;

    const p  = physRef.current;
    const bd = worldRef.current;

    // ── PHYSICS UPDATE ────────────────────────────────────────────────────
    if (bd) {
      // Horizontal movement with AABB collision
      const npx  = p.px + p.vx * dt;
      const ty0  = Math.floor((p.py + 2)        / BS);  // top of player
      const ty1  = Math.floor((p.py + PH - 2)   / BS);  // bottom of player

      if (p.vx > 0) {
        // Moving right: check right edge of player
        const tx = Math.floor((npx + PW) / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = tx * BS - PW;  // snap to wall
      } else if (p.vx < 0) {
        // Moving left: check left edge of player
        const tx = Math.floor(npx / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = (tx + 1) * BS;  // snap to wall
      }
      // Clamp to world horizontal bounds
      p.px = Math.max(0, Math.min(bd[0].length * BS - PW, p.px));

      // Vertical movement: apply gravity then check floor/ceiling collision
      p.vy = Math.min(p.vy + GRAVITY * dt, 850);  // terminal velocity 850px/s
      const npy  = p.py + p.vy * dt;
      const tx0  = Math.floor((p.px + 2)      / BS);   // left side of player
      const tx1  = Math.floor((p.px + PW - 2) / BS);   // right side of player
      p.onGround = false;

      if (p.vy >= 0) {
        // Falling — check feet
        const ty = Math.floor((npy + PH) / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = ty * BS - PH;   // land on top of block
          p.vy = 0;
          p.onGround = true;
        } else {
          p.py = npy;
        }
      } else {
        // Rising — check head
        const ty = Math.floor(npy / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) {
          p.py = (ty + 1) * BS;  // bump head on block above
          p.vy = 0;
        } else {
          p.py = npy;
        }
      }
      // Clamp to world vertical bounds
      p.py = Math.max(0, Math.min(bd.length * BS - PH, p.py));
    }

    // ── CLEAR CANVAS ─────────────────────────────────────────────────────
    ctx.clearRect(0, 0, WW, WH);

    // ── SKY BACKGROUND ────────────────────────────────────────────────────
    const sky  = getSky(now);
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) {
      // Night: dark, with reddish/purple tones
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(1, "#0a0010");
    } else {
      // Day: blue sky gradient
      grad.addColorStop(0, "#1a3a5c");
      grad.addColorStop(0.5, "#0f2035");
      grad.addColorStop(1, "#050d14");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WW, WH);

    // ── STARS (visible at night) ──────────────────────────────────────────
    if (sky.stars && sky.alpha > 0.1) {
      const starAlpha = Math.min(1, (sky.alpha - 0.1) * 2);
      starsRef.current.forEach((s) => {
        // Sinusoidal twinkle based on time and individual phase
        const tw = 0.7 + 0.3 * Math.sin(now / 800 + s.twinkle);
        ctx.fillStyle = `rgba(255,255,255,${starAlpha * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // ── SUN OR MOON ARC ───────────────────────────────────────────────────
    const t = (now % DAY_MS) / DAY_MS;
    if (sky.alpha < 0.4) {
      // Daytime: draw sun traversing a wide arc above the world
      const sunAngle = t * Math.PI * 2 - Math.PI / 2;
      const sx = WW / 2 + Math.cos(sunAngle) * 320;
      const sy = WH * 0.5 + Math.sin(sunAngle) * 280;
      if (sy < WH * 0.55) {
        const sunGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28);
        sunGrad.addColorStop(0, "rgba(255,240,100,1)");
        sunGrad.addColorStop(0.5, "rgba(255,180,0,0.8)");
        sunGrad.addColorStop(1,   "rgba(255,140,0,0)");
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, 28, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (sky.alpha > 0.5) {
      // Nighttime: crescent moon (full circle with offset circle cut from it)
      const moonAngle = (t + 0.5) * Math.PI * 2 - Math.PI / 2;
      const mx = WW / 2 + Math.cos(moonAngle) * 320;
      const my = WH * 0.5 + Math.sin(moonAngle) * 280;
      if (my < WH * 0.55) {
        ctx.fillStyle = "rgba(220,230,255,0.9)";
        ctx.beginPath(); ctx.arc(mx, my, 16, 0, Math.PI * 2); ctx.fill();
        // "Bite" out of moon to make crescent shape
        ctx.fillStyle = "rgba(10,0,30,0.85)";
        ctx.beginPath(); ctx.arc(mx + 6, my - 4, 13, 0, Math.PI * 2); ctx.fill();
      }
    }

    // ── BLOCKS ────────────────────────────────────────────────────────────
    if (bd) {
      for (let y = 0; y < bd.length; y++) {
        for (let x = 0; x < bd[y].length; x++) {
          const blk = bd[y][x];
          if (blk === "air") continue;

          // Base block color
          ctx.fillStyle = BLOCK_COLORS[blk] ?? "#1e293b";
          ctx.fillRect(x * BS, y * BS, BS, BS);

          // Top-edge highlight shimmer (makes blocks look 3D)
          const tint = BLOCK_TINTS[blk] ?? "rgba(255,255,255,0.07)";
          ctx.fillStyle = tint;
          ctx.fillRect(x * BS + 1, y * BS + 1, BS - 2, 5);

          // Block border (darkened edge)
          ctx.strokeStyle = "rgba(0,0,0,0.4)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x * BS + 0.5, y * BS + 0.5, BS - 1, BS - 1);
        }
      }

      // ── CRACK OVERLAYS (drawn on top of blocks) ────────────────────────
      // Render crack progress for any block currently being mined
      breakingRef.current.forEach(({ hits, maxHits }, key) => {
        const [bxStr, byStr] = key.split(",");
        const bx = parseInt(bxStr);
        const by = parseInt(byStr);
        const progress = hits / maxHits;   // 0.0 → 1.0
        drawCracks(ctx, bx, by, progress);
      });

      // ── PUNCH FLASH (brief white flash when a block is hit) ───────────
      // Fade each flash by subtracting alpha each frame
      flashRef.current.forEach((alpha, key) => {
        const [bxStr, byStr] = key.split(",");
        drawPunchFlash(ctx, parseInt(bxStr), parseInt(byStr), alpha);
        const newAlpha = alpha - 0.18;  // fade speed
        if (newAlpha <= 0) flashRef.current.delete(key);
        else flashRef.current.set(key, newAlpha);
      });

      // ── PLACE PREVIEW (ghost block under cursor, shown in place mode) ─
      // Handled in canvasRef onMouseMove — see below
    }

    // ── PLAYER SPRITE ─────────────────────────────────────────────────────
    const { px, py, facingRight: fr } = p;

    // Body (dark green shirt)
    ctx.fillStyle = "#1e4d2b";
    ctx.fillRect(px + 5, py + 14, PW - 10, PH - 14);

    // Head (skin tone)
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(px + 3, py + 2, PW - 6, 14);

    // Eye (always facing movement direction)
    ctx.fillStyle = "#000";
    ctx.fillRect(fr ? px + 13 : px + 5, py + 7, 4, 4);

    // Neon green eye glow (hacker aesthetic)
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(fr ? px + 14 : px + 6, py + 8, 2, 2);

    // Tool indicator — what the player is holding
    if (mode === "place" && selectedBlock) {
      // Show a tiny colored square representing the selected block
      ctx.fillStyle = BLOCK_COLORS[selectedBlock] ?? "#aaa";
      ctx.fillRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.strokeRect(fr ? px + PW + 2 : px - 8, py + 14, 6, 6);
    } else {
      // Pickaxe handle (gray shaft + darker head)
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(fr ? px + PW + 1 : px - 5, py + 16, 4, 14);
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(fr ? px + PW : px - 6,   py + 13, 6, 6);
    }

    // ── NIGHT OVERLAY (darkens the whole scene) ───────────────────────────
    if (sky.alpha > 0) {
      ctx.fillStyle = `rgba(0,0,20,${sky.alpha * 0.45})`;
      ctx.fillRect(0, 0, WW, WH);
    }

    // ── CRT SCANLINES (retro effect, subtle) ─────────────────────────────
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    for (let scanY = 0; scanY < WH; scanY += 4) {
      ctx.fillRect(0, scanY, WW, 2);
    }

    // Schedule next frame
    rafRef.current = requestAnimationFrame(drawFrame);
  }, [solid, mode, selectedBlock]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: Start the game loop
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    lastTRef.current = performance.now();
    rafRef.current   = requestAnimationFrame(drawFrame);
    // Cleanup: cancel animation frame when component unmounts
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame]);

  // ════════════════════════════════════════════════════════════════════════
  // Effect: Keyboard controls
  // ════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      const p = physRef.current;
      // Start horizontal movement
      if (["ArrowLeft",  "a", "A"].includes(e.key)) { p.vx = -MOVE_SPEED; p.facingRight = false; }
      if (["ArrowRight", "d", "D"].includes(e.key)) { p.vx =  MOVE_SPEED; p.facingRight = true;  }
      // Jump — only if standing on ground
      if ([" ", "ArrowUp", "w", "W"].includes(e.key) && p.onGround) {
        p.vy = JUMP_VY;
        p.onGround = false;
        e.preventDefault();  // prevent page scroll on Space
      }
    };

    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      const keys = keysRef.current;
      // Stop moving when no horizontal keys are held
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
  // Canvas click handler — mine blocks (punch mode) or place blocks (place mode)
  // ════════════════════════════════════════════════════════════════════════
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Convert screen coordinates → world grid cell (bx, by)
    // The canvas may be scaled by CSS, so divide by rect size, multiply by logical size
    const bx = Math.floor(((e.clientX - rect.left)  / rect.width)  * WW / BS);
    const by = Math.floor(((e.clientY - rect.top)   / rect.height) * WH / BS);
    const bd = worldRef.current;
    if (!bd) return;

    // Bounds check
    if (bx < 0 || by < 0 || bx >= bd[0].length || by >= bd.length) return;

    // Player center in block-units (for distance check)
    const p   = physRef.current;
    const pcx = (p.px + PW / 2) / BS;
    const pcy = (p.py + PH / 2) / BS;
    const dist = Math.sqrt((bx - pcx) ** 2 + (by - pcy) ** 2);

    // Enforce reach limit
    if (dist > REACH) {
      toast({
        title: "OUT OF REACH",
        description: "Move closer to mine or place.",
        className: "bg-black border-border text-muted-foreground font-mono text-xs",
      });
      return;
    }

    // ── PLACE MODE: place the selected block on an air cell ─────────────
    if (mode === "place" && selectedBlock) {
      if (bd[by][bx] !== "air") {
        toast({ title: "BLOCKED", description: "That space is already occupied.", className: "bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
        return;
      }
      // Optimistically update local world (feels instant)
      const updated = bd.map((row) => [...row]);
      updated[by][bx] = selectedBlock;
      worldRef.current = updated;

      // Send place action to server
      gameAction.mutate(
        { data: { actionType: "place", worldName: "start", x: bx, y: by, placeBlock: selectedBlock } },
        {
          onSuccess: (data) => {
            if (data.success) {
              refetchWorld();
              refetchInventory();
            } else {
              // Revert optimistic update on failure
              worldRef.current = bd;
              toast({ title: "PLACE FAILED", variant: "destructive" });
            }
          },
          onError: () => { worldRef.current = bd; },
        }
      );
      return;
    }

    // ── PUNCH MODE: mine blocks using multi-hit crack system ─────────────
    if (bd[by][bx] === "air") return;   // Nothing to punch

    const key     = `${bx},${by}`;
    const blkType = bd[by][bx];
    const maxHits = BLOCK_HITS[blkType] ?? 3;

    // Get or initialize breaking progress for this block
    const current = breakingRef.current.get(key) ?? { hits: 0, maxHits };

    // Add punch flash effect
    flashRef.current.set(key, 1.0);

    // Face the direction of the block being punched
    physRef.current.facingRight = bx >= pcx;

    const newHits = current.hits + 1;

    if (newHits >= maxHits) {
      // ── Block is fully broken — send to server ─────────────────────
      if (pendingBreakRef.current) return;  // debounce: one request at a time
      pendingBreakRef.current = true;
      breakingRef.current.delete(key);

      // Optimistic: immediately remove block visually
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
            // Revert optimistic removal on error
            worldRef.current = bd;
          },
        }
      );
    } else {
      // ── Block still has health left — record hit progress ──────────
      breakingRef.current.set(key, { hits: newHits, maxHits });
    }
  }, [mode, selectedBlock, gameAction, refetchWorld, refetchInventory, toast]);

  // ── Reset crack progress when world refreshes (blocks regenerate) ─────
  useEffect(() => {
    breakingRef.current.clear();
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════
  // Mobile D-pad controls (touch-friendly)
  // ════════════════════════════════════════════════════════════════════════
  const mobileMove = (dir: "left" | "right" | "stop" | "jump") => {
    const p = physRef.current;
    if (dir === "left")  { p.vx = -MOVE_SPEED; p.facingRight = false; }
    if (dir === "right") { p.vx =  MOVE_SPEED; p.facingRight = true;  }
    if (dir === "stop")  { p.vx = 0; }
    if (dir === "jump" && p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
  };

  // ── Filter inventory to only placeable blocks for the hotbar ─────────
  // These are blocks the player collected by mining (grass/dirt/rock)
  const hotbarItems = inventory.filter((i) => PLACEABLE.has(i.itemId) && i.quantity > 0);

  // ════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="flex flex-col h-full bg-background overflow-hidden"
    >
      {/* ── TOP HUD ─────────────────────────────────────────────────────── */}
      <div className="flex justify-between items-center px-3 py-1.5 bg-sidebar/95 border-b border-border z-10 shrink-0 gap-2">

        {/* Left: player name badge */}
        <div className="flex items-center gap-2 font-mono text-xs">
          <div className="bg-black/50 px-2 py-1 rounded border border-primary/20">
            <span className="text-muted-foreground uppercase block leading-none text-[10px] mb-0.5">Player</span>
            <span className="text-white font-bold">{username}</span>
          </div>
        </div>

        {/* Right: mode toggle + stats + chat */}
        <div className="flex items-center gap-1.5">

          {/* Mode toggle: PUNCH vs PLACE */}
          <div className="flex border border-border rounded overflow-hidden font-mono text-[10px]">
            <button
              onClick={() => setMode("punch")}
              className={`px-2 py-1.5 font-bold uppercase transition-colors ${
                mode === "punch"
                  ? "bg-red-600 text-white"
                  : "bg-black/40 text-muted-foreground hover:text-red-400"
              }`}
              title="Punch mode — click blocks to mine them"
            >
              👊 Punch
            </button>
            <button
              onClick={() => { setMode("place"); }}
              className={`px-2 py-1.5 font-bold uppercase transition-colors ${
                mode === "place"
                  ? "bg-blue-600 text-white"
                  : "bg-black/40 text-muted-foreground hover:text-blue-400"
              }`}
              title="Place mode — select a block below then click to place"
            >
              🧱 Place
            </button>
          </div>

          {/* Energy / action counter */}
          <div className="bg-black/50 px-2 py-1 rounded border border-accent/30 text-xs font-mono">
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

          {/* Chat toggle button */}
          <button
            onClick={() => setChatOpen((s) => !s)}
            className={`p-1.5 rounded border transition-colors ${
              chatOpen ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:text-primary"
            }`}
            title="World Chat"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* ── CANVAS + CHAT PANEL ──────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Main game canvas */}
        <div className="flex-1 bg-[#050d14] flex items-center justify-center relative overflow-hidden">
          <canvas
            ref={canvasRef}
            width={WW}
            height={WH}
            onClick={handleCanvasClick}
            className="max-w-full max-h-full object-contain border border-border/30"
            style={{ imageRendering: "pixelated", cursor: mode === "place" ? "cell" : "crosshair" }}
          />
        </div>

        {/* Chat panel (collapsible, right side) */}
        {chatOpen && (
          <div className="w-56 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0">
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

      {/* ── GROWTOPIA-STYLE HOTBAR ────────────────────────────────────────── */}
      {/* Shows placeable blocks from inventory. Click to select, then click world. */}
      <div className="flex items-center gap-1.5 px-3 py-2 bg-black/80 border-t border-border shrink-0 overflow-x-auto">
        <span className="text-muted-foreground text-[10px] uppercase font-mono tracking-wider whitespace-nowrap mr-1 shrink-0">
          Hotbar:
        </span>

        {hotbarItems.length === 0 ? (
          // Prompt to mine blocks when hotbar is empty
          <span className="text-muted-foreground text-[10px] font-mono italic">
            Mine grass, dirt, or rock blocks to collect them for placing
          </span>
        ) : (
          hotbarItems.map((item) => (
            <button
              key={item.itemId}
              onClick={() => {
                // Select this block and switch to place mode automatically
                setSelectedBlock(item.itemId);
                setMode("place");
              }}
              className={`flex flex-col items-center px-2 py-1.5 rounded border text-[10px] font-mono transition-all shrink-0 ${
                selectedBlock === item.itemId && mode === "place"
                  ? "border-blue-400 bg-blue-400/20 text-white"   // selected
                  : "border-border bg-black/50 text-muted-foreground hover:border-white/30"
              }`}
              title={`Place ${BLOCK_LABELS[item.itemId] ?? item.itemId}`}
            >
              {/* Color swatch matching the block's canvas color */}
              <span
                className="w-6 h-6 rounded-sm mb-0.5 border border-black/30"
                style={{ backgroundColor: BLOCK_COLORS[item.itemId] ?? "#888" }}
              />
              <span className="uppercase">{BLOCK_LABELS[item.itemId] ?? item.itemId}</span>
              {/* Quantity badge */}
              <span className="text-primary font-bold">×{item.quantity}</span>
            </button>
          ))
        )}

        {/* Deselect / switch back to punch with a clear button when in place mode */}
        {mode === "place" && (
          <button
            onClick={() => { setMode("punch"); setSelectedBlock(null); }}
            className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1 rounded hover:bg-red-400/10"
          >
            ✕ Cancel Place
          </button>
        )}
      </div>

      {/* ── MOBILE D-PAD CONTROLS ────────────────────────────────────────── */}
      <div className="md:hidden grid grid-cols-5 gap-1 p-2 bg-sidebar/95 border-t border-border shrink-0">
        <button
          className="py-3 rounded bg-black/60 border border-border text-white text-lg font-bold active:bg-primary/20 select-none"
          onPointerDown={() => mobileMove("left")}
          onPointerUp={() => mobileMove("stop")}
          onPointerLeave={() => mobileMove("stop")}
        >◀</button>
        <button
          className="col-span-3 py-3 rounded bg-primary/20 border border-primary text-primary font-bold uppercase tracking-widest active:bg-primary active:text-black select-none"
          onPointerDown={() => mobileMove("jump")}
        >JUMP</button>
        <button
          className="py-3 rounded bg-black/60 border border-border text-white text-lg font-bold active:bg-primary/20 select-none"
          onPointerDown={() => mobileMove("right")}
          onPointerUp={() => mobileMove("stop")}
          onPointerLeave={() => mobileMove("stop")}
        >▶</button>
      </div>

      {/* ── WIZARD CHALLENGE MODAL ───────────────────────────────────────── */}
      {/* Appears when the server detects too many rapid actions (anti-cheat) */}
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
              onKeyDown={(e) => e.key === "Enter" && (wizardAns === "5" ? (setWizard(false), setWizardAns("")) : toast({ title: "WRONG", variant: "destructive" }))}
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
