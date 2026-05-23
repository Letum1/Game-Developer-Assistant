// ============================================================
// Game.tsx — MineVault 2D block world
//
// CONTROLS:
//   Mobile — Virtual joystick (left) for movement + ⛏ DIG (right) to mine
//            You can WALK and MINE simultaneously — they're fully independent.
//            Tap canvas to mine/plant/place a specific block.
//   Desktop — WASD / Arrow keys + click blocks
//
// CAMERA / ZOOM:
//   Camera follows player smoothly. +/- buttons on canvas change zoom (1×–3×).
//
// MINING:
//   Hold-to-mine: MINING_POWER × dt × pickaxe_multiplier per frame.
//   DIG button auto-targets the nearest block in front of player.
//   Walk while holding DIG and you'll continuously mine whatever is in reach.
//
// PICKAXES:
//   Wood (1×, free) → Stone (1.8×, craft) → Iron (2.8×) → Gold (4.5×) → Diamond (7×)
//   Equip from the hotbar below canvas.
//
// OAK TREES:
//   Select seed_oak from hotbar → plant mode → tap ground next to soil.
//   Sapling grows into oak_log after ~15 seconds. Break it for oak_wood + seed.
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
// ─────────────────────────────────────────────────────────────────────────────
const WW = 800;   // canvas logical width  (px)
const WH = 600;   // canvas logical height (px)
const BS = 40;    // one block = 40×40 world-pixels

// ─────────────────────────────────────────────────────────────────────────────
// ZOOM — default 2× makes each block 80px, easy to tap on mobile
// ─────────────────────────────────────────────────────────────────────────────
const ZOOM_DEFAULT = 2.0;
const ZOOM_MIN     = 1.0;
const ZOOM_MAX     = 3.0;
const ZOOM_STEP    = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
const GRAVITY    = 900;
const JUMP_VY    = -420;
const MOVE_SPEED = 175;
const PW = 26;  // player hitbox width
const PH = 36;  // player hitbox height

// ─────────────────────────────────────────────────────────────────────────────
// DAY/NIGHT — 8-minute cycle
// ─────────────────────────────────────────────────────────────────────────────
const DAY_MS = 480_000;

// ─────────────────────────────────────────────────────────────────────────────
// MINING
// BLOCK_HEALTH = seconds to break at 1.0 power (wood pickaxe speed).
// PICKAXE_POWER multiplies mining speed per equipped tool.
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_HEALTH: Record<string, number> = {
  block_grass:        0.8,
  block_dirt:         1.5,
  block_rock:         2.5,
  block_iron:         3.5,
  block_gold:         2.5,
  block_diamond:      5.0,
  block_lava:         4.0,
  block_oak_sapling:  0.2,  // one punch
  block_oak_log:      0.4,  // very fast to break (growtopia style)
  machine_core:       1.5,
  solar_panel_block:  1.5,
  data_cable:         0.8,
};

// Pickaxe power multipliers (match server game-constants.ts PICKAXE_POWER)
const PICKAXE_POWER: Record<string, number> = {
  pickaxe_wood:    1.0,
  pickaxe_stone:   1.8,
  pickaxe_iron:    2.8,
  pickaxe_gold:    4.5,
  pickaxe_diamond: 7.0,
};

const MINING_POWER = 1.0; // base hp/s, multiplied by pickaxe power
const TOUCH_OFFSET_PX = 55; // canvas pixels, shifts target above thumb
const REACH = 4.0; // block-units
const AUTO_SCAN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// BLOCK VISUALS
// ─────────────────────────────────────────────────────────────────────────────
const BLOCK_COLORS: Record<string, string> = {
  block_grass: "#15803d", block_dirt: "#78350f", block_rock: "#374151",
  block_iron:  "#6b7280", block_gold: "#b45309", block_diamond: "#0e7490",
  block_lava:  "#b91c1c", machine_core: "#1e1b4b",
  solar_panel_block: "#065f46", data_cable: "#7f1d1d",
  block_oak_sapling: "#166534", block_oak_log: "#92400e",
};
const BLOCK_TINTS: Record<string, string> = {
  block_grass: "rgba(74,222,128,0.25)",  block_dirt: "rgba(180,130,80,0.20)",
  block_rock:  "rgba(200,200,220,0.12)", block_iron: "rgba(210,220,230,0.20)",
  block_gold:  "rgba(255,220,50,0.35)",  block_diamond: "rgba(100,240,255,0.30)",
  block_lava:  "rgba(255,120,0,0.40)",   block_oak_log: "rgba(210,180,130,0.35)",
  block_oak_sapling: "rgba(100,220,100,0.40)",
};
const BLOCK_LABELS: Record<string, string> = {
  block_grass: "Grass", block_dirt: "Dirt", block_rock: "Rock",
  block_oak_log: "Oak Log", block_oak_sapling: "Sapling",
  machine_core: "Machine", solar_panel_block: "Solar ☀️", data_cable: "Cable",
};
const PLACEABLE_BLOCKS = new Set([
  "block_grass", "block_dirt", "block_rock",
  "block_oak_log", "machine_core", "solar_panel_block", "data_cable",
]);
const HOTBAR_PICKAXES = ["pickaxe_wood","pickaxe_stone","pickaxe_iron","pickaxe_gold","pickaxe_diamond"];
const PICKAXE_EMOJIS: Record<string,string> = {
  pickaxe_wood:"🪓",pickaxe_stone:"⛏️",pickaxe_iron:"🔩",pickaxe_gold:"✨",pickaxe_diamond:"💎"
};

// ─────────────────────────────────────────────────────────────────────────────
// SKY state computed from time
// ─────────────────────────────────────────────────────────────────────────────
type SkyState = { r:number; g:number; b:number; alpha:number; stars:boolean };
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
// MACHINE BLOCK PIXEL-ART RENDERER
// ─────────────────────────────────────────────────────────────────────────────
function drawMachineBlock(ctx:CanvasRenderingContext2D,blk:string,sx:number,sy:number,sz:number) {
  if (blk==="machine_core") {
    ctx.fillStyle="#312e81";ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const i=sz*0.2;ctx.fillStyle="rgba(167,139,250,0.8)";ctx.fillRect(sx+i,sy+i,sz-i*2,sz-i*2);
    ctx.strokeStyle="rgba(196,181,253,0.9)";ctx.lineWidth=1.5;ctx.strokeRect(sx+i,sy+i,sz-i*2,sz-i*2);
    const c=sz/2;ctx.strokeStyle="rgba(167,139,250,0.4)";ctx.lineWidth=1;
    [[sx+i/2,sy+c,sx+i,sy+c],[sx+sz-i,sy+c,sx+sz-i/2,sy+c],[sx+c,sy+i/2,sx+c,sy+i],[sx+c,sy+sz-i,sx+c,sy+sz-i/2]].forEach(([x1,y1,x2,y2])=>{ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();});
    ctx.strokeStyle="rgba(99,102,241,0.5)";ctx.lineWidth=1;ctx.strokeRect(sx+1,sy+1,sz-2,sz-2);
  } else if (blk==="solar_panel_block") {
    ctx.fillStyle="#064e3b";ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const m=sz*0.1,cell=(sz-m*2)/3;
    for(let cy=0;cy<3;cy++)for(let cx=0;cx<3;cx++){ctx.fillStyle=(cx+cy)%2===0?"#065f46":"#047857";ctx.fillRect(sx+m+cx*cell,sy+m+cy*cell,cell-1,cell-1);}
    ctx.strokeStyle="rgba(52,211,153,0.7)";ctx.lineWidth=1.5;ctx.strokeRect(sx+2,sy+2,sz-4,sz-4);
    ctx.fillStyle="rgba(250,204,21,0.9)";ctx.beginPath();ctx.arc(sx+sz/2,sy+sz/2,sz*0.08,0,Math.PI*2);ctx.fill();
  } else if (blk==="data_cable") {
    ctx.fillStyle="#450a0a";ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    const pw=sz*0.3,po=(sz-pw)/2;ctx.fillStyle="#dc2626";ctx.fillRect(sx+po,sy+2,pw,sz-4);
    ctx.fillStyle="#fca5a5";ctx.fillRect(sx+po+pw*0.3,sy+4,pw*0.3,sz-8);
    ctx.strokeStyle="rgba(239,68,68,0.5)";ctx.lineWidth=1;ctx.strokeRect(sx+2,sy+2,sz-4,sz-4);
  }
}

