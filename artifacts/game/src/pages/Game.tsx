// ============================================================
// Game.tsx — Growtopia-style 2D block-building world
//
// Mining system (updated):
//   1. HOLD-TO-MINE — finger held on block deals continuous damage per second
//      (not tap-per-hit). Block breaks when health reaches 0.
//   2. INNER RADIUS CHECK — mining is cancelled if finger drifts too far from
//      player. Closest valid block is snapped to within range.
//   3. SMART AUTO-TARGET — D-pad direction auto-selects the nearest block in
//      front of / below the player, so you never have to touch blocks directly.
//   4. VISUAL RETICLE — animated dashed box around the targeted block + health
//      bar + offset targeting (reticle is above finger so thumb doesn't cover it).
//
// Other features:
//   • Gravity / AABB physics, day/night cycle, stars, sun, moon
//   • Placeable blocks: grass, dirt, rock, solar panel, machine core, cable
//   • Multiplayer chat via WebSocket
//   • Pinch-zoom guard — D-pad never fires during two-finger zoom
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
// CANVAS / WORLD CONSTANTS
// 800×600px canvas = 20×15 blocks at 40px per block, Growtopia-style grid.
// ─────────────────────────────────────────────────────────────────────────────
const BS = 40;   // Block Size — each grid cell is 40×40 pixels
const WW = 800;  // Canvas Width  (20 blocks × 40px)
const WH = 600;  // Canvas Height (15 blocks × 40px)

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICS CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const GRAVITY    = 900;   // px/s² downward acceleration
const JUMP_VY    = -420;  // px/s initial upward velocity on jump
const MOVE_SPEED = 175;   // px/s horizontal walk speed
const PW         = 26;    // Player hitbox Width  (px)
const PH         = 36;    // Player hitbox Height (px)

// ─────────────────────────────────────────────────────────────────────────────
// DAY/NIGHT CYCLE — 8 minutes per full cycle
// ─────────────────────────────────────────────────────────────────────────────
const DAY_MS = 480_000;

// ─────────────────────────────────────────────────────────────────────────────
// MINING SYSTEM — continuous hold-to-mine (replacing tap-per-hit)
//
// BLOCK_HEALTH  = how many seconds of holding it takes to mine each block type.
// MINING_POWER  = health-per-second dealt by the player's base pickaxe.
// A player with a better pickaxe would have higher MINING_POWER (expandable).
//
// Formula: timeToBreak = BLOCK_HEALTH[type] / MINING_POWER
//   e.g. grass (0.8) / 1.0 = 0.8 seconds of holding to break
//        diamond (5.0) / 1.0 = 5 seconds of holding to break
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_HEALTH: Record<string, number> = {
  block_grass:        0.8,  // Very fast — surface layer
  block_dirt:         1.5,  // Easy — sub-surface
  block_rock:         2.5,  // Medium — stone layer
  block_iron:         3.5,  // Hard — iron ore
  block_gold:         2.5,  // Medium — gold ore (valuable but accessible)
  block_diamond:      5.0,  // Very hard — rarest ore
  block_lava:         4.0,  // Hard — dangerous block
  machine_core:       1.5,  // Quick pickup — so you can rearrange rigs easily
  solar_panel_block:  1.5,  // Quick pickup
  data_cable:         0.8,  // Instant pickup — cables are fragile
};

// Base mining power (health points removed per second of holding)
const MINING_POWER = 1.0;

// ─────────────────────────────────────────────────────────────────────────────
// TOUCH OFFSET — the reticle (target highlight) is drawn THIS MANY pixels
// ABOVE the actual touch point. This prevents the player's thumb from covering
// the block being mined — the target appears above the finger.
// ─────────────────────────────────────────────────────────────────────────────
const TOUCH_OFFSET_PX = 50; // pixels above finger where targeting happens

// ─────────────────────────────────────────────────────────────────────────────
// REACH — max distance (in block-units) player can mine/place
// ─────────────────────────────────────────────────────────────────────────────
const REACH = 3.5;

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-TARGET SCAN RANGE — how many blocks in each direction to scan when
// the smart cursor is looking for a block to mine automatically via D-pad
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_SCAN = 3; // 3-block scan in front of player, 3 blocks tall

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK COLORS — canvas fillStyle for each block type
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass:        "#15803d",
  block_dirt:         "#78350f",
  block_rock:         "#374151",
  block_iron:         "#6b7280",
  block_gold:         "#b45309",
  block_diamond:      "#0e7490",
  block_lava:         "#b91c1c",
  machine_core:       "#1e1b4b",
  solar_panel_block:  "#065f46",
  data_cable:         "#7f1d1d",
};

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK TINTS — top-edge shimmer strip (gives blocks a 3D chiseled look)
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
// BLOCK LABELS — short display names used in hotbar and HUD
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
// PLACEABLE BLOCKS — which items the player can place back into the world
// Natural blocks are collected when mined. Machine blocks come from crafting.
// ─────────────────────────────────────────────────────────────────────────────
const PLACEABLE = new Set([
  "block_grass", "block_dirt", "block_rock",
  "machine_core", "solar_panel_block", "data_cable",
]);

// ─────────────────────────────────────────────────────────────────────────────
// SKY STATE — computed from current time position in the day/night cycle
// ─────────────────────────────────────────────────────────────────────────────
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };

function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS; // 0.0–1.0 within the day cycle
  if (t < 0.12) { const f=t/0.12; return {r:255,g:Math.round(80*f),b:0,alpha:0.70-0.60*f,stars:f<0.6}; }
  if (t < 0.22) { const f=(t-0.12)/0.10; return {r:255,g:Math.round(80+140*f),b:Math.round(160*f),alpha:0.10-0.10*f,stars:false}; }
  if (t < 0.55) return {r:135,g:206,b:235,alpha:0,stars:false};
  if (t < 0.68) { const f=(t-0.55)/0.13; return {r:255,g:Math.round(200-120*f),b:Math.round(50-50*f),alpha:0.12*f,stars:false}; }
  if (t < 0.78) { const f=(t-0.68)/0.10; return {r:255,g:Math.round(80-80*f),b:0,alpha:0.12+0.58*f,stars:f>0.5}; }
  return {r:0,g:0,b:20,alpha:0.70,stars:true};
}

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE BLOCK RENDERER — special pixel-art visuals for rig components
// ─────────────────────────────────────────────────────────────────────────────
function drawMachineBlock(ctx: CanvasRenderingContext2D, blk: string, gx: number, gy: number) {
  const px = gx * BS, py = gy * BS;
  if (blk === "machine_core") {
    // Deep indigo base + glowing purple CPU core + circuit lines
    ctx.fillStyle = "#312e81"; ctx.fillRect(px+1,py+1,BS-2,BS-2);
    ctx.fillStyle = "rgba(167,139,250,0.8)"; ctx.fillRect(px+8,py+8,BS-16,BS-16);
    ctx.strokeStyle = "rgba(196,181,253,0.9)"; ctx.lineWidth=1.5; ctx.strokeRect(px+8,py+8,BS-16,BS-16);
    // Circuit lines N/S/E/W radiating from core center
    ctx.strokeStyle="rgba(167,139,250,0.4)"; ctx.lineWidth=1;
    [[4,20,8,20],[32,20,36,20],[20,4,20,8],[20,32,20,36]].forEach(([x1,y1,x2,y2])=>{
      ctx.beginPath(); ctx.moveTo(px+x1,py+y1); ctx.lineTo(px+x2,py+y2); ctx.stroke();
    });
    ctx.strokeStyle="rgba(99,102,241,0.5)"; ctx.lineWidth=1; ctx.strokeRect(px+1,py+1,BS-2,BS-2);
  } else if (blk === "solar_panel_block") {
    // Dark emerald base + 3×3 checkerboard solar cells + glowing border
    ctx.fillStyle = "#064e3b"; ctx.fillRect(px+1,py+1,BS-2,BS-2);
    const cell = (BS-8)/3;
    for (let cy=0;cy<3;cy++) for (let cx=0;cx<3;cx++) {
      ctx.fillStyle = (cx+cy)%2===0?"#065f46":"#047857";
      ctx.fillRect(px+4+cx*cell,py+4+cy*cell,cell-1,cell-1);
    }
    ctx.strokeStyle="rgba(52,211,153,0.7)"; ctx.lineWidth=1.5; ctx.strokeRect(px+2,py+2,BS-4,BS-4);
    // Tiny sun symbol in center
    ctx.fillStyle="rgba(250,204,21,0.9)"; ctx.beginPath(); ctx.arc(px+BS/2,py+BS/2,3,0,Math.PI*2); ctx.fill();
  } else if (blk === "data_cable") {
    // Dark red base + vertical cable pipe + horizontal connectors at ends
    ctx.fillStyle="#450a0a"; ctx.fillRect(px+1,py+1,BS-2,BS-2);
    ctx.fillStyle="#dc2626"; ctx.fillRect(px+14,py+2,12,BS-4);
    ctx.fillStyle="#fca5a5"; ctx.fillRect(px+18,py+4,4,BS-8);
    ctx.strokeStyle="rgba(239,68,68,0.5)"; ctx.lineWidth=1; ctx.strokeRect(px+2,py+2,BS-4,BS-4);
    // Connector flanges at top and bottom
    ctx.fillStyle="#b91c1c";
    [[2,4,12,6],[26,4,12,6],[2,BS-10,12,6],[26,BS-10,12,6]].forEach(([bx,by,bw,bh])=>{
      ctx.fillRect(px+bx,py+by,bw,bh);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATED MINING RETICLE
// Draws a dashed animated rectangle around the currently targeted block.
// Also draws a health bar below the block name above it.
// The reticle pulses (offset > 0) and the dashes animate using `now` as phase.
//
// Parameters:
//   ctx      — canvas context
//   bx / by  — block grid position
//   health   — current health (0 → maxHealth)
//   maxHealth— starting health of this block
//   now      — current timestamp in ms (drives animation)
// ─────────────────────────────────────────────────────────────────────────────
function drawMiningReticle(
  ctx: CanvasRenderingContext2D,
  bx: number, by: number,
  health: number, maxHealth: number,
  now: number
) {
  const px = bx * BS;
  const py = by * BS;
  const progress = 1 - (health / maxHealth); // 0.0 = fresh → 1.0 = about to break

  // ── Damage overlay — darkens block as it takes damage ──────────────────
  ctx.fillStyle = `rgba(0,0,0,${progress * 0.6})`;
  ctx.fillRect(px+1, py+1, BS-2, BS-2);

  // ── Animated dashed reticle border ─────────────────────────────────────
  // The dashOffset changes with time, making the dashes appear to rotate.
  const dashOffset = (now / 80) % 16;
  ctx.save();
  ctx.strokeStyle = progress > 0.6 ? "#ef4444" : progress > 0.3 ? "#f59e0b" : "#22c55e";
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([6, 4]);
  ctx.lineDashOffset = -dashOffset;
  // Slight pulsing inset (grows as block takes more damage)
  const inset = Math.sin(now / 150) * 1.5;
  ctx.strokeRect(px + 1 + inset, py + 1 + inset, BS - 2 - inset*2, BS - 2 - inset*2);
  ctx.setLineDash([]);
  ctx.restore();

  // ── Corner accent squares (targeting reticle corners) ─────────────────
  ctx.fillStyle = progress > 0.6 ? "#ef4444" : "#f59e0b";
  const c = 5; // corner square size
  [[px,    py    ],[px+BS-c, py    ],
   [px,    py+BS-c],[px+BS-c, py+BS-c]].forEach(([rx,ry])=>{
    ctx.fillRect(rx, ry, c, c);
  });

  // ── Health bar above the block ─────────────────────────────────────────
  const barW  = BS;                        // same width as block
  const barH  = 5;                         // thin bar
  const barX  = px;
  const barY  = py - 9;                    // positioned just above the block
  const fillW = barW * (health / maxHealth); // shrinks as health decreases

  // Background track
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(barX, barY, barW, barH);
  // Health fill — green → yellow → red as block takes damage
  const r = Math.round(255 * progress);
  const g = Math.round(255 * (1 - progress * 0.7));
  ctx.fillStyle = `rgb(${r},${g},0)`;
  ctx.fillRect(barX, barY, fillW, barH);
  // Border
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(barX, barY, barW, barH);

  // ── Block label above health bar ────────────────────────────────────────
  const label = BLOCK_LABELS[" "] ?? ""; // handled below via blockType
  void label; // (block label is passed externally — see caller)
}

// ─────────────────────────────────────────────────────────────────────────────
// CRACK PATTERN RENDERER — overlays crack lines on a block based on damage %
// ─────────────────────────────────────────────────────────────────────────────
function drawCracks(ctx: CanvasRenderingContext2D, bx: number, by: number, progress: number) {
  if (progress < 0.15) return; // No cracks until 15% damage
  const x = bx * BS, y = by * BS;
  const stage = Math.min(4, Math.floor(progress * 5));
  ctx.save();
  ctx.strokeStyle = "rgba(0,0,0,0.85)"; ctx.lineWidth = 1.5;
  if (stage>=1){ctx.beginPath();ctx.moveTo(x+8,y+6);ctx.lineTo(x+18,y+16);ctx.lineTo(x+14,y+22);ctx.stroke();}
  if (stage>=2){ctx.beginPath();ctx.moveTo(x+30,y+8);ctx.lineTo(x+22,y+20);ctx.lineTo(x+28,y+30);ctx.stroke();}
  if (stage>=3){
    ctx.beginPath();ctx.moveTo(x+4,y+28);ctx.lineTo(x+16,y+22);ctx.lineTo(x+26,y+34);ctx.stroke();
    ctx.fillStyle="rgba(0,0,0,0.5)";ctx.fillRect(x+2,y+2,5,5);ctx.fillRect(x+33,y+30,5,5);
  }
  if (stage>=4){
    ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(x+2,y+20);ctx.lineTo(x+38,y+18);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x+20,y+2);ctx.lineTo(x+18,y+38);ctx.stroke();
    ctx.fillStyle="rgba(0,0,0,0.7)";
    [[1,1],[35,1],[1,35],[35,35]].forEach(([ox,oy])=>ctx.fillRect(x+ox,y+oy,4,4));
  }
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNCH FLASH — brief white-yellow flash over a block the moment it is hit
// ─────────────────────────────────────────────────────────────────────────────
function drawPunchFlash(ctx: CanvasRenderingContext2D, bx: number, by: number, alpha: number) {
  ctx.fillStyle = `rgba(255,255,200,${alpha * 0.5})`;
  ctx.fillRect(bx * BS + 2, by * BS + 2, BS - 4, BS - 4);
}

// ============================================================
// MAIN GAME COMPONENT
// ============================================================
export default function Game() {

  // ── Auth info stored in localStorage after login ──────────────────────────
  const userId   = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";

  // The 2D canvas element — all game visuals are drawn here every frame
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Server data hooks ─────────────────────────────────────────────────────
  const { data: world,     refetch: refetchWorld     } = useGetWorld("start", {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") },
  });
  const { data: wallet                               } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  const { data: inventory = [], refetch: refetchInventory } = useGetInventory({
    query: { enabled: !!userId, queryKey: getGetInventoryQueryKey(), refetchInterval: 5000 },
  });

  const gameAction = useGameAction();
  const { toast }  = useToast();

  // ── Physics ref — updated every frame, never triggers re-renders ──────────
  const physRef = useRef({
    px: 5 * BS, py: 0,   // position in pixels
    vx: 0,      vy: 0,   // velocity in px/s
    onGround: false, facingRight: true, spawned: false,
  });

  const keysRef   = useRef<Set<string>>(new Set()); // keys currently held down
  const worldRef  = useRef<string[][] | null>(null); // local world grid (avoids lag)
  const rafRef    = useRef(0);                       // animation frame handle
  const lastTRef  = useRef(0);                       // previous frame timestamp

  // ─────────────────────────────────────────────────────────────────────────
  // MINING STATE REF
  // Tracks the current continuous hold-to-mine operation.
  // Updated every frame in the game loop when active = true.
  //
  //   active     — is the player currently holding to mine?
  //   bx / by    — grid position of the target block
  //   health     — remaining health of the block (starts at maxHealth)
  //   maxHealth  — total health when mining started
  //   blockType  — type string (e.g. "block_rock") for labelling
  //   fromTouch  — true if triggered by touch (vs mouse/keyboard)
  // ─────────────────────────────────────────────────────────────────────────
  const miningRef = useRef<{
    active: boolean;
    bx: number; by: number;
    health: number; maxHealth: number;
    blockType: string;
    fromTouch: boolean;
  }>({ active: false, bx: 0, by: 0, health: 0, maxHealth: 0, blockType: "", fromTouch: false });

  // Flash effects — maps "x,y" → alpha (0–1), fades per frame
  const flashRef        = useRef<Map<string, number>>(new Map());
  // Prevent double-sending a break request before the previous resolves
  const pendingBreakRef = useRef(false);

  // ─────────────────────────────────────────────────────────────────────────
  // D-PAD AUTO-TARGET STATE
  // When the D-pad direction button is held, the smart cursor scans a 3×3
  // zone in front of the player and automatically selects a block to mine.
  // dpadDirRef stores the current held direction ("left" | "right" | null).
  // ─────────────────────────────────────────────────────────────────────────
  const dpadDirRef = useRef<"left" | "right" | null>(null);

  // ─────────────────────────────────────────────────────────────────────────
  // PINCH DETECTION
  // Two-finger touch = isPinchingRef true → D-pad and canvas taps disabled.
  // ─────────────────────────────────────────────────────────────────────────
  const isPinchingRef = useRef(false);

  // ── React UI state ────────────────────────────────────────────────────────
  const [mode,           setMode]          = useState<"punch" | "place">("punch");
  const [selectedBlock,  setSelectedBlock] = useState<string | null>(null);
  const [wizard,         setWizard]        = useState(false);
  const [wizardAns,      setWizardAns]     = useState("");
  const [chatOpen,       setChatOpen]      = useState(false);
  const [chatMsgs,       setChatMsgs]      = useState<{ username: string; message: string }[]>([]);
  const [chatInput,      setChatInput]     = useState("");

  // WebSocket handle for multiplayer chat
  const wsRef = useRef<WebSocket | null>(null);

  // Static star field (90 stars, random positions + twinkle phases)
  const starsRef = useRef(
    Array.from({ length: 90 }, () => ({
      x: Math.random() * WW, y: Math.random() * WH * 0.55,
      r: Math.random() * 1.5 + 0.4, twinkle: Math.random() * Math.PI * 2,
    }))
  );

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Sync world data from server → worldRef
  // Sets spawn position on first load.
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;
    if (!physRef.current.spawned) {
      const bd = world.blockData;
      let spawnY = 0;
      for (let y = 0; y < bd.length; y++) { if (bd[y][5]==="air") { spawnY=y; break; } }
      physRef.current.py = spawnY * BS;
      physRef.current.px = 5 * BS + (BS - PW) / 2;
      physRef.current.spawned = true;
    }
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: WebSocket chat connection
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const proto = location.protocol==="https:" ? "wss:" : "ws:";
    const ws    = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;
    ws.onmessage  = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { username: string; message: string };
        setChatMsgs((prev) => [...prev.slice(-29), m]);
      } catch { /* ignore malformed */ }
    };
    return () => ws.close();
  }, []);

  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ username, message: chatInput.trim() }));
    setChatInput("");
  };

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: solid(bx, by) — is a grid cell solid (non-air)?
  // Called every physics frame for AABB collision.
  // ════════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx: number, by: number): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0) return false;
    if (by >= bd.length) return true;
    if (bx < 0 || bx >= bd[0].length) return true;
    return bd[by][bx] !== "air";
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: findAutoTarget(dir)
  // Smart cursor — scans a 3×AUTO_SCAN grid zone in front of the player and
  // returns the nearest breakable block within reach. Used by D-pad auto-mine.
  //
  // Algorithm:
  //   1. Find player's current grid cell (pcx, pcy)
  //   2. For direction "left", scan columns pcx-1 down to pcx-AUTO_SCAN
  //      (or right for "right"), checking each row within player height + 1
  //   3. Return the block closest to the player center, or null if none found
  // ════════════════════════════════════════════════════════════════════════════
  const findAutoTarget = useCallback((dir: "left" | "right"): { bx: number; by: number } | null => {
    const bd = worldRef.current;
    if (!bd) return null;

    const p   = physRef.current;
    const pcx = (p.px + PW / 2) / BS; // player center in block units
    const pcy = (p.py + PH / 2) / BS;

    // Player feet and head grid rows
    const playerTopRow    = Math.floor(p.py / BS);
    const playerBottomRow = Math.floor((p.py + PH) / BS);

    let best: { bx: number; by: number; dist: number } | null = null;

    // Scan columns in front of player (in the direction they're moving)
    for (let step = 1; step <= AUTO_SCAN; step++) {
      const col = dir === "right" ? Math.floor(pcx) + step : Math.ceil(pcx) - step;
      // Scan from 1 block above player head to 1 block below feet
      for (let row = playerTopRow - 1; row <= playerBottomRow + 1; row++) {
        if (row < 0 || row >= bd.length || col < 0 || col >= bd[0].length) continue;
        if (bd[row][col] === "air") continue; // not a breakable block

        const dist = Math.sqrt((col - pcx) ** 2 + (row - pcy) ** 2);
        if (dist > REACH) continue; // out of range

        // Pick closest block
        if (!best || dist < best.dist) best = { bx: col, by: row, dist };
      }
    }

    // Also check the block directly below for down-digging
    const belowRow = playerBottomRow + 1;
    const belowCol = Math.round(pcx);
    if (belowRow >= 0 && belowRow < bd.length && belowCol >= 0 && belowCol < bd[0].length) {
      if (bd[belowRow][belowCol] !== "air") {
        const dist = Math.sqrt((belowCol - pcx)**2 + (belowRow - pcy)**2);
        if (dist <= REACH && (!best || dist < best.dist)) {
          best = { bx: belowCol, by: belowRow, dist };
        }
      }
    }

    return best ? { bx: best.bx, by: best.by } : null;
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: startMining(bx, by, fromTouch)
  // Begins a mining operation on block at grid (bx, by).
  // Sets up miningRef so the game loop can apply continuous damage.
  // ════════════════════════════════════════════════════════════════════════════
  const startMining = useCallback((bx: number, by: number, fromTouch: boolean) => {
    const bd = worldRef.current;
    if (!bd) return;
    if (bx < 0 || by < 0 || bx >= bd[0].length || by >= bd.length) return;

    const blk = bd[by][bx];
    if (!blk || blk === "air") return; // Nothing to mine

    // Check reach from player center
    const p   = physRef.current;
    const pcx = (p.px + PW/2) / BS;
    const pcy = (p.py + PH/2) / BS;
    const dist = Math.sqrt((bx - pcx)**2 + (by - pcy)**2);
    if (dist > REACH) return; // Too far away

    const maxHealth = BLOCK_HEALTH[blk] ?? 2.0;

    // If already mining same block, don't restart — let it continue
    if (miningRef.current.active &&
        miningRef.current.bx === bx &&
        miningRef.current.by === by) return;

    // Start new mining operation
    miningRef.current = {
      active: true,
      bx, by,
      health: maxHealth,
      maxHealth,
      blockType: blk,
      fromTouch,
    };

    // Flash effect — immediate visual feedback
    flashRef.current.set(`${bx},${by}`, 1.0);

    // Turn player to face the target block
    physRef.current.facingRight = bx >= pcx;
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: stopMining()
  // Cancels the current mining operation. Called on touchend, pointer up, etc.
  // Partial damage is lost — player must hold long enough to break the block.
  // ════════════════════════════════════════════════════════════════════════════
  const stopMining = useCallback(() => {
    miningRef.current.active = false;
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: breakBlock(bx, by)
  // Called when a block's health reaches 0. Sends the break action to server.
  // ════════════════════════════════════════════════════════════════════════════
  const breakBlock = useCallback((bx: number, by: number) => {
    const bd = worldRef.current;
    if (!bd || pendingBreakRef.current) return;
    pendingBreakRef.current = true;

    // Optimistic: immediately remove block so the game feels instant
    const updated = bd.map((row) => [...row]);
    updated[by][bx] = "air";
    worldRef.current = updated;

    miningRef.current.active = false; // Stop mining

    gameAction.mutate(
      { data: { actionType: "break", worldName: "start", x: bx, y: by } },
      {
        onSuccess: (data) => {
          pendingBreakRef.current = false;
          if (data.wizardChallenge) { setWizard(true); return; }
          if (data.success) {
            if (data.dropItem) {
              toast({
                title: `+1 ${data.dropItem.toUpperCase().replace(/_/g," ")}`,
                className: "border-primary bg-black text-primary font-mono uppercase text-xs",
              });
            }
            refetchWorld();
            refetchInventory();
          }
        },
        onError: () => {
          pendingBreakRef.current = false;
          worldRef.current = bd; // Revert optimistic update
        },
      }
    );
  }, [gameAction, refetchWorld, refetchInventory, toast]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: placeBlock(bx, by)
  // Places the currently selected block at grid (bx, by).
  // ════════════════════════════════════════════════════════════════════════════
  const placeBlock = useCallback((bx: number, by: number) => {
    if (!selectedBlock) return;
    const bd = worldRef.current;
    if (!bd) return;
    if (bd[by]?.[bx] !== "air") {
      toast({ title:"BLOCKED", description:"That space is occupied.", className:"bg-black border-yellow-500 text-yellow-400 font-mono text-xs" });
      return;
    }

    // Check reach
    const p   = physRef.current;
    const pcx = (p.px + PW/2) / BS;
    const pcy = (p.py + PH/2) / BS;
    if (Math.sqrt((bx-pcx)**2 + (by-pcy)**2) > REACH) {
      toast({ title:"OUT OF REACH", description:"Walk closer.", className:"bg-black border-border text-muted-foreground font-mono text-xs" });
      return;
    }

    // Optimistic update
    const updated = bd.map((row) => [...row]);
    updated[by][bx] = selectedBlock;
    worldRef.current = updated;

    gameAction.mutate(
      { data: { actionType:"place", worldName:"start", x:bx, y:by, placeBlock:selectedBlock } },
      {
        onSuccess: (data) => {
          if (data.success) {
            if ((data as { machineUpdated?: boolean }).machineUpdated) {
              toast({ title:"⚡ RIG UPDATED", description:"Solar panels power your machine core!", className:"bg-black border-violet-500 text-violet-400 font-mono text-xs" });
            }
            refetchWorld(); refetchInventory();
          } else {
            worldRef.current = bd;
            toast({ title:"PLACE FAILED", variant:"destructive" });
          }
        },
        onError: () => { worldRef.current = bd; },
      }
    );
  }, [selectedBlock, gameAction, refetchWorld, refetchInventory, toast]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: screenToBlock(clientX, clientY, applyOffset)
  // Converts screen touch/click coordinates to block grid coordinates.
  // When applyOffset=true, applies TOUCH_OFFSET_PX upward so the reticle
  // appears above the thumb (so finger doesn't cover the target).
  // ════════════════════════════════════════════════════════════════════════════
  const screenToBlock = useCallback((clientX: number, clientY: number, applyOffset = false): { bx: number; by: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;

    // Apply upward offset on touch so target is above finger
    const adjustedY = applyOffset ? clientY - TOUCH_OFFSET_PX : clientY;

    const bx = Math.floor(((clientX  - rect.left) / rect.width)  * WW / BS);
    const by = Math.floor(((adjustedY - rect.top)  / rect.height) * WH / BS);
    const bd = worldRef.current;
    if (!bd) return null;
    if (bx < 0 || by < 0 || bx >= bd[0].length || by >= bd.length) return null;
    return { bx, by };
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN GAME LOOP — drawFrame(now)
  // Runs at ~60fps via requestAnimationFrame.
  // Order: physics → apply mining damage → render sky/blocks/player → overlays
  // ════════════════════════════════════════════════════════════════════════════
  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx)   return;

    // Delta time in seconds (capped at 50ms to avoid physics tunnelling)
    const dt = Math.min((now - lastTRef.current) / 1000, 0.05);
    lastTRef.current = now;

    const p  = physRef.current;
    const bd = worldRef.current;

    // ── D-PAD AUTO-TARGET: when direction held, find and mine nearest block ──
    // This runs every frame so mining starts as soon as a block is in range.
    if (dpadDirRef.current && !miningRef.current.active && mode === "punch") {
      const target = findAutoTarget(dpadDirRef.current);
      if (target) startMining(target.bx, target.by, false);
    }

    // ── CONTINUOUS MINING DAMAGE ─────────────────────────────────────────────
    // Apply MINING_POWER × dt health damage each frame while holding.
    // When health reaches 0, the block breaks.
    if (miningRef.current.active) {
      const m  = miningRef.current;
      const bd2 = worldRef.current;

      // Safety check — verify target block still exists (might have been broken by another player)
      if (!bd2 || bd2[m.by]?.[m.bx] === "air") {
        miningRef.current.active = false;
      } else {
        // Re-check reach — cancel if player walked too far away
        const pcx = (p.px + PW/2) / BS;
        const pcy = (p.py + PH/2) / BS;
        const dist = Math.sqrt((m.bx - pcx)**2 + (m.by - pcy)**2);

        if (dist > REACH) {
          // Player walked out of range — cancel mining
          miningRef.current.active = false;
        } else {
          // Apply damage — reduce health by mining power × time elapsed
          m.health -= MINING_POWER * dt;
          // Keep flash alive while actively mining
          flashRef.current.set(`${m.bx},${m.by}`, 0.3);

          // Block fully mined!
          if (m.health <= 0) {
            breakBlock(m.bx, m.by);
          }
        }
      }
    }

    // ── PHYSICS UPDATE ────────────────────────────────────────────────────────
    if (bd) {
      // Horizontal AABB
      const npx = p.px + p.vx * dt;
      const ty0 = Math.floor((p.py + 2) / BS);
      const ty1 = Math.floor((p.py + PH - 2) / BS);
      if (p.vx > 0)      { const tx=Math.floor((npx+PW)/BS); if(!solid(tx,ty0)&&!solid(tx,ty1)) p.px=npx; else p.px=tx*BS-PW; }
      else if (p.vx < 0) { const tx=Math.floor(npx/BS);      if(!solid(tx,ty0)&&!solid(tx,ty1)) p.px=npx; else p.px=(tx+1)*BS; }
      p.px = Math.max(0, Math.min(bd[0].length*BS-PW, p.px));

      // Vertical AABB + gravity
      p.vy = Math.min(p.vy + GRAVITY * dt, 850);
      const npy = p.py + p.vy * dt;
      const tx0 = Math.floor((p.px+2) / BS);
      const tx1 = Math.floor((p.px+PW-2) / BS);
      p.onGround = false;
      if (p.vy >= 0) {
        const ty = Math.floor((npy+PH)/BS);
        if (solid(tx0,ty)||solid(tx1,ty)) { p.py=ty*BS-PH; p.vy=0; p.onGround=true; } else p.py=npy;
      } else {
        const ty = Math.floor(npy/BS);
        if (solid(tx0,ty)||solid(tx1,ty)) { p.py=(ty+1)*BS; p.vy=0; } else p.py=npy;
      }
      p.py = Math.max(0, Math.min(bd.length*BS-PH, p.py));
    }

    // ── CLEAR + SKY GRADIENT ─────────────────────────────────────────────────
    ctx.clearRect(0, 0, WW, WH);
    const sky  = getSky(now);
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) { grad.addColorStop(0,`rgb(${sky.r},${sky.g},${sky.b})`); grad.addColorStop(1,"#0a0010"); }
    else                  { grad.addColorStop(0,"#1a3a5c"); grad.addColorStop(0.5,"#0f2035"); grad.addColorStop(1,"#050d14"); }
    ctx.fillStyle = grad; ctx.fillRect(0, 0, WW, WH);

    // ── STARS ────────────────────────────────────────────────────────────────
    if (sky.stars && sky.alpha > 0.1) {
      const sa = Math.min(1, (sky.alpha-0.1)*2);
      starsRef.current.forEach((s) => {
        const tw = 0.7 + 0.3*Math.sin(now/800+s.twinkle);
        ctx.fillStyle=`rgba(255,255,255,${sa*tw})`; ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill();
      });
    }

    // ── SUN / MOON ───────────────────────────────────────────────────────────
    const t = (now%DAY_MS)/DAY_MS;
    if (sky.alpha < 0.4) {
      const a = t*Math.PI*2 - Math.PI/2;
      const sx=WW/2+Math.cos(a)*320, sy=WH*0.5+Math.sin(a)*280;
      if (sy < WH*0.55) {
        const sg=ctx.createRadialGradient(sx,sy,0,sx,sy,28);
        sg.addColorStop(0,"rgba(255,240,100,1)"); sg.addColorStop(0.5,"rgba(255,180,0,0.8)"); sg.addColorStop(1,"rgba(255,140,0,0)");
        ctx.fillStyle=sg; ctx.beginPath(); ctx.arc(sx,sy,28,0,Math.PI*2); ctx.fill();
      }
    } else if (sky.alpha > 0.5) {
      const a=(t+0.5)*Math.PI*2 - Math.PI/2;
      const mx=WW/2+Math.cos(a)*320, my=WH*0.5+Math.sin(a)*280;
      if (my < WH*0.55) {
        ctx.fillStyle="rgba(220,230,255,0.9)"; ctx.beginPath(); ctx.arc(mx,my,16,0,Math.PI*2); ctx.fill();
        ctx.fillStyle="rgba(10,0,30,0.85)";   ctx.beginPath(); ctx.arc(mx+6,my-4,13,0,Math.PI*2); ctx.fill();
      }
    }

    // ── BLOCKS ───────────────────────────────────────────────────────────────
    if (bd) {
      for (let y=0; y<bd.length; y++) {
        for (let x=0; x<bd[y].length; x++) {
          const blk = bd[y][x];
          if (blk==="air") continue;
          if (blk==="machine_core"||blk==="solar_panel_block"||blk==="data_cable") {
            drawMachineBlock(ctx, blk, x, y);
          } else {
            ctx.fillStyle=BLOCK_COLORS[blk]??"#1e293b"; ctx.fillRect(x*BS,y*BS,BS,BS);
            ctx.fillStyle=BLOCK_TINTS[blk]??"rgba(255,255,255,0.07)"; ctx.fillRect(x*BS+1,y*BS+1,BS-2,5);
            ctx.strokeStyle="rgba(0,0,0,0.4)"; ctx.lineWidth=1; ctx.strokeRect(x*BS+0.5,y*BS+0.5,BS-1,BS-1);
          }
        }
      }

      // ── MINING RETICLE — draw on top of blocks, before player ────────────
      // Shows: animated dashed border + health bar + crack pattern
      const m = miningRef.current;
      if (m.active && bd[m.by]?.[m.bx] !== "air") {
        // Draw crack pattern based on damage progress
        const progress = 1 - (m.health / m.maxHealth);
        drawCracks(ctx, m.bx, m.by, progress);

        // Draw animated reticle border + health bar
        drawMiningReticle(ctx, m.bx, m.by, m.health, m.maxHealth, now);

        // Block name label above health bar
        const label = BLOCK_LABELS[m.blockType] ?? m.blockType.replace("block_","").toUpperCase();
        ctx.font      = "bold 9px monospace";
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.textAlign = "center";
        ctx.fillText(label, m.bx*BS + BS/2, m.by*BS - 13);
        ctx.textAlign = "left";
      }

      // ── PUNCH FLASH ─────────────────────────────────────────────────────
      flashRef.current.forEach((alpha, key) => {
        const [bx,by] = key.split(",");
        drawPunchFlash(ctx, parseInt(bx), parseInt(by), alpha);
        const na = alpha - 0.15;
        if (na <= 0) flashRef.current.delete(key); else flashRef.current.set(key, na);
      });
    }

    // ── PLAYER SPRITE ────────────────────────────────────────────────────────
    const { px, py, facingRight: fr } = p;
    ctx.fillStyle="#1e4d2b"; ctx.fillRect(px+5,py+14,PW-10,PH-14);   // body
    ctx.fillStyle="#fbbf24"; ctx.fillRect(px+3,py+2,PW-6,14);         // head
    ctx.fillStyle="#000";    ctx.fillRect(fr?px+13:px+5,py+7,4,4);    // eye pupil
    ctx.fillStyle="#22c55e"; ctx.fillRect(fr?px+14:px+6,py+8,2,2);    // eye glow
    if (mode==="place"&&selectedBlock) {
      // Block swatch in hand
      ctx.fillStyle=BLOCK_COLORS[selectedBlock]??"#aaa"; ctx.fillRect(fr?px+PW+2:px-8,py+14,6,6);
      ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.strokeRect(fr?px+PW+2:px-8,py+14,6,6);
    } else {
      // Pickaxe — handle + head
      ctx.fillStyle="#9ca3af"; ctx.fillRect(fr?px+PW+1:px-5,py+16,4,14);
      ctx.fillStyle="#6b7280"; ctx.fillRect(fr?px+PW:px-6,py+13,6,6);
    }

    // ── MINING POWER INDICATOR — pulsing ring around player when mining ───
    if (m.active) {
      ctx.save();
      ctx.strokeStyle = `rgba(255,200,0,${0.4 + 0.3*Math.sin(now/100)})`;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(px + PW/2, py + PH/2, REACH*BS, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }

    // ── NIGHT OVERLAY ────────────────────────────────────────────────────────
    if (sky.alpha > 0) { ctx.fillStyle=`rgba(0,0,20,${sky.alpha*0.45})`; ctx.fillRect(0,0,WW,WH); }

    // ── CRT SCANLINES (subtle retro effect) ─────────────────────────────────
    ctx.fillStyle="rgba(0,0,0,0.04)";
    for (let sy=0; sy<WH; sy+=4) ctx.fillRect(0,sy,WW,2);

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [solid, mode, selectedBlock, findAutoTarget, startMining, breakBlock]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Start / stop game loop
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    lastTRef.current = performance.now();
    rafRef.current   = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Keyboard controls (WASD / Arrows / Space)
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      const p = physRef.current;
      if (["ArrowLeft","a","A"].includes(e.key))  { p.vx=-MOVE_SPEED; p.facingRight=false; }
      if (["ArrowRight","d","D"].includes(e.key)) { p.vx=MOVE_SPEED;  p.facingRight=true;  }
      if ([" ","ArrowUp","w","W"].includes(e.key)&&p.onGround) { p.vy=JUMP_VY; p.onGround=false; e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      const keys = keysRef.current;
      const goL  = keys.has("ArrowLeft")||keys.has("a")||keys.has("A");
      const goR  = keys.has("ArrowRight")||keys.has("d")||keys.has("D");
      if      (!goL&&!goR) physRef.current.vx=0;
      else if (goL)        { physRef.current.vx=-MOVE_SPEED; physRef.current.facingRight=false; }
      else                 { physRef.current.vx=MOVE_SPEED;  physRef.current.facingRight=true;  }
    };
    window.addEventListener("keydown",down);
    window.addEventListener("keyup",up);
    return () => { window.removeEventListener("keydown",down); window.removeEventListener("keyup",up); };
  }, []);

  // ════════════════════════════════════════════════════════════════════════════
  // CANVAS TOUCH HANDLERS — hold-to-mine with offset targeting
  //
  // touchstart → startMining at position above finger (TOUCH_OFFSET_PX up)
  // touchmove  → update target if finger moves to a new block (live retarget)
  // touchend   → stopMining (partial damage is lost)
  // ════════════════════════════════════════════════════════════════════════════

  // Touchstart — begin mining or placing
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    // Ignore pinch (2+ fingers)
    if (e.touches.length > 1 || isPinchingRef.current) return;
    e.preventDefault();
    const touch = e.touches[0];

    if (mode === "place") {
      // In place mode, convert and place
      const target = screenToBlock(touch.clientX, touch.clientY, false);
      if (target) placeBlock(target.bx, target.by);
    } else {
      // In punch/mine mode — start continuous mining at offset position
      const target = screenToBlock(touch.clientX, touch.clientY, true);
      if (target) startMining(target.bx, target.by, true);
    }
  }, [mode, screenToBlock, startMining, placeBlock]);

  // Touchmove — retarget as finger drags across screen
  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length > 1 || isPinchingRef.current) return;
    e.preventDefault();
    if (!miningRef.current.active || mode !== "punch") return;

    const touch  = e.touches[0];
    const target = screenToBlock(touch.clientX, touch.clientY, true); // offset above finger
    if (!target) return;

    // Retarget if finger moved to a different block
    if (target.bx !== miningRef.current.bx || target.by !== miningRef.current.by) {
      startMining(target.bx, target.by, true);
    }
  }, [mode, screenToBlock, startMining]);

  // Touchend — stop mining
  const handleTouchEnd = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.touches.length === 0) stopMining();
  }, [stopMining]);

  // Mouse click (desktop) — instant single interaction
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const target = screenToBlock(e.clientX, e.clientY, false);
    if (!target) return;
    if (mode === "place") {
      placeBlock(target.bx, target.by);
    } else {
      // Desktop: single click = full break (instant, no hold needed)
      startMining(target.bx, target.by, false);
      // Immediately finish — simulate instant mining for desktop feel
      setTimeout(() => {
        if (miningRef.current.active) {
          miningRef.current.health = 0; // will be caught next frame
        }
      }, 50);
    }
  }, [mode, screenToBlock, placeBlock, startMining]);

  // Clear mining state when world refreshes
  useEffect(() => { miningRef.current.active = false; }, [world]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: Global pinch-zoom detection
  // 2+ fingers → isPinchingRef true → disables D-pad and canvas touch
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const onStart  = (e: TouchEvent) => { if (e.touches.length>=2) { isPinchingRef.current=true; physRef.current.vx=0; stopMining(); } };
    const onEnd    = (e: TouchEvent) => { if (e.touches.length<2)  isPinchingRef.current=false; };
    window.addEventListener("touchstart",  onStart, {passive:true});
    window.addEventListener("touchend",    onEnd,   {passive:true});
    window.addEventListener("touchcancel", onEnd,   {passive:true});
    return () => {
      window.removeEventListener("touchstart",  onStart);
      window.removeEventListener("touchend",    onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [stopMining]);

  // ════════════════════════════════════════════════════════════════════════════
  // MOBILE D-PAD — movement + auto-target
  // Direction buttons set velocity AND set dpadDirRef for smart cursor.
  // The game loop checks dpadDirRef every frame to auto-start mining.
  // ════════════════════════════════════════════════════════════════════════════
  const mobileMove = (dir: "left" | "right" | "stop" | "jump") => {
    if (isPinchingRef.current) return; // Never fire during pinch zoom
    const p = physRef.current;
    if (dir==="left")  { p.vx=-MOVE_SPEED; p.facingRight=false; dpadDirRef.current="left";  }
    if (dir==="right") { p.vx=MOVE_SPEED;  p.facingRight=true;  dpadDirRef.current="right"; }
    if (dir==="stop")  { p.vx=0; dpadDirRef.current=null; stopMining(); }
    if (dir==="jump" && p.onGround) { p.vy=JUMP_VY; p.onGround=false; }
  };

  // Hotbar = inventory items that can be placed as blocks
  const hotbarItems = inventory.filter((i) => PLACEABLE.has(i.itemId) && i.quantity > 0);

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="flex flex-col h-full bg-background overflow-hidden select-none"
    >

      {/* ── TOP HUD ────────────────────────────────────────────────────────── */}
      <div className="flex justify-between items-center px-2 py-1.5 bg-black/95 border-b border-border z-10 shrink-0 gap-2 flex-wrap">
        {/* Player name */}
        <div className="bg-black/60 px-2 py-1 rounded border border-primary/20 font-mono">
          <span className="text-muted-foreground uppercase block leading-none text-[9px]">Player</span>
          <span className="text-white font-bold text-xs">{username}</span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Mine / Place toggle */}
          <div className="flex border border-border rounded overflow-hidden font-mono text-[10px]">
            <button
              onClick={() => { setMode("punch"); stopMining(); }}
              className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${mode==="punch"?"bg-red-600 text-white":"bg-black/40 text-muted-foreground hover:text-red-400"}`}
            >⛏ Mine</button>
            <button
              onClick={() => { setMode("place"); stopMining(); }}
              className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${mode==="place"?"bg-blue-600 text-white":"bg-black/40 text-muted-foreground hover:text-blue-400"}`}
            >🧱 Place</button>
          </div>

          {/* Energy */}
          <div className="bg-black/60 px-2 py-1 rounded border border-accent/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Energy</span>
            <div className="flex items-center text-accent font-bold"><Zap className="w-3 h-3 mr-0.5"/>{wallet?.actionCount??0}/100</div>
          </div>

          {/* Gems */}
          <div className="bg-black/60 px-2 py-1 rounded border border-primary/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Gems</span>
            <span className="text-primary font-bold">{wallet?.gems??0} 💎</span>
          </div>

          {/* Chat toggle */}
          <button
            onClick={() => setChatOpen(s=>!s)}
            className={`p-1.5 rounded border transition-colors ${chatOpen?"border-primary text-primary bg-primary/10":"border-border text-muted-foreground hover:text-primary"}`}
          ><MessageSquare className="w-4 h-4"/></button>
        </div>
      </div>

      {/* ── CANVAS + CHAT ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">

        {/* Game canvas — touch-action:none stops browser scroll/zoom on canvas */}
        <div className="flex-1 bg-[#050d14] flex items-center justify-center relative overflow-hidden" style={{touchAction:"none"}}>
          <canvas
            ref={canvasRef}
            width={WW} height={WH}
            onClick={handleCanvasClick}
            onTouchStart={handleTouchStart}   // hold-to-mine begins
            onTouchMove={handleTouchMove}     // retarget as finger drags
            onTouchEnd={handleTouchEnd}       // release = stop mining
            onTouchCancel={handleTouchEnd}    // cancelled = stop mining
            className="max-w-full max-h-full object-contain border border-border/30"
            style={{ imageRendering:"pixelated", cursor:mode==="place"?"cell":"crosshair", touchAction:"none" }}
          />

          {/* Mode indicator overlay */}
          <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase pointer-events-none ${mode==="place"?"bg-blue-600/80 text-white":"bg-red-600/80 text-white"}`}>
            {mode==="place"
              ? `📦 PLACE: ${selectedBlock?(BLOCK_LABELS[selectedBlock]??selectedBlock):"pick block below"}`
              : "⛏ HOLD BLOCKS TO MINE"}
          </div>

          {/* Mining hint — visible when actively mining */}
          {/* (drawn on canvas via reticle — no DOM overlay needed) */}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <div className="w-48 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-primary font-bold text-[10px] uppercase tracking-widest">World Chat</span>
              <button onClick={()=>setChatOpen(false)}><X className="w-3 h-3 text-muted-foreground hover:text-white"/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
              {chatMsgs.length===0 && <p className="text-muted-foreground italic text-[10px]">No messages yet — say hi!</p>}
              {chatMsgs.map((m,i)=>(
                <div key={i} className="break-words leading-tight">
                  <span className="text-primary font-bold">{m.username}: </span>
                  <span className="text-gray-300">{m.message}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-1 p-2 border-t border-border">
              <Input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Say something..." className="h-6 text-[10px] bg-black/50 border-border px-2 py-0"/>
              <button onClick={sendChat} className="text-primary shrink-0"><SendHorizonal className="w-3 h-3"/></button>
            </div>
          </div>
        )}
      </div>

      {/* ── BLOCK HOTBAR ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 px-2 py-2 bg-black/90 border-t border-border shrink-0 overflow-x-auto">
        <span className="text-muted-foreground text-[9px] uppercase font-mono tracking-wider whitespace-nowrap mr-1 shrink-0">Blocks:</span>
        {hotbarItems.length===0 ? (
          <span className="text-muted-foreground text-[9px] font-mono italic">Mine blocks or craft machines to build</span>
        ) : (
          hotbarItems.map((item)=>(
            <button
              key={item.itemId}
              onClick={()=>{ setSelectedBlock(item.itemId); setMode("place"); stopMining(); }}
              className={`flex flex-col items-center px-2 py-1.5 rounded border text-[9px] font-mono transition-all shrink-0 min-w-[48px] ${
                selectedBlock===item.itemId&&mode==="place"
                  ?"border-blue-400 bg-blue-400/20 text-white shadow-[0_0_8px_rgba(96,165,250,0.4)]"
                  :"border-border bg-black/50 text-muted-foreground hover:border-white/30 hover:text-white"
              }`}
            >
              <span className="w-6 h-6 rounded-sm mb-0.5 border border-black/40 block" style={{backgroundColor:BLOCK_COLORS[item.itemId]??"#888"}}/>
              <span className="uppercase leading-none">{BLOCK_LABELS[item.itemId]??item.itemId}</span>
              <span className="text-primary font-bold">×{item.quantity}</span>
            </button>
          ))
        )}
        {mode==="place" && (
          <button
            onClick={()=>{ setMode("punch"); setSelectedBlock(null); }}
            className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1.5 rounded hover:bg-red-400/10"
          >✕ Cancel</button>
        )}
      </div>

      {/* ── MOBILE D-PAD ────────────────────────────────────────────────────────
          ◀ — move left  + smart auto-target left blocks
          JUMP — jump (also used to jump while auto-mining)
          ▶ — move right + smart auto-target right blocks
          Stops movement AND mining on pointer up/leave.
          All buttons use touch-action:none + e.preventDefault() to stop
          browser from intercepting the touches for scroll or zoom. */}
      <div
        className="md:hidden flex items-center gap-2 px-3 py-2 bg-black/95 border-t border-border shrink-0"
        style={{touchAction:"manipulation"}}
      >
        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold active:bg-primary/20 active:border-primary select-none flex items-center justify-center transition-colors"
          onPointerDown={e=>{ e.preventDefault(); mobileMove("left");  }}
          onPointerUp={e=>  { e.preventDefault(); mobileMove("stop");  }}
          onPointerLeave={e=>{ e.preventDefault(); mobileMove("stop"); }}
          style={{touchAction:"none"}}
        >◀</button>

        <button
          className="flex-1 h-14 rounded-xl bg-primary/20 border-2 border-primary text-primary font-black text-sm uppercase tracking-widest active:bg-primary active:text-black select-none transition-colors"
          onPointerDown={e=>{ e.preventDefault(); mobileMove("jump"); }}
          style={{touchAction:"none"}}
        >JUMP</button>

        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold active:bg-primary/20 active:border-primary select-none flex items-center justify-center transition-colors"
          onPointerDown={e=>{ e.preventDefault(); mobileMove("right"); }}
          onPointerUp={e=>  { e.preventDefault(); mobileMove("stop");  }}
          onPointerLeave={e=>{ e.preventDefault(); mobileMove("stop"); }}
          style={{touchAction:"none"}}
        >▶</button>
      </div>

      {/* ── ANTI-BOT WIZARD CHALLENGE ────────────────────────────────────────── */}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center tracking-widest uppercase text-sm">
              <TriangleAlert className="mr-2 w-4 h-4"/> Anti-Bot Verification
            </DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground text-sm">High action rate detected. Solve to continue:</p>
            <p className="text-3xl font-black text-white">2 + 3 = ?</p>
            <Input
              value={wizardAns}
              onChange={e=>setWizardAns(e.target.value)}
              onKeyDown={e=>{ if(e.key==="Enter"){ if(wizardAns==="5"){setWizard(false);setWizardAns("");}else toast({title:"WRONG",variant:"destructive"}); } }}
              className="text-center text-2xl font-bold text-primary border-primary/50 bg-black"
              placeholder="?"
            />
          </div>
          <DialogFooter>
            <Button
              className="w-full bg-destructive hover:bg-destructive/80 font-bold uppercase tracking-widest"
              onClick={()=>{ if(wizardAns==="5"){setWizard(false);setWizardAns("");toast({title:"VERIFIED ✓",className:"bg-black border-primary text-primary"});}else toast({title:"WRONG ANSWER",variant:"destructive"}); }}
            >Submit Answer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
