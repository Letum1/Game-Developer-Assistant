// ============================================================
// Game.tsx — Growtopia-style 2D block-building world
//
// Controls:
//   Mobile  — ◀ ▶ move | JUMP | ⛏ DIG (hold = auto-mine in front)
//             Tap canvas directly to mine/place a specific block
//   Desktop — WASD / arrow keys + click blocks
//
// Camera / Zoom:
//   Camera follows player smoothly across the 40×25 world.
//   + / − buttons on canvas change zoom (1×–3×).
//   At zoom 2× the blocks are twice as big and easy to tap on mobile.
//
// Mining:
//   Hold-to-mine — holding the canvas or DIG button deals continuous
//   damage (MINING_POWER × dt) each frame. Release = cancel, no auto-mine.
//   Block breaks when health hits 0 → server confirms → drop collected.
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
// CANVAS CONSTANTS — logical pixel size of the canvas element.
// The camera and zoom system maps the 40×25 world onto this viewport.
// ─────────────────────────────────────────────────────────────────────────────
const WW = 800;   // canvas logical width  (px)
const WH = 600;   // canvas logical height (px)

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK SIZE — one world block is always 40×40 world-pixels.
// The camera + zoom transform scales this up on screen.
// ─────────────────────────────────────────────────────────────────────────────
const BS = 40;

// ─────────────────────────────────────────────────────────────────────────────
// ZOOM — default 2× makes blocks 80px on screen (easy to tap on mobile).
// MIN/MAX clamp the range so blocks never become tiny or huge.
// ─────────────────────────────────────────────────────────────────────────────
const ZOOM_DEFAULT = 2.0;
const ZOOM_MIN     = 1.0;
const ZOOM_MAX     = 3.0;
const ZOOM_STEP    = 0.5; // how much + / − changes zoom each press

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
const GRAVITY    = 900;   // px/s² downward
const JUMP_VY    = -420;  // px/s initial upward velocity
const MOVE_SPEED = 175;   // px/s horizontal
const PW         = 26;    // player hitbox width  (world-px)
const PH         = 36;    // player hitbox height (world-px)

// ─────────────────────────────────────────────────────────────────────────────
// DAY / NIGHT CYCLE — 8-minute full cycle
// ─────────────────────────────────────────────────────────────────────────────
const DAY_MS = 480_000;

// ─────────────────────────────────────────────────────────────────────────────
// MINING — continuous hold-to-mine (not tap-per-hit)
//
// BLOCK_HEALTH = seconds to mine at base MINING_POWER (1.0 hp/s).
// Press and hold the canvas or DIG button; release = cancel, block resets.
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_HEALTH: Record<string, number> = {
  block_grass:        0.8,
  block_dirt:         1.5,
  block_rock:         2.5,
  block_iron:         3.5,
  block_gold:         2.5,
  block_diamond:      5.0,
  block_lava:         4.0,
  machine_core:       1.5,
  solar_panel_block:  1.5,
  data_cable:         0.8,
};
const MINING_POWER = 1.0; // health removed per second at base level

// ─────────────────────────────────────────────────────────────────────────────
// TOUCH OFFSET — reticle/target is shifted this many canvas-pixels ABOVE the
// actual finger so the thumb doesn't cover the block being mined.
// ─────────────────────────────────────────────────────────────────────────────
const TOUCH_OFFSET_PX = 55;

// ─────────────────────────────────────────────────────────────────────────────
// REACH — max block-distance player can mine or place from their center.
// ─────────────────────────────────────────────────────────────────────────────
const REACH = 4.0;

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-SCAN — blocks in each direction searched by the DIG button smart cursor.
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_SCAN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK VISUALS
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass: "#15803d", block_dirt: "#78350f", block_rock: "#374151",
  block_iron:  "#6b7280", block_gold: "#b45309", block_diamond: "#0e7490",
  block_lava:  "#b91c1c", machine_core: "#1e1b4b",
  solar_panel_block: "#065f46", data_cable: "#7f1d1d",
};
const BLOCK_TINTS: Record<string, string> = {
  block_grass: "rgba(74,222,128,0.25)",  block_dirt:  "rgba(180,130,80,0.20)",
  block_rock:  "rgba(200,200,220,0.12)", block_iron:  "rgba(210,220,230,0.20)",
  block_gold:  "rgba(255,220,50,0.35)",  block_diamond: "rgba(100,240,255,0.30)",
  block_lava:  "rgba(255,120,0,0.40)",   machine_core: "rgba(150,120,255,0.40)",
  solar_panel_block: "rgba(50,255,160,0.40)", data_cable: "rgba(255,80,80,0.30)",
};
const BLOCK_LABELS: Record<string, string> = {
  block_grass: "Grass", block_dirt: "Dirt", block_rock: "Rock",
  machine_core: "Machine", solar_panel_block: "Solar ☀️", data_cable: "Cable",
};
const PLACEABLE = new Set([
  "block_grass", "block_dirt", "block_rock",
  "machine_core", "solar_panel_block", "data_cable",
]);