// Oak tree block renderer — sapling is a little green sprout, log is brown bark
function drawOakBlock(ctx:CanvasRenderingContext2D,blk:string,sx:number,sy:number,sz:number,now:number) {
  if (blk==="block_oak_log") {
    ctx.fillStyle="#92400e";ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
    // Bark rings
    const ringColor="rgba(120,60,10,0.6)";ctx.fillStyle=ringColor;
    ctx.fillRect(sx+sz*0.3,sy+2,sz*0.1,sz-4);ctx.fillRect(sx+sz*0.6,sy+2,sz*0.1,sz-4);
    // Top sheen
    ctx.fillStyle="rgba(210,180,120,0.25)";ctx.fillRect(sx+2,sy+2,sz-4,sz*0.15);
    ctx.strokeStyle="rgba(0,0,0,0.35)";ctx.lineWidth=1;ctx.strokeRect(sx+0.5,sy+0.5,sz-1,sz-1);
  } else {
    // Sapling — small green cross shape
    ctx.fillStyle="rgba(20,80,20,0)";ctx.fillRect(sx,sy,sz,sz); // transparent bg
    const sway=Math.sin(now/800)*0.5;
    ctx.fillStyle="#15803d";
    // Stem
    ctx.fillRect(sx+sz*0.44,sy+sz*0.5,sz*0.12,sz*0.5);
    // Leaves
    ctx.save();ctx.translate(sx+sz/2,sy+sz*0.4+sway);
    ctx.fillStyle="#22c55e";
    ctx.beginPath();ctx.ellipse(0,0,sz*0.3,sz*0.22,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#16a34a";
    ctx.beginPath();ctx.ellipse(-sz*0.12,-sz*0.05,sz*0.18,sz*0.14,Math.PI/6,0,Math.PI*2);ctx.fill();
    ctx.beginPath();ctx.ellipse(sz*0.12,-sz*0.05,sz*0.18,sz*0.14,-Math.PI/6,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MINING RETICLE — animated dashed border with crack stages and health bar
// ─────────────────────────────────────────────────────────────────────────────
function drawMiningReticle(
  ctx:CanvasRenderingContext2D,sx:number,sy:number,sz:number,
  health:number,maxHealth:number,now:number,label:string
) {
  const progress=1-health/maxHealth;
  ctx.fillStyle=`rgba(0,0,0,${progress*0.55})`;ctx.fillRect(sx+1,sy+1,sz-2,sz-2);
  if (progress>=0.15) {
    const stage=Math.min(4,Math.floor(progress*5));
    ctx.save();ctx.strokeStyle="rgba(0,0,0,0.9)";ctx.lineWidth=Math.max(1,sz*0.03);
    const p=(r:number)=>r*sz;
    if(stage>=1){ctx.beginPath();ctx.moveTo(sx+p(0.2),sy+p(0.15));ctx.lineTo(sx+p(0.45),sy+p(0.4));ctx.lineTo(sx+p(0.35),sy+p(0.55));ctx.stroke();}
    if(stage>=2){ctx.beginPath();ctx.moveTo(sx+p(0.75),sy+p(0.2));ctx.lineTo(sx+p(0.55),sy+p(0.5));ctx.lineTo(sx+p(0.7),sy+p(0.75));ctx.stroke();}
    if(stage>=3){ctx.beginPath();ctx.moveTo(sx+p(0.1),sy+p(0.7));ctx.lineTo(sx+p(0.4),sy+p(0.55));ctx.lineTo(sx+p(0.65),sy+p(0.85));ctx.stroke();}
    if(stage>=4){ctx.lineWidth=Math.max(1.5,sz*0.045);ctx.beginPath();ctx.moveTo(sx+p(0.05),sy+p(0.5));ctx.lineTo(sx+p(0.95),sy+p(0.45));ctx.stroke();ctx.beginPath();ctx.moveTo(sx+p(0.5),sy+p(0.05));ctx.lineTo(sx+p(0.45),sy+p(0.95));ctx.stroke();}
    ctx.restore();
  }
  const off=(now/80)%16;const color=progress>0.6?"#ef4444":progress>0.3?"#f59e0b":"#22c55e";
  ctx.save();ctx.strokeStyle=color;ctx.lineWidth=Math.max(2,sz*0.05);
  ctx.setLineDash([6,4]);ctx.lineDashOffset=-off;
  const pulse=Math.sin(now/150)*Math.max(1,sz*0.04);
  ctx.strokeRect(sx+2+pulse,sy+2+pulse,sz-4-pulse*2,sz-4-pulse*2);
  ctx.setLineDash([]);ctx.restore();
  const c=Math.max(4,sz*0.12);ctx.fillStyle=color;
  [[sx,sy],[sx+sz-c,sy],[sx,sy+sz-c],[sx+sz-c,sy+sz-c]].forEach(([rx,ry])=>ctx.fillRect(rx,ry,c,c));
  const barH=Math.max(4,sz*0.09),barY=sy-barH-3;
  ctx.fillStyle="rgba(0,0,0,0.75)";ctx.fillRect(sx,barY,sz,barH);
  const gr=Math.round(255*progress),gg=Math.round(255*(1-progress*0.7));
  ctx.fillStyle=`rgb(${gr},${gg},0)`;ctx.fillRect(sx,barY,sz*health/maxHealth,barH);
  ctx.strokeStyle="rgba(255,255,255,0.25)";ctx.lineWidth=0.5;ctx.strokeRect(sx,barY,sz,barH);
  const fs=Math.max(9,sz*0.22);ctx.font=`bold ${fs}px monospace`;ctx.fillStyle="rgba(255,255,255,0.95)";ctx.textAlign="center";ctx.fillText(label,sx+sz/2,barY-3);ctx.textAlign="left";
}

function drawPunchFlash(ctx:CanvasRenderingContext2D,sx:number,sy:number,sz:number,alpha:number) {
  ctx.fillStyle=`rgba(255,255,200,${alpha*0.45})`;ctx.fillRect(sx+2,sy+2,sz-4,sz-4);
}

// ============================================================
// MAIN GAME COMPONENT
// ============================================================
export default function Game() {
  const userId   = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ── Server queries ────────────────────────────────────────────────────────
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

  // ── Physics ───────────────────────────────────────────────────────────────
  const physRef = useRef({ px:5*BS, py:0, vx:0, vy:0, onGround:false, facingRight:true, spawned:false });

  // ── Camera: top-left of viewport in world-pixels ──────────────────────────
  const camRef  = useRef({ x:0, y:0 });
  // ── Zoom ──────────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(ZOOM_DEFAULT);
  const zoomRef = useRef(ZOOM_DEFAULT);
  useEffect(()=>{ zoomRef.current=zoom; },[zoom]);

  // ── World grid (local optimistic copy) ────────────────────────────────────
  const worldRef = useRef<string[][]|null>(null);
  const rafRef   = useRef(0);
  const lastTRef = useRef(0);
  const keysRef  = useRef<Set<string>>(new Set());

  // ── Mining state ──────────────────────────────────────────────────────────
  const miningRef = useRef<{active:boolean;bx:number;by:number;health:number;maxHealth:number;blockType:string}>
    ({active:false,bx:0,by:0,health:0,maxHealth:0,blockType:""});
  const pendingBreakRef = useRef(false);
  const flashRef = useRef<Map<string,number>>(new Map());

  // ── DIG button held ref (set by DIG pointer handlers, read by game loop) ──
  const digHeldRef = useRef(false);

  // ── Joystick: set vx directly in pointer handlers (no per-frame cost) ─────
  const joystickRef = useRef({ active:false, dx:0, dy:0 });
  const joystickDivRef = useRef<HTMLDivElement>(null);
  const [joystickThumb, setJoystickThumb] = useState({x:0,y:0});
  const JOYSTICK_R = 36; // max thumb travel in screen px

  // ── Pinch guard ───────────────────────────────────────────────────────────
  const isPinchingRef = useRef(false);

  // ── Pickaxe ───────────────────────────────────────────────────────────────
  const [equippedPickaxe, setEquippedPickaxe] = useState("pickaxe_wood");
  const pickaxeRef = useRef("pickaxe_wood");
  useEffect(()=>{ pickaxeRef.current=equippedPickaxe; },[equippedPickaxe]);

  // ── Mode: punch | place | plant ───────────────────────────────────────────
  const [mode,          setMode]          = useState<"punch"|"place"|"plant">("punch");
  const [selectedBlock, setSelectedBlock] = useState<string|null>(null);

  // ── Sapling growth timers: "bx,by" → timestamp planted ──────────────────
  const saplingTimers = useRef<Map<string,number>>(new Map());

  // ── UI state ──────────────────────────────────────────────────────────────
  const [wizard,    setWizard]    = useState(false);
  const [wizardAns, setWizardAns] = useState("");
  const [chatOpen,  setChatOpen]  = useState(false);
  const [chatMsgs,  setChatMsgs]  = useState<{username:string;message:string}[]>([]);
  const [chatInput, setChatInput] = useState("");
  const wsRef    = useRef<WebSocket|null>(null);
  const starsRef = useRef(Array.from({length:80},()=>({x:Math.random()*WW,y:Math.random()*WH*0.5,r:Math.random()*1.5+0.4,twinkle:Math.random()*Math.PI*2})));

  // ════════════════════════════════════════════════════════════════════════════
  // World data → local ref + spawn position
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    if (!world) return;
    worldRef.current=world.blockData;
    if (!physRef.current.spawned) {
      const bd=world.blockData;
      let sy=0;
      for (let y=0;y<bd.length;y++){if(bd[y][5]==="air"){sy=y;break;}}
      physRef.current.py=sy*BS;
      physRef.current.px=5*BS+(BS-PW)/2;
      physRef.current.spawned=true;
    }
  },[world]);

  // ════════════════════════════════════════════════════════════════════════════
  // WebSocket chat
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    const proto=location.protocol==="https:"?"wss:":"ws:";
    const ws=new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current=ws;
    ws.onmessage=(e)=>{try{const m=JSON.parse(e.data as string);setChatMsgs(prev=>[...prev.slice(-29),m]);}catch{}};
    return()=>ws.close();
  },[]);
  const sendChat=()=>{const ws=wsRef.current;if(!chatInput.trim()||!ws||ws.readyState!==WebSocket.OPEN)return;ws.send(JSON.stringify({username,message:chatInput.trim()}));setChatInput("");};

  // ════════════════════════════════════════════════════════════════════════════
  // Sapling growth timer — every second, check if any sapling is old enough to grow
  // ════════════════════════════════════════════════════════════════════════════
  useEffect(()=>{
    const interval=setInterval(()=>{
      const bd=worldRef.current; if (!bd) return;
      saplingTimers.current.forEach((plantedAt,key)=>{
        if (Date.now()-plantedAt<15000) return; // 15 seconds to grow
        const [bx,by]=key.split(",").map(Number);
        if (bd[by]?.[bx]!=="block_oak_sapling"){ saplingTimers.current.delete(key); return; }
        saplingTimers.current.delete(key);
        // Optimistic: convert sapling to log locally
        const updated=bd.map(r=>[...r]);
        updated[by][bx]="block_oak_log";
        if (by>0&&updated[by-1]?.[bx]==="air") updated[by-1][bx]="block_oak_log";
        worldRef.current=updated;
        // Confirm with server
        gameAction.mutate(
          {data:{actionType:"grow" as any,worldName:"start",x:bx,y:by}},
          {onSuccess:()=>refetchWorld()}
        );
      });
    },1000);
    return()=>clearInterval(interval);
  },[gameAction,refetchWorld]);

  // ════════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════════════════════════
  const solid=useCallback((bx:number,by:number):boolean=>{
    const bd=worldRef.current; if(!bd)return false;
    if(by<0)return false; if(by>=bd.length)return true;
    if(bx<0||bx>=bd[0].length)return true;
    return bd[by][bx]!=="air";
  },[]);

  // screenToBlock: canvas pointer → block grid cell, accounting for camera + zoom
  const screenToBlock=useCallback((clientX:number,clientY:number,applyOffset=false):{bx:number;by:number}|null=>{
    const canvas=canvasRef.current; if(!canvas)return null;
    const rect=canvas.getBoundingClientRect();
    // Convert browser coords → canvas logical pixels (WW×WH)
    const cx=(clientX-rect.left)/rect.width*WW;
    const cy=(clientY-rect.top)/rect.height*WH;
    const acy=applyOffset?cy-TOUCH_OFFSET_PX:cy;
    // Unzoom + camera → world-pixel → block
    const z=zoomRef.current,c=camRef.current;
    const bx=Math.floor((cx/z+c.x)/BS);
    const by=Math.floor((acy/z+c.y)/BS);
    const bd=worldRef.current;
    if(!bd||bx<0||by<0||bx>=bd[0].length||by>=bd.length)return null;
    return {bx,by};
  },[]);

  // findAutoTarget: nearest breakable block in front of player within REACH
  const findAutoTarget=useCallback((dir:"left"|"right"):{bx:number;by:number}|null=>{
    const bd=worldRef.current; if(!bd)return null;
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS,pcy=(p.py+PH/2)/BS;
    const topRow=Math.floor(p.py/BS),botRow=Math.floor((p.py+PH)/BS);
    let best:{bx:number;by:number;dist:number}|null=null;
    for(let step=1;step<=AUTO_SCAN;step++){
      const col=dir==="right"?Math.floor(pcx)+step:Math.ceil(pcx)-step;
      for(let row=topRow-1;row<=botRow+1;row++){
        if(row<0||row>=bd.length||col<0||col>=bd[0].length)continue;
        if(bd[row][col]==="air")continue;
        const dist=Math.sqrt((col-pcx)**2+(row-pcy)**2);
        if(dist>REACH)continue;
        if(!best||dist<best.dist)best={bx:col,by:row,dist};
      }
    }
    // Also check directly below
    const belowRow=botRow+1,belowCol=Math.round(pcx);
    if(belowRow>=0&&belowRow<bd.length&&belowCol>=0&&belowCol<bd[0].length&&bd[belowRow][belowCol]!=="air"){
      const dist=Math.sqrt((belowCol-pcx)**2+(belowRow-pcy)**2);
      if(dist<=REACH&&(!best||dist<best.dist))best={bx:belowCol,by:belowRow,dist};
    }
    return best?{bx:best.bx,by:best.by}:null;
  },[]);

  const startMining=useCallback((bx:number,by:number)=>{
    const bd=worldRef.current; if(!bd)return;
    const blk=bd[by]?.[bx]; if(!blk||blk==="air")return;
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS,pcy=(p.py+PH/2)/BS;
    if(Math.sqrt((bx-pcx)**2+(by-pcy)**2)>REACH)return;
    // Don't restart same block (preserves mining progress)
    if(miningRef.current.active&&miningRef.current.bx===bx&&miningRef.current.by===by)return;
    const maxH=BLOCK_HEALTH[blk]??2.0;
    miningRef.current={active:true,bx,by,health:maxH,maxHealth:maxH,blockType:blk};
    flashRef.current.set(`${bx},${by}`,1.0);
    physRef.current.facingRight=bx>=pcx;
  },[]);

  const stopMining=useCallback(()=>{ miningRef.current.active=false; },[]);

  const breakBlock=useCallback((bx:number,by:number)=>{
    const bd=worldRef.current; if(!bd||pendingBreakRef.current)return;
    pendingBreakRef.current=true;
    miningRef.current.active=false;
    const updated=bd.map(r=>[...r]); updated[by][bx]="air"; worldRef.current=updated;
    gameAction.mutate(
      {data:{actionType:"break",worldName:"start",x:bx,y:by}},
      {
        onSuccess:(data)=>{
          pendingBreakRef.current=false;
          if(data.wizardChallenge){setWizard(true);return;}
          if(data.success){
            if(data.dropItem) toast({title:`+1 ${data.dropItem.toUpperCase().replace(/_/g," ")}`,className:"border-primary bg-black text-primary font-mono uppercase text-xs"});
            refetchWorld();refetchInventory();
          }
        },
        onError:()=>{pendingBreakRef.current=false;worldRef.current=bd;},
      }
    );
  },[gameAction,refetchWorld,refetchInventory,toast]);

  const placeBlock=useCallback((bx:number,by:number)=>{
    if(!selectedBlock)return;
    const bd=worldRef.current;if(!bd||bd[by]?.[bx]!=="air"){toast({title:"BLOCKED",className:"bg-black border-yellow-500 text-yellow-400 font-mono text-xs"});return;}
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS,pcy=(p.py+PH/2)/BS;
    if(Math.sqrt((bx-pcx)**2+(by-pcy)**2)>REACH){toast({title:"OUT OF REACH",className:"bg-black border-border text-muted-foreground font-mono text-xs"});return;}
    const updated=bd.map(r=>[...r]);updated[by][bx]=selectedBlock;worldRef.current=updated;
    gameAction.mutate(
      {data:{actionType:"place",worldName:"start",x:bx,y:by,placeBlock:selectedBlock}},
      {
        onSuccess:(data)=>{
          if(data.success){
            if((data as any).machineUpdated)toast({title:"⚡ RIG UPDATED",className:"bg-black border-violet-500 text-violet-400 font-mono text-xs"});
            refetchWorld();refetchInventory();
          }else{worldRef.current=bd;}
        },
        onError:()=>{worldRef.current=bd;},
      }
    );
  },[selectedBlock,gameAction,refetchWorld,refetchInventory,toast]);

  // Plant oak seed at (bx, by) — must be air, block below must be solid
  const plantSeed=useCallback((bx:number,by:number)=>{
    const bd=worldRef.current;if(!bd)return;
    if(bd[by]?.[bx]!=="air"){toast({title:"CAN'T PLANT HERE",className:"bg-black border-yellow-500 text-yellow-400 font-mono text-xs"});return;}
    const below=bd[by+1]?.[bx];
    if(!below||below==="air"){toast({title:"PLANT ON GROUND",description:"Place on solid soil",className:"bg-black border-border text-muted-foreground font-mono text-xs"});return;}
    const p=physRef.current;
    const pcx=(p.px+PW/2)/BS,pcy=(p.py+PH/2)/BS;
    if(Math.sqrt((bx-pcx)**2+(by-pcy)**2)>REACH){toast({title:"OUT OF REACH",className:"bg-black border-border text-muted-foreground font-mono text-xs"});return;}
    // Optimistic update
    const updated=bd.map(r=>[...r]);updated[by][bx]="block_oak_sapling";worldRef.current=updated;
    const key=`${bx},${by}`;
    saplingTimers.current.set(key,Date.now());
    gameAction.mutate(
      {data:{actionType:"plant" as any,worldName:"start",x:bx,y:by}},
      {
        onSuccess:(data)=>{
          if((data as any).success===false){
            worldRef.current=bd;saplingTimers.current.delete(key);
            toast({title:"PLANT FAILED",description:(data as any).error,variant:"destructive"});
          }else{
            toast({title:"🌱 PLANTED",description:"Grows into oak log in ~15 seconds",className:"bg-black border-green-500 text-green-400 font-mono text-xs"});
            refetchInventory();
          }
        },
        onError:()=>{worldRef.current=bd;saplingTimers.current.delete(key);},
      }
    );
  },[gameAction,refetchInventory,refetchWorld,toast]);

  // ════════════════════════════════════════════════════════════════════════════
  // MAIN GAME LOOP — drawFrame(now)
  // ════════════════════════════════════════════════════════════════════════════
  const drawFrame=useCallback((now:number)=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext("2d");if(!ctx)return;
    const dt=Math.min((now-lastTRef.current)/1000,0.05);lastTRef.current=now;

    const p=physRef.current;
    const bd=worldRef.current;

    // ── MINING DAMAGE (only when actively holding canvas or DIG button) ──────
    // D-pad movement alone does NOT trigger this.
    if (miningRef.current.active) {
      const m=miningRef.current;
      if(!bd||bd[m.by]?.[m.bx]==="air"){miningRef.current.active=false;}
      else{
        const pcx=(p.px+PW/2)/BS,pcy=(p.py+PH/2)/BS;
        if(Math.sqrt((m.bx-pcx)**2+(m.by-pcy)**2)>REACH){
          // Out of reach — cancel (happens when walking AWAY from target)
          miningRef.current.active=false;
        }else{
          // Mining power = base × pickaxe multiplier
          const power=MINING_POWER*(PICKAXE_POWER[pickaxeRef.current]??1.0);
          m.health-=power*dt;
          flashRef.current.set(`${m.bx},${m.by}`,0.25);
          if(m.health<=0)breakBlock(m.bx,m.by);
        }
      }
    }

    // ── DIG BUTTON AUTO-TARGET ────────────────────────────────────────────────
    // DIG held + not already mining → find nearest block in facing direction.
    // This also runs while walking, enabling walk+mine simultaneously.
    if(digHeldRef.current&&!miningRef.current.active){
      const dir=p.facingRight?"right":"left";
      const target=findAutoTarget(dir);
      if(target)startMining(target.bx,target.by);
    }

    // ── PHYSICS ───────────────────────────────────────────────────────────────
    if(bd){
      const npx=p.px+p.vx*dt;
      const ty0=Math.floor((p.py+2)/BS),ty1=Math.floor((p.py+PH-2)/BS);
      if(p.vx>0){const tx=Math.floor((npx+PW)/BS);if(!solid(tx,ty0)&&!solid(tx,ty1))p.px=npx;else p.px=tx*BS-PW;}
      else if(p.vx<0){const tx=Math.floor(npx/BS);if(!solid(tx,ty0)&&!solid(tx,ty1))p.px=npx;else p.px=(tx+1)*BS;}
      p.px=Math.max(0,Math.min(bd[0].length*BS-PW,p.px));
      p.vy=Math.min(p.vy+GRAVITY*dt,850);
      const npy=p.py+p.vy*dt;
      const tx0=Math.floor((p.px+2)/BS),tx1=Math.floor((p.px+PW-2)/BS);
      p.onGround=false;
      if(p.vy>=0){const ty=Math.floor((npy+PH)/BS);if(solid(tx0,ty)||solid(tx1,ty)){p.py=ty*BS-PH;p.vy=0;p.onGround=true;}else p.py=npy;}
      else{const ty=Math.floor(npy/BS);if(solid(tx0,ty)||solid(tx1,ty)){p.py=(ty+1)*BS;p.vy=0;}else p.py=npy;}
      p.py=Math.max(0,Math.min(bd.length*BS-PH,p.py));
    }

    // ── CAMERA follows player ─────────────────────────────────────────────────
    const z=zoomRef.current;
    const viewW=WW/z,viewH=WH/z;
    const worldW=bd?bd[0].length:20,worldH=bd?bd.length:15;
    const camX=Math.max(0,Math.min(worldW*BS-viewW,p.px+PW/2-viewW/2));
    const camY=Math.max(0,Math.min(worldH*BS-viewH,p.py+PH/2-viewH/2));
    camRef.current.x+=(camX-camRef.current.x)*0.15;
    camRef.current.y+=(camY-camRef.current.y)*0.15;
    const cx=camRef.current.x,cy=camRef.current.y;

    // ── SKY ───────────────────────────────────────────────────────────────────
    ctx.clearRect(0,0,WW,WH);
    const sky=getSky(now);
    const grad=ctx.createLinearGradient(0,0,0,WH);
    if(sky.alpha>0.35){grad.addColorStop(0,`rgb(${sky.r},${sky.g},${sky.b})`);grad.addColorStop(1,"#0a0010");}
    else{grad.addColorStop(0,"#1a3a5c");grad.addColorStop(0.5,"#0f2035");grad.addColorStop(1,"#050d14");}
    ctx.fillStyle=grad;ctx.fillRect(0,0,WW,WH);

    // Stars
    if(sky.stars&&sky.alpha>0.1){
      const sa=Math.min(1,(sky.alpha-0.1)*2);
      starsRef.current.forEach(s=>{const tw=0.7+0.3*Math.sin(now/800+s.twinkle);ctx.fillStyle=`rgba(255,255,255,${sa*tw})`;ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);ctx.fill();});
    }

    // Sun/moon
    const t=(now%DAY_MS)/DAY_MS;
    if(sky.alpha<0.4){const a=t*Math.PI*2-Math.PI/2,sx2=WW/2+Math.cos(a)*320,sy2=WH*0.5+Math.sin(a)*280;if(sy2<WH*0.55){const sg=ctx.createRadialGradient(sx2,sy2,0,sx2,sy2,28);sg.addColorStop(0,"rgba(255,240,100,1)");sg.addColorStop(0.5,"rgba(255,180,0,0.8)");sg.addColorStop(1,"rgba(255,140,0,0)");ctx.fillStyle=sg;ctx.beginPath();ctx.arc(sx2,sy2,28,0,Math.PI*2);ctx.fill();}}
    else if(sky.alpha>0.5){const a=(t+0.5)*Math.PI*2-Math.PI/2,mx=WW/2+Math.cos(a)*320,my=WH*0.5+Math.sin(a)*280;if(my<WH*0.55){ctx.fillStyle="rgba(220,230,255,0.9)";ctx.beginPath();ctx.arc(mx,my,16,0,Math.PI*2);ctx.fill();ctx.fillStyle="rgba(10,0,30,0.85)";ctx.beginPath();ctx.arc(mx+6,my-4,13,0,Math.PI*2);ctx.fill();}}

    // ── BLOCKS (camera + zoom applied) ────────────────────────────────────────
    const sz=BS*z;
    if(bd){
      const startCol=Math.max(0,Math.floor(cx/BS));
      const endCol=Math.min(bd[0].length-1,Math.ceil((cx+viewW)/BS));
      const startRow=Math.max(0,Math.floor(cy/BS));
      const endRow=Math.min(bd.length-1,Math.ceil((cy+viewH)/BS));

      for(let row=startRow;row<=endRow;row++){
        for(let col=startCol;col<=endCol;col++){
          const blk=bd[row][col]; if(blk==="air")continue;
          const bsx=(col*BS-cx)*z,bsy=(row*BS-cy)*z;
          if(blk==="machine_core"||blk==="solar_panel_block"||blk==="data_cable"){
            drawMachineBlock(ctx,blk,bsx,bsy,sz);
          }else if(blk==="block_oak_log"||blk==="block_oak_sapling"){
            drawOakBlock(ctx,blk,bsx,bsy,sz,now);
          }else{
            ctx.fillStyle=BLOCK_COLORS[blk]??"#1e293b";ctx.fillRect(bsx,bsy,sz,sz);
            ctx.fillStyle=BLOCK_TINTS[blk]??"rgba(255,255,255,0.07)";ctx.fillRect(bsx+1,bsy+1,sz-2,Math.max(3,sz*0.12));
            ctx.strokeStyle="rgba(0,0,0,0.4)";ctx.lineWidth=1;ctx.strokeRect(bsx+0.5,bsy+0.5,sz-1,sz-1);
          }
        }
      }

      // Mining reticle
      const m=miningRef.current;
      if(m.active&&bd[m.by]?.[m.bx]!=="air"){
        const rsx=(m.bx*BS-cx)*z,rsy=(m.by*BS-cy)*z;
        const label=BLOCK_LABELS[m.blockType]??m.blockType.replace("block_","").toUpperCase();
        drawMiningReticle(ctx,rsx,rsy,sz,m.health,m.maxHealth,now,label);
      }

      // Punch flash
      flashRef.current.forEach((alpha,key)=>{
        const [bxStr,byStr]=key.split(",");
        const bx2=parseInt(bxStr),by2=parseInt(byStr);
        drawPunchFlash(ctx,(bx2*BS-cx)*z,(by2*BS-cy)*z,sz,alpha);
        const na=alpha-0.15;if(na<=0)flashRef.current.delete(key);else flashRef.current.set(key,na);
      });
    }

    // ── PLAYER ────────────────────────────────────────────────────────────────
    const {px,py,facingRight:fr}=p;
    const psx=(px-cx)*z,psy=(py-cy)*z,pw2=PW*z,ph2=PH*z;
    ctx.fillStyle="#1e4d2b";ctx.fillRect(psx+pw2*0.19,psy+ph2*0.39,pw2*0.62,ph2*0.61);
    ctx.fillStyle="#fbbf24";ctx.fillRect(psx+pw2*0.11,psy+ph2*0.06,pw2*0.78,ph2*0.39);
    ctx.fillStyle="#000";ctx.fillRect(fr?psx+pw2*0.5:psx+pw2*0.19,psy+ph2*0.19,pw2*0.15,ph2*0.11);
    ctx.fillStyle="#22c55e";ctx.fillRect(fr?psx+pw2*0.54:psx+pw2*0.23,psy+ph2*0.22,pw2*0.08,ph2*0.06);

    // Tool in hand
    if(mode==="place"&&selectedBlock){
      const tx=fr?psx+pw2+2:psx-pw2*0.25,ty=psy+ph2*0.39;
      ctx.fillStyle=BLOCK_COLORS[selectedBlock]??"#aaa";ctx.fillRect(tx,ty,pw2*0.25,pw2*0.25);
      ctx.strokeStyle="#fff";ctx.lineWidth=1;ctx.strokeRect(tx,ty,pw2*0.25,pw2*0.25);
    }else if(mode==="plant"){
      const tx=fr?psx+pw2+2:psx-pw2*0.22,ty=psy+ph2*0.4;
      ctx.fillStyle="#22c55e";ctx.beginPath();ctx.arc(tx+pw2*0.1,ty+pw2*0.1,pw2*0.12,0,Math.PI*2);ctx.fill();
    }else{
      ctx.fillStyle="#9ca3af";ctx.fillRect(fr?psx+pw2+1:psx-pw2*0.19,psy+ph2*0.44,pw2*0.15,ph2*0.39);
      ctx.fillStyle="#6b7280";ctx.fillRect(fr?psx+pw2:psx-pw2*0.23,psy+ph2*0.36,pw2*0.23,pw2*0.23);
    }

    // Reach ring while mining
    const m2=miningRef.current;
    if(m2.active){
      ctx.save();ctx.strokeStyle=`rgba(255,200,0,${0.2+0.15*Math.sin(now/120)})`;ctx.lineWidth=1.5;
      ctx.beginPath();ctx.arc(psx+pw2/2,psy+ph2/2,REACH*BS*z,0,Math.PI*2);ctx.stroke();ctx.restore();
    }

    // Night overlay + scanlines
    if(sky.alpha>0){ctx.fillStyle=`rgba(0,0,20,${sky.alpha*0.45})`;ctx.fillRect(0,0,WW,WH);}
    ctx.fillStyle="rgba(0,0,0,0.035)";for(let scanY=0;scanY<WH;scanY+=4)ctx.fillRect(0,scanY,WW,2);

    rafRef.current=requestAnimationFrame(drawFrame);
  },[solid,mode,selectedBlock,findAutoTarget,startMining,breakBlock]);

  useEffect(()=>{lastTRef.current=performance.now();rafRef.current=requestAnimationFrame(drawFrame);return()=>cancelAnimationFrame(rafRef.current);},[drawFrame]);

  // ── Keyboard controls ────────────────────────────────────────────────────
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      keysRef.current.add(e.key);const p=physRef.current;
      if(["ArrowLeft","a","A"].includes(e.key)){p.vx=-MOVE_SPEED;p.facingRight=false;}
      if(["ArrowRight","d","D"].includes(e.key)){p.vx=MOVE_SPEED;p.facingRight=true;}
      if([" ","ArrowUp","w","W"].includes(e.key)&&p.onGround){p.vy=JUMP_VY;p.onGround=false;e.preventDefault();}
    };
    const up=(e:KeyboardEvent)=>{
      keysRef.current.delete(e.key);const keys=keysRef.current;
      const goL=keys.has("ArrowLeft")||keys.has("a")||keys.has("A");
      const goR=keys.has("ArrowRight")||keys.has("d")||keys.has("D");
      if(!goL&&!goR)physRef.current.vx=0;
      else if(goL){physRef.current.vx=-MOVE_SPEED;physRef.current.facingRight=false;}
      else{physRef.current.vx=MOVE_SPEED;physRef.current.facingRight=true;}
    };
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);
    return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);};
  },[]);

  // ── Canvas touch handlers ─────────────────────────────────────────────────
  const handleTouchStart=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    if(e.touches.length>1||isPinchingRef.current)return;
    e.preventDefault();
    const touch=e.touches[0];
    if(mode==="place"){const t=screenToBlock(touch.clientX,touch.clientY,false);if(t)placeBlock(t.bx,t.by);}
    else if(mode==="plant"){const t=screenToBlock(touch.clientX,touch.clientY,false);if(t)plantSeed(t.bx,t.by);}
    else{const t=screenToBlock(touch.clientX,touch.clientY,true);if(t)startMining(t.bx,t.by);}
  },[mode,screenToBlock,startMining,placeBlock,plantSeed]);

  const handleTouchMove=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    if(e.touches.length>1||isPinchingRef.current||mode!=="punch")return;
    e.preventDefault();
    const touch=e.touches[0];const t=screenToBlock(touch.clientX,touch.clientY,true);
    if(!t)return;if(t.bx!==miningRef.current.bx||t.by!==miningRef.current.by)startMining(t.bx,t.by);
  },[mode,screenToBlock,startMining]);

  const handleTouchEnd=useCallback((e:React.TouchEvent<HTMLCanvasElement>)=>{
    e.preventDefault();if(e.touches.length===0)stopMining();
  },[stopMining]);

  const handleCanvasClick=useCallback((e:React.MouseEvent<HTMLCanvasElement>)=>{
    const t=screenToBlock(e.clientX,e.clientY,false);if(!t)return;
    if(mode==="place")placeBlock(t.bx,t.by);
    else if(mode==="plant")plantSeed(t.bx,t.by);
    else{startMining(t.bx,t.by);setTimeout(()=>{miningRef.current.health=0;},60);}
  },[mode,screenToBlock,placeBlock,plantSeed,startMining]);

  useEffect(()=>{miningRef.current.active=false;},[world]);

  // ── Pinch detection (two fingers = no D-pad / canvas actions) ─────────────
  useEffect(()=>{
    const onStart=(e:TouchEvent)=>{if(e.touches.length>=2){isPinchingRef.current=true;physRef.current.vx=0;stopMining();}};
    const onEnd=(e:TouchEvent)=>{if(e.touches.length<2)isPinchingRef.current=false;};
    window.addEventListener("touchstart",onStart,{passive:true});
    window.addEventListener("touchend",onEnd,{passive:true});
    window.addEventListener("touchcancel",onEnd,{passive:true});
    return()=>{window.removeEventListener("touchstart",onStart);window.removeEventListener("touchend",onEnd);window.removeEventListener("touchcancel",onEnd);};
  },[stopMining]);

  // ══════════════════════════════════════════════════════════════════════════
  // VIRTUAL JOYSTICK handlers
  // Joystick sets physRef.current.vx directly (same as old D-pad buttons).
  // This means the game loop handles physics naturally with no extra code.
  // DIG button is completely independent — both can be active at once.
  // ══════════════════════════════════════════════════════════════════════════
  const handleJoystickDown=useCallback((e:React.PointerEvent)=>{
    if(!e.isPrimary||isPinchingRef.current)return;
    e.preventDefault();
    joystickRef.current.active=true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  },[]);

  const handleJoystickMove=useCallback((e:React.PointerEvent)=>{
    if(!e.isPrimary||!joystickRef.current.active)return;
    e.preventDefault();
    const div=joystickDivRef.current;if(!div)return;
    const rect=div.getBoundingClientRect();
    const cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
    const dx=e.clientX-cx,dy=e.clientY-cy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    const clamped=Math.min(dist,JOYSTICK_R);
    const angle=Math.atan2(dy,dx);
    const thumbX=Math.cos(angle)*clamped,thumbY=Math.sin(angle)*clamped;
    setJoystickThumb({x:thumbX,y:thumbY});

    // Normalized direction (-1 to 1)
    const ndx=dx/JOYSTICK_R;
    const p=physRef.current;
    if(ndx>0.25){p.vx=MOVE_SPEED;p.facingRight=true;}
    else if(ndx<-0.25){p.vx=-MOVE_SPEED;p.facingRight=false;}
    else{p.vx=0;}

    // Up flick = jump
    const ndy=dy/JOYSTICK_R;
    if(ndy<-0.7&&p.onGround){p.vy=JUMP_VY;p.onGround=false;}
  },[]);

  const handleJoystickUp=useCallback((e:React.PointerEvent)=>{
    if(!e.isPrimary)return;
    e.preventDefault();
    joystickRef.current.active=false;
    setJoystickThumb({x:0,y:0});
    // Only stop movement if keyboard isn't also controlling
    if(!keysRef.current.size)physRef.current.vx=0;
  },[]);

  // ── Hotbar computed items ─────────────────────────────────────────────────
  // Pickaxes (tap = equip), seeds (tap = plant mode), placeables (tap = place mode)
  const hotbarItems = [
    // Owned pickaxes
    ...HOTBAR_PICKAXES
      .filter(pk=>inventory.some(i=>i.itemId===pk&&i.quantity>0))
      .map(pk=>({itemId:pk,kind:"pickaxe" as const,qty:inventory.find(i=>i.itemId===pk)?.quantity??0})),
    // Seeds
    ...inventory.filter(i=>i.itemId==="seed_oak"&&i.quantity>0)
      .map(i=>({itemId:i.itemId,kind:"seed" as const,qty:i.quantity})),
    // Placeable blocks
    ...inventory.filter(i=>PLACEABLE_BLOCKS.has(i.itemId)&&i.quantity>0)
      .map(i=>({itemId:i.itemId,kind:"block" as const,qty:i.quantity})),
  ];

  const selectedHotbarItem = mode==="punch"?equippedPickaxe:(mode==="plant"?"seed_oak":selectedBlock);

  const selectHotbarItem=(itemId:string,kind:"pickaxe"|"seed"|"block")=>{
    stopMining();
    if(kind==="pickaxe"){setEquippedPickaxe(itemId);setMode("punch");setSelectedBlock(null);}
    else if(kind==="seed"){setMode("plant");setSelectedBlock(null);}
    else{setMode("place");setSelectedBlock(itemId);}
  };

  const modeLabel=mode==="punch"
    ? `⛏ MINE (${equippedPickaxe.replace("pickaxe_","").toUpperCase()} ${PICKAXE_POWER[equippedPickaxe]??1}×)`
    : mode==="plant"?"🌱 PLANT SEED (tap soil)"
    :`🧱 PLACE: ${selectedBlock?.replace("block_","").toUpperCase()??""} `;

  // ════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════════════════════
  return (
    <motion.div initial={{opacity:0}} animate={{opacity:1}} className="flex flex-col h-full bg-background overflow-hidden select-none">

      {/* ── TOP HUD ──────────────────────────────────────────────────────── */}
      <div className="flex justify-between items-center px-2 py-1.5 bg-black/95 border-b border-border z-10 shrink-0 gap-2 flex-wrap">
        <div className="bg-black/60 px-2 py-1 rounded border border-primary/20 font-mono">
          <span className="text-muted-foreground uppercase block leading-none text-[9px]">Player</span>
          <span className="text-white font-bold text-xs">{username}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <div className="bg-black/60 px-2 py-1 rounded border border-accent/30 text-[10px] font-mono">
            <div className="flex items-center text-accent font-bold"><Zap className="w-3 h-3 mr-0.5"/>{wallet?.actionCount??0}/100</div>
          </div>
          <div className="bg-black/60 px-2 py-1 rounded border border-primary/30 text-[10px] font-mono">
            <span className="text-primary font-bold">{wallet?.gems??0} 💎</span>
          </div>
          <button onClick={()=>setChatOpen(s=>!s)} className={`p-1.5 rounded border transition-colors ${chatOpen?"border-primary text-primary bg-primary/10":"border-border text-muted-foreground hover:text-primary"}`}><MessageSquare className="w-4 h-4"/></button>
        </div>
      </div>

      {/* ── CANVAS + CHAT ─────────────────────────────────────────────────── */}
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
            style={{imageRendering:"pixelated",cursor:mode==="place"||mode==="plant"?"cell":"crosshair",touchAction:"none"}}
          />

          {/* Mode label */}
          <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase pointer-events-none ${mode==="place"?"bg-blue-600/80":mode==="plant"?"bg-green-700/80":"bg-red-600/80"} text-white`}>
            {modeLabel}
          </div>

          {/* Zoom buttons */}
          <div className="absolute top-2 right-2 flex flex-col gap-1">
            <button onClick={()=>setZoom(z=>Math.min(ZOOM_MAX,+(z+ZOOM_STEP).toFixed(1)))}
              className="w-8 h-8 rounded bg-black/70 border border-border text-white font-bold text-lg flex items-center justify-center hover:bg-primary/20 hover:border-primary">+</button>
            <div className="text-center text-[9px] font-mono text-muted-foreground bg-black/60 rounded px-1">{zoom}×</div>
            <button onClick={()=>setZoom(z=>Math.max(ZOOM_MIN,+(z-ZOOM_STEP).toFixed(1)))}
              className="w-8 h-8 rounded bg-black/70 border border-border text-white font-bold text-xl flex items-center justify-center hover:bg-primary/20 hover:border-primary">−</button>
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
              {chatMsgs.length===0&&<p className="text-muted-foreground italic text-[10px]">No messages yet</p>}
              {chatMsgs.map((m,i)=><div key={i} className="break-words leading-tight"><span className="text-primary font-bold">{m.username}: </span><span className="text-gray-300">{m.message}</span></div>)}
            </div>
            <div className="flex gap-1 p-2 border-t border-border">
              <Input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&sendChat()} placeholder="Say something..." className="h-6 text-[10px] bg-black/50 border-border px-2 py-0"/>
              <button onClick={sendChat} className="text-primary shrink-0"><SendHorizonal className="w-3 h-3"/></button>
            </div>
          </div>
        )}
      </div>

      {/* ── IN-GAME HOTBAR ─────────────────────────────────────────────────────
          Shows all usable items: pickaxes (tap=equip), seeds (tap=plant mode),
          blocks (tap=place mode). Highlighted item = currently active. */}
      <div className="flex items-center gap-1 px-2 py-1.5 bg-black/90 border-t border-border shrink-0 overflow-x-auto">
        <span className="text-muted-foreground text-[9px] uppercase font-mono tracking-wider whitespace-nowrap shrink-0 mr-1">Hotbar:</span>
        {hotbarItems.length===0&&(
          <span className="text-muted-foreground text-[9px] font-mono italic">Mine blocks to fill your inventory</span>
        )}
        {hotbarItems.map(item=>{
          const isActive=selectedHotbarItem===item.itemId;
          const borderColor=item.kind==="pickaxe"?"border-orange-500":item.kind==="seed"?"border-green-500":"border-blue-500";
          const label=item.kind==="pickaxe"?item.itemId.replace("pickaxe_",""):item.itemId.replace("block_","").replace("seed_","🌱");
          const emoji=item.kind==="pickaxe"?(PICKAXE_EMOJIS[item.itemId]??"⛏"):item.kind==="seed"?"🌱":"";
          const power=item.kind==="pickaxe"?` ${PICKAXE_POWER[item.itemId]??1}×`:"";
          return(
            <button key={item.itemId}
              onClick={()=>selectHotbarItem(item.itemId,item.kind)}
              className={`flex flex-col items-center px-2 py-1 rounded border text-[9px] font-mono transition-all shrink-0 min-w-[44px] ${isActive?`${borderColor} bg-white/10 text-white shadow-lg`:"border-border bg-black/50 text-muted-foreground hover:border-white/30 hover:text-white"}`}>
              {item.kind==="block"&&(
                <span className="w-5 h-5 rounded-sm mb-0.5 border border-black/40 block" style={{backgroundColor:BLOCK_COLORS[item.itemId]??"#888"}}/>
              )}
              {item.kind!=="block"&&<span className="text-base leading-none mb-0.5">{emoji}</span>}
              <span className="uppercase leading-none">{label}{power}</span>
              <span className={`font-bold ${isActive?"text-white":item.kind==="pickaxe"?"text-orange-400":item.kind==="seed"?"text-green-400":"text-blue-400"}`}>×{item.qty}</span>
            </button>
          );
        })}
        {(mode==="place"||mode==="plant")&&(
          <button onClick={()=>{setMode("punch");setSelectedBlock(null);stopMining();}} className="ml-auto shrink-0 text-[10px] font-mono text-red-400 border border-red-400/40 px-2 py-1 rounded hover:bg-red-400/10">✕</button>
        )}
      </div>

      {/* ── MOBILE CONTROLS ────────────────────────────────────────────────────
          Left: virtual joystick — drag to move, flick up to jump.
          Right: ⛏ DIG button — hold to auto-mine while walking.
          Both are independent: hold DIG + drag joystick = walk and mine. */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-black/95 border-t border-border shrink-0" style={{touchAction:"manipulation"}}>

        {/* ── JOYSTICK (left) ─────────────────────────────────────────────────
            Outer circle is fixed. Thumb follows finger within JOYSTICK_R radius.
            Horizontal drag → player walks. Up flick → jump. */}
        <div className="flex flex-col items-center gap-1">
          <div
            ref={joystickDivRef}
            className="relative w-20 h-20 rounded-full bg-white/5 border-2 border-gray-600 flex items-center justify-center"
            onPointerDown={handleJoystickDown}
            onPointerMove={handleJoystickMove}
            onPointerUp={handleJoystickUp}
            onPointerCancel={handleJoystickUp}
            style={{touchAction:"none"}}
          >
            {/* Thumb indicator */}
            <div
              className="absolute w-10 h-10 rounded-full bg-gray-400/50 border-2 border-gray-300/70 pointer-events-none"
              style={{transform:`translate(${joystickThumb.x}px,${joystickThumb.y}px)`,transition:joystickRef.current.active?"none":"transform 0.12s ease"}}
            />
            {/* Center dot */}
            <div className="w-2 h-2 rounded-full bg-gray-500/60 pointer-events-none"/>
          </div>
          <span className="text-[9px] text-gray-500 font-mono uppercase tracking-wider">Move</span>
        </div>

        {/* ── JUMP button (center) ─────────────────────────────────────────── */}
        <button
          className="w-14 h-14 rounded-full bg-primary/20 border-2 border-primary text-primary font-black text-[11px] uppercase active:bg-primary active:text-black select-none transition-colors"
          onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();const p=physRef.current;if(p.onGround){p.vy=JUMP_VY;p.onGround=false;}}}
          style={{touchAction:"none"}}
        >JUMP</button>

        {/* ── DIG button (right) ──────────────────────────────────────────────
            Hold = auto-mine block in front of player. Works while walking.
            Uses digHeldRef so the game loop independently handles mining
            each frame regardless of player velocity. */}
        <div className="flex flex-col items-center gap-1">
          <button
            className="w-20 h-20 rounded-full bg-yellow-500/15 border-2 border-yellow-500/60 text-yellow-400 font-black text-3xl active:bg-yellow-500/40 active:border-yellow-400 select-none transition-colors flex items-center justify-center"
            onPointerDown={e=>{if(!e.isPrimary)return;e.preventDefault();digHeldRef.current=true;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);}}
            onPointerUp={e=>{if(!e.isPrimary)return;e.preventDefault();digHeldRef.current=false;stopMining();}}
            onPointerCancel={e=>{digHeldRef.current=false;stopMining();}}
            style={{touchAction:"none"}}
          >⛏</button>
          <span className="text-[9px] text-yellow-600 font-mono uppercase tracking-wider">Dig</span>
        </div>
      </div>

      {/* ── ANTI-BOT WIZARD ───────────────────────────────────────────────── */}
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