// ─────────────────────────────────────────────────────────────────────────────
// SKY — computed per-frame from position in the day cycle
// ─────────────────────────────────────────────────────────────────────────────
type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };
function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS;
  if (t < 0.12) { const f=t/0.12; return {r:255,g:Math.round(80*f),b:0,alpha:0.70-0.60*f,stars:f<0.6}; }
  if (t < 0.22) { const f=(t-0.12)/0.10; return {r:255,g:Math.round(80+140*f),b:Math.round(160*f),alpha:0.10-0.10*f,stars:false}; }
  if (t < 0.55) return {r:135,g:206,b:235,alpha:0,stars:false};
  if (t < 0.68) { const f=(t-0.55)/0.13; return {r:255,g:Math.round(200-120*f),b:Math.round(50-50*f),alpha:0.12*f,stars:false}; }
  if (t < 0.78) { const f=(t-0.68)/0.10; return {r:255,g:Math.round(80-80*f),b:0,alpha:0.12+0.58*f,stars:f>0.5}; }
  return {r:0,g:0,b:20,alpha:0.70,stars:true};
}

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE BLOCK RENDERER — pixel-art visuals for rig components
// ─────────────────────────────────────────────────────────────────────────────
function drawMachineBlock(
  ctx: CanvasRenderingContext2D,
  blk: string, sx: number, sy: number, sz: number  // screen position + size
) {
  // sz = BS * zoom — the block's screen pixel size
  if (blk === "machine_core") {
    ctx.fillStyle="#312e81"; ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const inner = sz * 0.2;
    ctx.fillStyle="rgba(167,139,250,0.8)"; ctx.fillRect(sx+inner,sy+inner,sz-inner*2,sz-inner*2);
    ctx.strokeStyle="rgba(196,181,253,0.9)"; ctx.lineWidth=1.5; ctx.strokeRect(sx+inner,sy+inner,sz-inner*2,sz-inner*2);
    const c = sz/2;
    ctx.strokeStyle="rgba(167,139,250,0.4)"; ctx.lineWidth=1;
    [[sx+inner/2,sy+c,sx+inner,sy+c],[sx+sz-inner,sy+c,sx+sz-inner/2,sy+c],
     [sx+c,sy+inner/2,sx+c,sy+inner],[sx+c,sy+sz-inner,sx+c,sy+sz-inner/2]].forEach(([x1,y1,x2,y2])=>{
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    });
    ctx.strokeStyle="rgba(99,102,241,0.5)"; ctx.lineWidth=1; ctx.strokeRect(sx+1,sy+1,sz-2,sz-2);
  } else if (blk === "solar_panel_block") {
    ctx.fillStyle="#064e3b"; ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const margin = sz*0.1;
    const cell = (sz - margin*2) / 3;
    for (let cy=0;cy<3;cy++) for (let cx=0;cx<3;cx++) {
      ctx.fillStyle=(cx+cy)%2===0?"#065f46":"#047857";
      ctx.fillRect(sx+margin+cx*cell, sy+margin+cy*cell, cell-1, cell-1);
    }
    ctx.strokeStyle="rgba(52,211,153,0.7)"; ctx.lineWidth=1.5; ctx.strokeRect(sx+2,sy+2,sz-4,sz-4);
    ctx.fillStyle="rgba(250,204,21,0.9)"; ctx.beginPath(); ctx.arc(sx+sz/2,sy+sz/2,sz*0.08,0,Math.PI*2); ctx.fill();
  } else if (blk === "data_cable") {
    ctx.fillStyle="#450a0a"; ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const pw=sz*0.3, po=(sz-pw)/2;
    ctx.fillStyle="#dc2626"; ctx.fillRect(sx+po,sy+2,pw,sz-4);
    ctx.fillStyle="#fca5a5"; ctx.fillRect(sx+po+pw*0.3,sy+4,pw*0.3,sz-8);
    ctx.strokeStyle="rgba(239,68,68,0.5)"; ctx.lineWidth=1; ctx.strokeRect(sx+2,sy+2,sz-4,sz-4);
    const fw=sz*0.3, fo=sz*0.65, fh=sz*0.15, fy1=sz*0.1, fy2=sz-sz*0.25;
    [[sx+2,sy+fy1],[sx+fo,sy+fy1],[sx+2,sy+fy2],[sx+fo,sy+fy2]].forEach(([fx,fy])=>{
      ctx.fillStyle="#b91c1c"; ctx.fillRect(fx,fy,fw,fh);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATED MINING RETICLE — drawn over the block being mined.
// Dashes rotate with time. Color shifts green→yellow→red as health drops.
// Health bar appears above the block. Name label above that.
// All sizes are in screen pixels (already zoomed).
// ─────────────────────────────────────────────────────────────────────────────
function drawMiningReticle(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number, sz: number,  // screen position and block screen size
  health: number, maxHealth: number,
  now: number, label: string
) {
  const progress = 1 - health / maxHealth; // 0=fresh, 1=breaking

  // Darken block as it takes damage
  ctx.fillStyle = `rgba(0,0,0,${progress * 0.55})`;
  ctx.fillRect(sx+1, sy+1, sz-2, sz-2);

  // Crack pattern (stage 1–4)
  if (progress >= 0.15) {
    const stage = Math.min(4, Math.floor(progress * 5));
    ctx.save();
    ctx.strokeStyle="rgba(0,0,0,0.9)"; ctx.lineWidth=Math.max(1, sz*0.03);
    const p = (r: number) => r * sz; // proportion of block size
    if (stage>=1){ctx.beginPath();ctx.moveTo(sx+p(0.2),sy+p(0.15));ctx.lineTo(sx+p(0.45),sy+p(0.4));ctx.lineTo(sx+p(0.35),sy+p(0.55));ctx.stroke();}
    if (stage>=2){ctx.beginPath();ctx.moveTo(sx+p(0.75),sy+p(0.2));ctx.lineTo(sx+p(0.55),sy+p(0.5));ctx.lineTo(sx+p(0.7),sy+p(0.75));ctx.stroke();}
    if (stage>=3){ctx.beginPath();ctx.moveTo(sx+p(0.1),sy+p(0.7));ctx.lineTo(sx+p(0.4),sy+p(0.55));ctx.lineTo(sx+p(0.65),sy+p(0.85));ctx.stroke();}
    if (stage>=4){ctx.lineWidth=Math.max(1.5,sz*0.045);ctx.beginPath();ctx.moveTo(sx+p(0.05),sy+p(0.5));ctx.lineTo(sx+p(0.95),sy+p(0.45));ctx.stroke();ctx.beginPath();ctx.moveTo(sx+p(0.5),sy+p(0.05));ctx.lineTo(sx+p(0.45),sy+p(0.95));ctx.stroke();}
    ctx.restore();
  }

  // Animated dashed reticle border
  const dashOffset = (now / 80) % 16;
  const color = progress > 0.6 ? "#ef4444" : progress > 0.3 ? "#f59e0b" : "#22c55e";
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, sz*0.05);
  ctx.setLineDash([6, 4]); ctx.lineDashOffset = -dashOffset;
  const pulse = Math.sin(now/150) * Math.max(1, sz*0.04);
  ctx.strokeRect(sx+2+pulse, sy+2+pulse, sz-4-pulse*2, sz-4-pulse*2);
  ctx.setLineDash([]);
  ctx.restore();

  // Corner accent squares
  const c = Math.max(4, sz * 0.12);
  ctx.fillStyle = color;
  [[sx,sy],[sx+sz-c,sy],[sx,sy+sz-c],[sx+sz-c,sy+sz-c]].forEach(([rx,ry])=>{
    ctx.fillRect(rx,ry,c,c);
  });

  // Health bar above block
  const barH = Math.max(4, sz * 0.09);
  const barY = sy - barH - 3;
  ctx.fillStyle="rgba(0,0,0,0.75)"; ctx.fillRect(sx, barY, sz, barH);
  const gr = Math.round(255 * progress), gg = Math.round(255 * (1-progress*0.7));
  ctx.fillStyle=`rgb(${gr},${gg},0)`; ctx.fillRect(sx, barY, sz * health/maxHealth, barH);
  ctx.strokeStyle="rgba(255,255,255,0.25)"; ctx.lineWidth=0.5; ctx.strokeRect(sx,barY,sz,barH);

  // Block name label above health bar
  const fontSize = Math.max(9, sz * 0.22);
  ctx.font = `bold ${fontSize}px monospace`;
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.textAlign = "center";
  ctx.fillText(label, sx + sz/2, barY - 3);
  ctx.textAlign = "left";
}

// ─────────────────────────────────────────────────────────────────────────────
// PUNCH FLASH — white-yellow flash over a block the moment it is hit
// ─────────────────────────────────────────────────────────────────────────────
function drawPunchFlash(ctx: CanvasRenderingContext2D, sx: number, sy: number, sz: number, alpha: number) {
  ctx.fillStyle=`rgba(255,255,200,${alpha*0.45})`;
  ctx.fillRect(sx+2,sy+2,sz-4,sz-4);
}

// ============================================================
// MAIN GAME COMPONENT
// ============================================================
export default function Game() {

  const userId   = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Server data ───────────────────────────────────────────────────────────
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
  const { toast }  = useToast();

  // ── Physics ref — never causes re-renders ─────────────────────────────────
  const physRef = useRef({
    px: 5*BS, py: 0, vx: 0, vy: 0,
    onGround: false, facingRight: true, spawned: false,
  });

  // ── Camera ref — top-left corner of viewport in world-pixels ─────────────
  // Updated each frame to smoothly follow the player.
  const camRef = useRef({ x: 0, y: 0 });

  // ── Zoom ref — block screen size = BS × zoom ──────────────────────────────
  const zoomRef = useRef(ZOOM_DEFAULT);

  // ── World grid (local copy for collision + rendering) ─────────────────────
  const worldRef  = useRef<string[][] | null>(null);
  const rafRef    = useRef(0);
  const lastTRef  = useRef(0);
  const keysRef   = useRef<Set<string>>(new Set());

  // ── Mining state — tracks the ONE block currently being damaged ───────────
  // active=true means the hold is happening; damage accumulates each frame.
  // Releasing touch/mouse/DIG sets active=false, resetting progress.
  const miningRef = useRef<{
    active: boolean;
    bx: number; by: number;
    health: number; maxHealth: number;
    blockType: string;
  }>({ active:false, bx:0, by:0, health:0, maxHealth:0, blockType:"" });

  // ── DIG button held — separate from canvas touch so D-pad and dig are independent
  const digHeldRef      = useRef(false);
  // ── Prevents double-sending the break request before server replies ───────
  const pendingBreakRef = useRef(false);
  // ── Punch flash map — "bx,by" → alpha (0–1) ──────────────────────────────
  const flashRef        = useRef<Map<string, number>>(new Map());
  // ── isPrimary guard for D-pad ─────────────────────────────────────────────
  const isPinchingRef   = useRef(false);

  // ── React UI state ────────────────────────────────────────────────────────
  const [mode,          setMode]         = useState<"punch"|"place">("punch");
  const [selectedBlock, setSelectedBlock] = useState<string|null>(null);
  const [wizard,        setWizard]        = useState(false);
  const [wizardAns,     setWizardAns]     = useState("");
  const [chatOpen,      setChatOpen]      = useState(false);
  const [chatMsgs,      setChatMsgs]      = useState<{username:string;message:string}[]>([]);
  const [chatInput,     setChatInput]     = useState("");
  const [zoom,          setZoom]          = useState(ZOOM_DEFAULT); // React state for re-render

  const wsRef    = useRef<WebSocket|null>(null);
  const starsRef = useRef(
    Array.from({length:80},()=>({
      x:Math.random()*WW, y:Math.random()*WH*0.5,
      r:Math.random()*1.5+0.4, twinkle:Math.random()*Math.PI*2,
    }))
  );

  // ── Sync zoom React state → ref so the game loop sees it instantly ────────
  // (React state is for re-rendering the buttons; ref is for the RAF loop)
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: world data → local ref + spawn
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;
    if (!physRef.current.spawned) {
      const bd = world.blockData;
      let sy = 0;
      for (let y=0;y<bd.length;y++) { if (bd[y][5]==="air") { sy=y; break; } }
      physRef.current.py = sy * BS;
      physRef.current.px = 5 * BS + (BS-PW)/2;
      physRef.current.spawned = true;
    }
  }, [world]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: multiplayer chat WebSocket
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    const proto = location.protocol==="https:"?"wss:":"ws:";
    const ws    = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try { const m=JSON.parse(e.data as string); setChatMsgs(prev=>[...prev.slice(-29),m]); } catch {}
    };
    return () => ws.close();
  }, []);

  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim()||!ws||ws.readyState!==WebSocket.OPEN) return;
    ws.send(JSON.stringify({username,message:chatInput.trim()}));
    setChatInput("");
  };

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: solid(bx, by) — is that grid cell non-air? (for physics)
  // ════════════════════════════════════════════════════════════════════════════
  const solid = useCallback((bx:number,by:number):boolean=>{
    const bd=worldRef.current;
    if (!bd) return false;
    if (by<0) return false;
    if (by>=bd.length) return true;
    if (bx<0||bx>=bd[0].length) return true;
    return bd[by][bx]!=="air";
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: worldToScreen(worldX, worldY) → (sx, sy)
  // Converts world-pixel position to canvas screen-pixel position using the
  // current camera position and zoom level.
  // ════════════════════════════════════════════════════════════════════════════
  const worldToScreen = useCallback((wx:number,wy:number):{sx:number;sy:number}=>{
    const z = zoomRef.current;
    const c = camRef.current;
    return { sx:(wx-c.x)*z, sy:(wy-c.y)*z };
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: screenToBlock(clientX, clientY, applyOffset?)
  // Converts a screen touch/click point to the block grid cell it lands on.
  // Uses the current camera and zoom so the mapping is always accurate.
  // applyOffset=true shifts the target UP by TOUCH_OFFSET_PX canvas pixels so
  // the thumb doesn't cover the block being mined on mobile.
  // ════════════════════════════════════════════════════════════════════════════
  const screenToBlock = useCallback((clientX:number,clientY:number,applyOffset=false):{bx:number;by:number}|null=>{
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();

    // Convert browser pixels → canvas logical pixels (WW×WH space)
    const cx = (clientX - rect.left) / rect.width  * WW;
    const cy = (clientY - rect.top)  / rect.height * WH;

    // Apply upward touch offset so target is above thumb
    const acy = applyOffset ? cy - TOUCH_OFFSET_PX : cy;

    // Unzoom + camera offset → world-pixel → block grid
    const z = zoomRef.current;
    const c = camRef.current;
    const wx = cx  / z + c.x;
    const wy = acy / z + c.y;

    const bd = worldRef.current;
    const bx = Math.floor(wx / BS);
    const by = Math.floor(wy / BS);
    if (!bd||bx<0||by<0||bx>=bd[0].length||by>=bd.length) return null;
    return {bx,by};
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: findAutoTarget(dir)
  // Smart DIG cursor — scans blocks in front of player in the given direction
  // and returns the nearest breakable block within REACH, or null.
  // ════════════════════════════════════════════════════════════════════════════
  const findAutoTarget = useCallback((dir:"left"|"right"):{bx:number;by:number}|null=>{
    const bd=worldRef.current; if (!bd) return null;
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS, pcy=(p.py+PH/2)/BS;
    const topRow=Math.floor(p.py/BS), botRow=Math.floor((p.py+PH)/BS);
    let best:{bx:number;by:number;dist:number}|null=null;
    // Scan columns in front
    for (let step=1;step<=AUTO_SCAN;step++) {
      const col=dir==="right"?Math.floor(pcx)+step:Math.ceil(pcx)-step;
      for (let row=topRow-1;row<=botRow+1;row++) {
        if (row<0||row>=bd.length||col<0||col>=bd[0].length) continue;
        if (bd[row][col]==="air") continue;
        const dist=Math.sqrt((col-pcx)**2+(row-pcy)**2);
        if (dist>REACH) continue;
        if (!best||dist<best.dist) best={bx:col,by:row,dist};
      }
    }
    // Also check directly below (for downward digging)
    const belowRow=botRow+1, belowCol=Math.round(pcx);
    if (belowRow>=0&&belowRow<bd.length&&belowCol>=0&&belowCol<bd[0].length&&bd[belowRow][belowCol]!=="air") {
      const dist=Math.sqrt((belowCol-pcx)**2+(belowRow-pcy)**2);
      if (dist<=REACH&&(!best||dist<best.dist)) best={bx:belowCol,by:belowRow,dist};
    }
    return best?{bx:best.bx,by:best.by}:null;
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: startMining(bx, by)
  // Begins continuous hold-to-mine on block at (bx, by).
  // If called while already mining the SAME block, it continues undisturbed
  // so re-entering the block area doesn't reset the health.
  // ════════════════════════════════════════════════════════════════════════════
  const startMining = useCallback((bx:number,by:number)=>{
    const bd=worldRef.current; if (!bd) return;
    const blk=bd[by]?.[bx];
    if (!blk||blk==="air") return;
    // Range check
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS, pcy=(p.py+PH/2)/BS;
    if (Math.sqrt((bx-pcx)**2+(by-pcy)**2)>REACH) return;
    // Don't restart if same block is already being mined
    if (miningRef.current.active&&miningRef.current.bx===bx&&miningRef.current.by===by) return;
    const maxHealth=BLOCK_HEALTH[blk]??2.0;
    miningRef.current={active:true,bx,by,health:maxHealth,maxHealth,blockType:blk};
    flashRef.current.set(`${bx},${by}`,1.0);
    physRef.current.facingRight=bx>=pcx;
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: stopMining()
  // Cancels the current mining operation. Partial damage is lost.
  // Called on touch-end, pointer-up, or when walking out of range.
  // ════════════════════════════════════════════════════════════════════════════
  const stopMining = useCallback(()=>{
    miningRef.current.active=false;
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: breakBlock(bx, by)
  // Called when a block's health hits 0. Sends the break action to the server.
  // Optimistic update removes the block instantly for responsive feel.
  // ════════════════════════════════════════════════════════════════════════════
  const breakBlock = useCallback((bx:number,by:number)=>{
    const bd=worldRef.current;
    if (!bd||pendingBreakRef.current) return;
    pendingBreakRef.current=true;
    miningRef.current.active=false;
    const updated=bd.map(r=>[...r]); updated[by][bx]="air";
    worldRef.current=updated;
    gameAction.mutate(
      {data:{actionType:"break",worldName:"start",x:bx,y:by}},
      {
        onSuccess:(data)=>{
          pendingBreakRef.current=false;
          if (data.wizardChallenge){setWizard(true);return;}
          if (data.success){
            if (data.dropItem) toast({title:`+1 ${data.dropItem.toUpperCase().replace(/_/g," ")}`,className:"border-primary bg-black text-primary font-mono uppercase text-xs"});
            refetchWorld(); refetchInventory();
          }
        },
        onError:()=>{ pendingBreakRef.current=false; worldRef.current=bd; },
      }
    );
  },[gameAction,refetchWorld,refetchInventory,toast]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPER: placeBlock(bx, by)
  // Places the selected hotbar block at an empty grid cell.
  // ════════════════════════════════════════════════════════════════════════════
  const placeBlock = useCallback((bx:number,by:number)=>{
    if (!selectedBlock) return;
    const bd=worldRef.current; if (!bd||bd[by]?.[bx]!=="air") {
      toast({title:"BLOCKED",description:"That space is occupied.",className:"bg-black border-yellow-500 text-yellow-400 font-mono text-xs"}); return;
    }
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS, pcy=(p.py+PH/2)/BS;
    if (Math.sqrt((bx-pcx)**2+(by-pcy)**2)>REACH){
      toast({title:"OUT OF REACH",description:"Walk closer.",className:"bg-black border-border text-muted-foreground font-mono text-xs"}); return;
    }
    const updated=bd.map(r=>[...r]); updated[by][bx]=selectedBlock; worldRef.current=updated;
    gameAction.mutate(
      {data:{actionType:"place",worldName:"start",x:bx,y:by,placeBlock:selectedBlock}},
      {
        onSuccess:(data)=>{
          if (data.success){
            if ((data as {machineUpdated?:boolean}).machineUpdated) toast({title:"⚡ RIG UPDATED",description:"Solar panels now powering your core!",className:"bg-black border-violet-500 text-violet-400 font-mono text-xs"});
            refetchWorld(); refetchInventory();
          } else { worldRef.current=bd; toast({title:"PLACE FAILED",variant:"destructive"}); }
        },
        onError:()=>{ worldRef.current=bd; },
      }
    );
  },[selectedBlock,gameAction,refetchWorld,refetchInventory,toast]);

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN GAME LOOP — drawFrame(now)
  // Order: physics → mining damage → camera → sky → blocks → reticle → player
  // ════════════════════════════════════════════════════════════════════════════
  const drawFrame = useCallback((now:number)=>{
    const canvas=canvasRef.current; if (!canvas) return;
    const ctx=canvas.getContext("2d"); if (!ctx) return;

    const dt=Math.min((now-lastTRef.current)/1000,0.05);
    lastTRef.current=now;

    const p  = physRef.current;
    const bd = worldRef.current;

    // ── CONTINUOUS MINING DAMAGE ─────────────────────────────────────────────
    // Only runs when actively holding canvas or DIG button.
    // D-pad movement alone does NOT trigger this (fixed bug).
    if (miningRef.current.active) {
      const m=miningRef.current;
      if (!bd||bd[m.by]?.[m.bx]==="air") {
        miningRef.current.active=false; // block was broken by someone else
      } else {
        const pcx=(p.px+PW/2)/BS, pcy=(p.py+PH/2)/BS;
        if (Math.sqrt((m.bx-pcx)**2+(m.by-pcy)**2)>REACH) {
          miningRef.current.active=false; // walked out of range
        } else {
          m.health-=MINING_POWER*dt;
          flashRef.current.set(`${m.bx},${m.by}`,0.25);
          if (m.health<=0) breakBlock(m.bx,m.by);
        }
      }
    }

    // ── DIG BUTTON AUTO-TARGET ────────────────────────────────────────────────
    // Only runs when the DIG button is physically held AND we're not already
    // mining something. Finds the closest block in front of the player.
    if (digHeldRef.current && !miningRef.current.active) {
      const dir=p.facingRight?"right":"left";
      const target=findAutoTarget(dir);
      if (target) startMining(target.bx,target.by);
    }

    // ── PHYSICS ───────────────────────────────────────────────────────────────
    if (bd) {
      // Horizontal
      const npx=p.px+p.vx*dt;
      const ty0=Math.floor((p.py+2)/BS), ty1=Math.floor((p.py+PH-2)/BS);
      if      (p.vx>0){const tx=Math.floor((npx+PW)/BS);if(!solid(tx,ty0)&&!solid(tx,ty1))p.px=npx;else p.px=tx*BS-PW;}
      else if (p.vx<0){const tx=Math.floor(npx/BS);if(!solid(tx,ty0)&&!solid(tx,ty1))p.px=npx;else p.px=(tx+1)*BS;}
      p.px=Math.max(0,Math.min(bd[0].length*BS-PW,p.px));
      // Vertical + gravity
      p.vy=Math.min(p.vy+GRAVITY*dt,850);
      const npy=p.py+p.vy*dt;
      const tx0=Math.floor((p.px+2)/BS), tx1=Math.floor((p.px+PW-2)/BS);
      p.onGround=false;
      if (p.vy>=0){const ty=Math.floor((npy+PH)/BS);if(solid(tx0,ty)||solid(tx1,ty)){p.py=ty*BS-PH;p.vy=0;p.onGround=true;}else p.py=npy;}
      else        {const ty=Math.floor(npy/BS);if(solid(tx0,ty)||solid(tx1,ty)){p.py=(ty+1)*BS;p.vy=0;}else p.py=npy;}
      p.py=Math.max(0,Math.min(bd.length*BS-PH,p.py));
    }

    // ── CAMERA — smoothly follows player center ───────────────────────────────
    const z=zoomRef.current;
    const viewW=WW/z, viewH=WH/z;
    const worldW=bd?bd[0].length:20, worldH=bd?bd.length:15;
    const targetCamX=p.px+PW/2-viewW/2;
    const targetCamY=p.py+PH/2-viewH/2;
    const clampedCamX=Math.max(0,Math.min(worldW*BS-viewW,targetCamX));
    const clampedCamY=Math.max(0,Math.min(worldH*BS-viewH,targetCamY));
    // Lerp camera for smooth follow (0.15 = how fast camera catches up)
    camRef.current.x+=(clampedCamX-camRef.current.x)*0.15;
    camRef.current.y+=(clampedCamY-camRef.current.y)*0.15;
    const camX=camRef.current.x, camY=camRef.current.y;

    // ── CLEAR + SKY ───────────────────────────────────────────────────────────
    ctx.clearRect(0,0,WW,WH);
    const sky=getSky(now);
    const grad=ctx.createLinearGradient(0,0,0,WH);
    if (sky.alpha>0.35){grad.addColorStop(0,`rgb(${sky.r},${sky.g},${sky.b})`);grad.addColorStop(1,"#0a0010");}
    else               {grad.addColorStop(0,"#1a3a5c");grad.addColorStop(0.5,"#0f2035");grad.addColorStop(1,"#050d14");}
    ctx.fillStyle=grad; ctx.fillRect(0,0,WW,WH);

    // ── STARS (fixed screen-space, no camera) ─────────────────────────────────
    if (sky.stars&&sky.alpha>0.1) {
      const sa=Math.min(1,(sky.alpha-0.1)*2);
      starsRef.current.forEach(s=>{
        const tw=0.7+0.3*Math.sin(now/800+s.twinkle);
        ctx.fillStyle=`rgba(255,255,255,${sa*tw})`; ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.fill();
      });
    }

    // ── SUN / MOON (screen-space arc, no camera) ──────────────────────────────
    const t=(now%DAY_MS)/DAY_MS;
    if (sky.alpha<0.4){
      const a=t*Math.PI*2-Math.PI/2;
      const sx2=WW/2+Math.cos(a)*320, sy2=WH*0.5+Math.sin(a)*280;
      if (sy2<WH*0.55){const sg=ctx.createRadialGradient(sx2,sy2,0,sx2,sy2,28);sg.addColorStop(0,"rgba(255,240,100,1)");sg.addColorStop(0.5,"rgba(255,180,0,0.8)");sg.addColorStop(1,"rgba(255,140,0,0)");ctx.fillStyle=sg;ctx.beginPath();ctx.arc(sx2,sy2,28,0,Math.PI*2);ctx.fill();}
    } else if (sky.alpha>0.5){
      const a=(t+0.5)*Math.PI*2-Math.PI/2;
      const mx=WW/2+Math.cos(a)*320, my=WH*0.5+Math.sin(a)*280;
      if (my<WH*0.55){ctx.fillStyle="rgba(220,230,255,0.9)";ctx.beginPath();ctx.arc(mx,my,16,0,Math.PI*2);ctx.fill();ctx.fillStyle="rgba(10,0,30,0.85)";ctx.beginPath();ctx.arc(mx+6,my-4,13,0,Math.PI*2);ctx.fill();}
    }

    // ── BLOCKS (camera + zoom transform) ─────────────────────────────────────
    const sz=BS*z; // block size in screen pixels
    if (bd) {
      // Only render blocks actually visible in the viewport (performance)
      const startCol=Math.max(0,Math.floor(camX/BS));
      const endCol  =Math.min(bd[0].length-1,Math.ceil((camX+viewW)/BS));
      const startRow=Math.max(0,Math.floor(camY/BS));
      const endRow  =Math.min(bd.length-1,Math.ceil((camY+viewH)/BS));

      for (let row=startRow;row<=endRow;row++) {
        for (let col=startCol;col<=endCol;col++) {
          const blk=bd[row][col];
          if (blk==="air") continue;
          const bsx=(col*BS-camX)*z; // block screen X
          const bsy=(row*BS-camY)*z; // block screen Y

          if (blk==="machine_core"||blk==="solar_panel_block"||blk==="data_cable") {
            drawMachineBlock(ctx,blk,bsx,bsy,sz);
          } else {
            ctx.fillStyle=BLOCK_COLORS[blk]??"#1e293b"; ctx.fillRect(bsx,bsy,sz,sz);
            // Top-edge shimmer tint
            ctx.fillStyle=BLOCK_TINTS[blk]??"rgba(255,255,255,0.07)"; ctx.fillRect(bsx+1,bsy+1,sz-2,Math.max(3,sz*0.12));
            // Block border
            ctx.strokeStyle="rgba(0,0,0,0.4)"; ctx.lineWidth=1; ctx.strokeRect(bsx+0.5,bsy+0.5,sz-1,sz-1);
          }
        }
      }

      // ── MINING RETICLE — over the block currently being mined ──────────────
      const m=miningRef.current;
      if (m.active&&bd[m.by]?.[m.bx]!=="air") {
        const rsx=(m.bx*BS-camX)*z;
        const rsy=(m.by*BS-camY)*z;
        const label=BLOCK_LABELS[m.blockType]??m.blockType.replace("block_","").toUpperCase();
        drawMiningReticle(ctx,rsx,rsy,sz,m.health,m.maxHealth,now,label);
      }

      // ── PUNCH FLASH ─────────────────────────────────────────────────────────
      flashRef.current.forEach((alpha,key)=>{
        const [bxStr,byStr]=key.split(",");
        const bx2=parseInt(bxStr), by2=parseInt(byStr);
        const fsx=(bx2*BS-camX)*z, fsy=(by2*BS-camY)*z;
        drawPunchFlash(ctx,fsx,fsy,sz,alpha);
        const na=alpha-0.15;
        if (na<=0) flashRef.current.delete(key); else flashRef.current.set(key,na);
      });
    }

    // ── PLAYER SPRITE (camera + zoom transform) ────────────────────────────────
    const {px,py,facingRight:fr}=p;
    const psx=(px-camX)*z, psy=(py-camY)*z;
    const pw2=PW*z, ph2=PH*z;
    ctx.fillStyle="#1e4d2b"; ctx.fillRect(psx+pw2*0.19,psy+ph2*0.39,pw2*0.62,ph2*0.61);   // body
    ctx.fillStyle="#fbbf24"; ctx.fillRect(psx+pw2*0.11,psy+ph2*0.06,pw2*0.78,ph2*0.39);    // head
    ctx.fillStyle="#000";    ctx.fillRect(fr?psx+pw2*0.5:psx+pw2*0.19,psy+ph2*0.19,pw2*0.15,ph2*0.11); // eye
    ctx.fillStyle="#22c55e"; ctx.fillRect(fr?psx+pw2*0.54:psx+pw2*0.23,psy+ph2*0.22,pw2*0.08,ph2*0.06); // glow
    if (mode==="place"&&selectedBlock) {
      const tx=fr?psx+pw2+2:psx-pw2*0.25, ty=psy+ph2*0.39;
      ctx.fillStyle=BLOCK_COLORS[selectedBlock]??"#aaa"; ctx.fillRect(tx,ty,pw2*0.25,pw2*0.25);
      ctx.strokeStyle="#fff"; ctx.lineWidth=1; ctx.strokeRect(tx,ty,pw2*0.25,pw2*0.25);
    } else {
      ctx.fillStyle="#9ca3af"; ctx.fillRect(fr?psx+pw2+1:psx-pw2*0.19,psy+ph2*0.44,pw2*0.15,ph2*0.39);
      ctx.fillStyle="#6b7280"; ctx.fillRect(fr?psx+pw2:psx-pw2*0.23,psy+ph2*0.36,pw2*0.23,pw2*0.23);
    }

    // ── REACH RING (faint circle, only when mining) ────────────────────────────
    const m2=miningRef.current;
    if (m2.active) {
      ctx.save();
      ctx.strokeStyle=`rgba(255,200,0,${0.2+0.15*Math.sin(now/120)})`;
      ctx.lineWidth=1.5;
      ctx.beginPath();
      ctx.arc(psx+pw2/2, psy+ph2/2, REACH*BS*z, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
    }

    // ── NIGHT OVERLAY ─────────────────────────────────────────────────────────
    if (sky.alpha>0){ctx.fillStyle=`rgba(0,0,20,${sky.alpha*0.45})`;ctx.fillRect(0,0,WW,WH);}

    // ── CRT SCANLINES ─────────────────────────────────────────────────────────
    ctx.fillStyle="rgba(0,0,0,0.035)";
    for (let scanY=0;scanY<WH;scanY+=4) ctx.fillRect(0,scanY,WW,2);

    rafRef.current=requestAnimationFrame(drawFrame);
  },[solid,mode,selectedBlock,findAutoTarget,startMining,breakBlock]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: start / stop game loop
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    lastTRef.current=performance.now();
    rafRef.current=requestAnimationFrame(drawFrame);
    return ()=>cancelAnimationFrame(rafRef.current);
  },[drawFrame]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: keyboard controls
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      keysRef.current.add(e.key);
      const p=physRef.current;
      if(["ArrowLeft","a","A"].includes(e.key)){p.vx=-MOVE_SPEED;p.facingRight=false;}
      if(["ArrowRight","d","D"].includes(e.key)){p.vx=MOVE_SPEED;p.facingRight=true;}
      if([" ","ArrowUp","w","W"].includes(e.key)&&p.onGround){p.vy=JUMP_VY;p.onGround=false;e.preventDefault();}
    };
    const up=(e:KeyboardEvent)=>{
      keysRef.current.delete(e.key);
      const keys=keysRef.current;
      const goL=keys.has("ArrowLeft")||keys.has("a")||keys.has("A");
      const goR=keys.has("ArrowRight")||keys.has("d")||keys.has("D");
      if(!goL&&!goR) physRef.current.vx=0;
      else if(goL){physRef.current.vx=-MOVE_SPEED;physRef.current.facingRight=false;}
      else         {physRef.current.vx=MOVE_SPEED; physRef.current.facingRight=true;}
    };
    window.addEventListener("keydown",down);
    window.addEventListener("keyup",up);
    return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);};
  },[]);

  // ════════════════════════════════════════════════════════════════════════════
  // CANVAS TOUCH HANDLERS
  // touchstart → startMining at position ABOVE finger (offset)
  // touchmove  → retarget as finger drags
  // touchend   → stopMining
  // ════════════════════════════════════════════════════════════════════════════
  const handleTouchStart=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    if (e.touches.length>1||isPinchingRef.current) return;
    e.preventDefault();
    const touch=e.touches[0];
    if (mode==="place") { const t=screenToBlock(touch.clientX,touch.clientY,false); if(t) placeBlock(t.bx,t.by); }
    else { const t=screenToBlock(touch.clientX,touch.clientY,true); if(t) startMining(t.bx,t.by); }
  },[mode,screenToBlock,startMining,placeBlock]);

  const handleTouchMove=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    if (e.touches.length>1||isPinchingRef.current||mode!=="punch") return;
    e.preventDefault();
    const touch=e.touches[0];
    const t=screenToBlock(touch.clientX,touch.clientY,true);
    if (!t) return;
    if (t.bx!==miningRef.current.bx||t.by!==miningRef.current.by) startMining(t.bx,t.by);
  },[mode,screenToBlock,startMining]);

  const handleTouchEnd=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    e.preventDefault(); if(e.touches.length===0) stopMining();
  },[stopMining]);

  // Desktop click
  const handleCanvasClick=useCallback((e:React.MouseEvent<HTMLCanvasElement>)=>{
    const t=screenToBlock(e.clientX,e.clientY,false); if (!t) return;
    if (mode==="place") placeBlock(t.bx,t.by);
    else { startMining(t.bx,t.by); setTimeout(()=>{miningRef.current.health=0;},60); }
  },[mode,screenToBlock,placeBlock,startMining]);

  // Clear mining when world reloads
  useEffect(()=>{ miningRef.current.active=false; },[world]);

  // ════════════════════════════════════════════════════════════════════════════
  // EFFECT: pinch detection — disables canvas touch during two-finger zoom
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    const onStart=(e:TouchEvent)=>{ if(e.touches.length>=2){isPinchingRef.current=true;physRef.current.vx=0;stopMining();} };
    const onEnd=(e:TouchEvent)=>{ if(e.touches.length<2) isPinchingRef.current=false; };
    window.addEventListener("touchstart",onStart,{passive:true});
    window.addEventListener("touchend",onEnd,{passive:true});
    window.addEventListener("touchcancel",onEnd,{passive:true});
    return()=>{window.removeEventListener("touchstart",onStart);window.removeEventListener("touchend",onEnd);window.removeEventListener("touchcancel",onEnd);};
  },[stopMining]);

  // ════════════════════════════════════════════════════════════════════════════
  // MOBILE CONTROLS
  //
  // mobileMove(dir) — moves the player. Uses e.isPrimary so only the FIRST
  // finger can trigger movement (second finger = pinch zoom = ignored).
  //
  // DIG button — sets digHeldRef=true so the game loop can auto-target a block
  // in front of the player and begin mining it. Release stops mining.
  // ════════════════════════════════════════════════════════════════════════════
  const mobileMove=(dir:"left"|"right"|"stop"|"jump")=>{
    if (isPinchingRef.current) return;
    const p=physRef.current;
    if(dir==="left") {p.vx=-MOVE_SPEED;p.facingRight=false;}
    if(dir==="right"){p.vx=MOVE_SPEED; p.facingRight=true;}
    if(dir==="stop") {p.vx=0;}
    if(dir==="jump"&&p.onGround){p.vy=JUMP_VY;p.onGround=false;}
  };

  const hotbarItems=inventory.filter(i=>PLACEABLE.has(i.itemId)&&i.quantity>0);

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="flex flex-col h-full bg-background overflow-hidden select-none">

      {/* ── TOP HUD ─────────────────────────────────────────────────────────── */}
      <div className="flex justify-between items-center px-2 py-1.5 bg-black/95 border-b border-border z-10 shrink-0 gap-2 flex-wrap">
        <div className="bg-black/60 px-2 py-1 rounded border border-primary/20 font-mono">
          <span className="text-muted-foreground uppercase block leading-none text-[9px]">Player</span>
          <span className="text-white font-bold text-xs">{username}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="flex border border-border rounded overflow-hidden font-mono text-[10px]">
            <button onClick={()=>{setMode("punch");stopMining();}} className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${mode==="punch"?"bg-red-600 text-white":"bg-black/40 text-muted-foreground hover:text-red-400"}`}>⛏ Mine</button>
            <button onClick={()=>{setMode("place");stopMining();}} className={`px-2.5 py-1.5 font-bold uppercase transition-colors ${mode==="place"?"bg-blue-600 text-white":"bg-black/40 text-muted-foreground hover:text-blue-400"}`}>🧱 Place</button>
          </div>
          <div className="bg-black/60 px-2 py-1 rounded border border-accent/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Energy</span>
            <div className="flex items-center text-accent font-bold"><Zap className="w-3 h-3 mr-0.5"/>{wallet?.actionCount??0}/100</div>
          </div>
          <div className="bg-black/60 px-2 py-1 rounded border border-primary/30 text-[10px] font-mono">
            <span className="text-muted-foreground uppercase block leading-none text-[9px]">Gems</span>
            <span className="text-primary font-bold">{wallet?.gems??0} 💎</span>
          </div>
          <button onClick={()=>setChatOpen(s=>!s)} className={`p-1.5 rounded border transition-colors ${chatOpen?"border-primary text-primary bg-primary/10":"border-border text-muted-foreground hover:text-primary"}`}><MessageSquare className="w-4 h-4"/></button>
        </div>
      </div>

      {/* ── CANVAS + CHAT ────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 bg-[#050d14] flex items-center justify-center relative overflow-hidden" style={{touchAction:"none"}}>
          <canvas
            ref={canvasRef} width={WW} height={WH}
            onClick={handleCanvasClick}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            className="max-w-full max-h-full object-contain border border-border/30"
            style={{imageRendering:"pixelated",cursor:mode==="place"?"cell":"crosshair",touchAction:"none"}}
          />

          {/* Mode label */}
          <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase pointer-events-none ${mode==="place"?"bg-blue-600/80 text-white":"bg-red-600/80 text-white"}`}>
            {mode==="place"?`📦 PLACE: ${selectedBlock?(BLOCK_LABELS[selectedBlock]??selectedBlock):"pick block below"}`:"⛏ HOLD TO MINE"}
          </div>

          {/* ── ZOOM BUTTONS overlaid on canvas (+ and −) ──────────────────────
              These let the player zoom in for precision or out to see more world.
              At 2× (default) each block is 80px on screen — comfortable for mobile.
              At 3× blocks are 120px. At 1× the full world fits the viewport. */}
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            <button
              onClick={()=>setZoom(z=>Math.min(ZOOM_MAX,+(z+ZOOM_STEP).toFixed(1)))}
              className="w-8 h-8 rounded bg-black/70 border border-border text-white font-bold text-lg flex items-center justify-center hover:bg-primary/20 hover:border-primary transition-colors"
              title="Zoom In"
            >+</button>
            <div className="text-center text-[9px] font-mono text-muted-foreground bg-black/60 rounded px-1">{zoom}×</div>
            <button
              onClick={()=>setZoom(z=>Math.max(ZOOM_MIN,+(z-ZOOM_STEP).toFixed(1)))}
              className="w-8 h-8 rounded bg-black/70 border border-border text-white font-bold text-xl flex items-center justify-center hover:bg-primary/20 hover:border-primary transition-colors"
              title="Zoom Out"
            >−</button>
          </div>
        </div>

        {/* Chat panel */}
        {chatOpen&&(
          <div className="w-48 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-primary font-bold text-[10px] uppercase tracking-widest">World Chat</span>
              <button onClick={()=>setChatOpen(false)}><X className="w-3 h-3 text-muted-foreground hover:text-white"/></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
              {chatMsgs.length===0&&<p className="text-muted-foreground italic text-[10px]">No messages yet — say hi!</p>}
              {chatMsgs.map((m,i)=><div key={i} className="break-words leading-tight"><span className="text-primary font-bold">{m.username}: </span><span className="text-gray-300">{m.message}</span></div>)}
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
        {hotbarItems.length===0?(
          <span className="text-muted-foreground text-[9px] font-mono italic">Mine blocks or craft machines to build</span>
        ):(
          hotbarItems.map(item=>(
            <button key={item.itemId} onClick={()=>{setSelectedBlock(item.itemId);setMode("place");stopMining();}}
              className={`flex flex-col items-center px-2 py-1.5 rounded border text-[9px] font-mono transition-all shrink-0 min-w-[48px] ${selectedBlock===item.itemId&&mode==="place"?"border-blue-400 bg-blue-400/20 text-white shadow-[0_0_8px_rgba(96,165,250,0.4)]":"border-border bg-black/50 text-muted-foreground hover:border-white/30 hover:text-white"}`}>
              <span className="w-6 h-6 rounded-sm mb-0.5 border border-black/40 block" style={{backgroundColor:BLOCK_COLORS[item.itemId]??"#888"}}/>
              <span className="uppercase leading-none">{BLOCK_LABELS[item.itemId]??item.itemId}</span>
              <span className="text-primary font-bold">×{item.quantity}</span>
            </button>
          ))
        )}
        {mode==="place"&&<button onClick={()=>{setMode("punch");setSelectedBlock(null);}} className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1.5 rounded hover:bg-red-400/10">✕ Cancel</button>}
      </div>

      {/* ── MOBILE D-PAD ────────────────────────────────────────────────────────
          Layout: [◀] [⛏ DIG] [JUMP] [▶]
          ◀ ▶  — walk left/right (movement ONLY — no auto-mine)
          ⛏    — hold to auto-mine block in front of player (DIG button)
          JUMP — jump
          All buttons check e.isPrimary so only the FIRST finger controls them.
          A second finger (pinch-zoom gesture) is automatically ignored. */}
      <div className="md:hidden flex items-center gap-1.5 px-2 py-2 bg-black/95 border-t border-border shrink-0" style={{touchAction:"manipulation"}}>
        {/* ◀ Move Left */}
        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold active:bg-primary/20 active:border-primary select-none flex items-center justify-center transition-colors"
          onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("left");}}
          onPointerUp={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("stop");}}
          onPointerLeave={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("stop");}}
          style={{touchAction:"none"}}
        >◀</button>

        {/* ⛏ DIG — hold to auto-target and continuously mine the nearest block in front.
            digHeldRef=true activates auto-target each frame in the game loop.
            Release (pointerup/leave) sets digHeldRef=false and stops mining. */}
        <button
          className="flex-1 h-14 rounded-xl bg-yellow-500/20 border-2 border-yellow-500/60 text-yellow-400 font-black text-lg active:bg-yellow-500 active:text-black select-none transition-colors"
          onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();digHeldRef.current=true;}}
          onPointerUp={e=>{if(!e.isPrimary)return;e.preventDefault();digHeldRef.current=false;stopMining();}}
          onPointerLeave={e=>{if(!e.isPrimary)return;e.preventDefault();digHeldRef.current=false;stopMining();}}
          style={{touchAction:"none"}}
        >⛏</button>

        {/* JUMP */}
        <button
          className="w-14 h-14 rounded-xl bg-primary/20 border-2 border-primary text-primary font-black text-xs uppercase active:bg-primary active:text-black select-none transition-colors"
          onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("jump");}}
          style={{touchAction:"none"}}
        >JUMP</button>

        {/* ▶ Move Right */}
        <button
          className="w-14 h-14 rounded-xl bg-black/70 border-2 border-border text-white text-2xl font-bold active:bg-primary/20 active:border-primary select-none flex items-center justify-center transition-colors"
          onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("right");}}
          onPointerUp={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("stop");}}
          onPointerLeave={e=>{if(!e.isPrimary)return;e.preventDefault();mobileMove("stop");}}
          style={{touchAction:"none"}}
        >▶</button>
      </div>

      {/* ── ANTI-BOT WIZARD ──────────────────────────────────────────────────── */}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader><DialogTitle className="text-destructive flex items-center tracking-widest uppercase text-sm"><TriangleAlert className="mr-2 w-4 h-4"/>Anti-Bot Verification</DialogTitle></DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground text-sm">High action rate detected. Solve to continue:</p>
            <p className="text-3xl font-black text-white">2 + 3 = ?</p>
            <Input value={wizardAns} onChange={e=>setWizardAns(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){if(wizardAns==="5"){setWizard(false);setWizardAns("");}else toast({title:"WRONG",variant:"destructive"});}}} className="text-center text-2xl font-bold text-primary border-primary/50 bg-black" placeholder="?"/>
          </div>
          <DialogFooter>
            <Button className="w-full bg-destructive hover:bg-destructive/80 font-bold uppercase tracking-widest" onClick={()=>{if(wizardAns==="5"){setWizard(false);setWizardAns("");toast({title:"VERIFIED ✓",className:"bg-black border-primary text-primary"});}else toast({title:"WRONG ANSWER",variant:"destructive"});}}>Submit Answer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
