import { useEffect, useRef, useState, useCallback } from "react";
import { useGetWorld, useGameAction, useGetWallet, getGetWorldQueryKey, getGetWalletQueryKey } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert, Pickaxe, Wrench, MessageSquare, SendHorizonal } from "lucide-react";

const BS = 40; // block size px
const GRAVITY = 900;
const JUMP_VY = -410;
const MOVE_SPEED = 170;
const PW = 26; // player width
const PH = 36; // player height
const WW = 800; // world width px
const WH = 600; // world height px
const DAY_MS = 480_000; // 8-min full cycle

const BLOCK_COLORS: Record<string, string> = {
  block_grass:   "#15803d",
  block_dirt:    "#78350f",
  block_rock:    "#374151",
  block_iron:    "#6b7280",
  block_gold:    "#b45309",
  block_diamond: "#0e7490",
  block_lava:    "#b91c1c",
};

type SkyState = { r: number; g: number; b: number; alpha: number; stars: boolean };

function getSky(now: number): SkyState {
  const t = (now % DAY_MS) / DAY_MS;
  if (t < 0.12) {
    const f = t / 0.12;
    return { r: 255, g: Math.round(80 * f), b: 0, alpha: 0.70 - 0.60 * f, stars: f < 0.6 };
  } else if (t < 0.22) {
    const f = (t - 0.12) / 0.10;
    return { r: 255, g: Math.round(80 + 140 * f), b: Math.round(160 * f), alpha: 0.10 - 0.10 * f, stars: false };
  } else if (t < 0.55) {
    return { r: 135, g: 206, b: 235, alpha: 0, stars: false };
  } else if (t < 0.68) {
    const f = (t - 0.55) / 0.13;
    return { r: 255, g: Math.round(200 - 120 * f), b: Math.round(50 - 50 * f), alpha: 0.12 * f, stars: false };
  } else if (t < 0.78) {
    const f = (t - 0.68) / 0.10;
    return { r: 255, g: Math.round(80 - 80 * f), b: 0, alpha: 0.12 + 0.58 * f, stars: f > 0.5 };
  }
  return { r: 0, g: 0, b: 20, alpha: 0.70, stars: true };
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

export default function Game() {
  const userId = localStorage.getItem("userId");
  const username = localStorage.getItem("username") ?? "Player";
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const { data: world, refetch: refetchWorld } = useGetWorld("start", {
    query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") },
  });
  const { data: wallet } = useGetWallet({
    query: { enabled: !!userId, queryKey: getGetWalletQueryKey() },
  });
  const gameAction = useGameAction();
  const { toast } = useToast();

  const physRef = useRef({ px: 5 * BS, py: 0, vx: 0, vy: 0, onGround: false, facingRight: true, spawned: false });
  const keysRef = useRef<Set<string>>(new Set());
  const worldRef = useRef<string[][] | null>(null);
  const rafRef = useRef(0);
  const lastTRef = useRef(0);

  const [tool, setTool] = useState<"pickaxe" | "wrench">("pickaxe");
  const [wizard, setWizard] = useState(false);
  const [wizardAns, setWizardAns] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState<{ username: string; message: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  const starsRef = useRef(
    Array.from({ length: 90 }, () => ({
      x: Math.random() * WW,
      y: Math.random() * WH * 0.55,
      r: Math.random() * 1.5 + 0.4,
      twinkle: Math.random() * Math.PI * 2,
    }))
  );

  useEffect(() => {
    if (!world) return;
    worldRef.current = world.blockData;
    if (!physRef.current.spawned) {
      const bd = world.blockData;
      let sy = 0;
      for (let y = 0; y < bd.length; y++) {
        if (bd[y][5] === "air") { sy = y; break; }
      }
      physRef.current.py = sy * BS;
      physRef.current.px = 5 * BS + (BS - PW) / 2;
      physRef.current.spawned = true;
    }
  }, [world]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/chat`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string) as { username: string; message: string };
        setChatMsgs((prev) => [...prev.slice(-29), m]);
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  const sendChat = () => {
    const ws = wsRef.current;
    if (!chatInput.trim() || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ username, message: chatInput.trim() }));
    setChatInput("");
  };

  const solid = useCallback((bx: number, by: number): boolean => {
    const bd = worldRef.current;
    if (!bd) return false;
    if (by < 0) return false;
    if (by >= bd.length) return true;
    if (bx < 0 || bx >= bd[0].length) return true;
    return bd[by][bx] !== "air";
  }, []);

  const drawFrame = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dt = Math.min((now - lastTRef.current) / 1000, 0.05);
    lastTRef.current = now;
    const p = physRef.current;
    const bd = worldRef.current;

    if (bd) {
      // Horizontal
      const npx = p.px + p.vx * dt;
      const ty0 = Math.floor((p.py + 2) / BS);
      const ty1 = Math.floor((p.py + PH - 2) / BS);
      if (p.vx > 0) {
        const tx = Math.floor((npx + PW) / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = tx * BS - PW;
      } else if (p.vx < 0) {
        const tx = Math.floor(npx / BS);
        if (!solid(tx, ty0) && !solid(tx, ty1)) p.px = npx;
        else p.px = (tx + 1) * BS;
      }
      p.px = Math.max(0, Math.min(bd[0].length * BS - PW, p.px));

      // Gravity + vertical
      p.vy = Math.min(p.vy + GRAVITY * dt, 850);
      const npy = p.py + p.vy * dt;
      const tx0 = Math.floor((p.px + 2) / BS);
      const tx1 = Math.floor((p.px + PW - 2) / BS);
      p.onGround = false;
      if (p.vy >= 0) {
        const ty = Math.floor((npy + PH) / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) { p.py = ty * BS - PH; p.vy = 0; p.onGround = true; }
        else p.py = npy;
      } else {
        const ty = Math.floor(npy / BS);
        if (solid(tx0, ty) || solid(tx1, ty)) { p.py = (ty + 1) * BS; p.vy = 0; }
        else p.py = npy;
      }
      p.py = Math.max(0, Math.min(bd.length * BS - PH, p.py));
    }

    // === SKY ===
    const sky = getSky(now);
    const grad = ctx.createLinearGradient(0, 0, 0, WH);
    if (sky.alpha > 0.35) {
      grad.addColorStop(0, `rgb(${sky.r},${sky.g},${sky.b})`);
      grad.addColorStop(1, "#0a0010");
    } else {
      grad.addColorStop(0, "#1a3a5c");
      grad.addColorStop(0.5, "#0f2035");
      grad.addColorStop(1, "#050d14");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WW, WH);

    // Stars
    if (sky.stars && sky.alpha > 0.1) {
      const starAlpha = Math.min(1, (sky.alpha - 0.1) * 2);
      starsRef.current.forEach((s) => {
        const tw = 0.7 + 0.3 * Math.sin(now / 800 + s.twinkle);
        ctx.fillStyle = `rgba(255,255,255,${starAlpha * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Sun / Moon
    const t = (now % DAY_MS) / DAY_MS;
    if (sky.alpha < 0.4) {
      // Sun arc
      const sunAngle = t * Math.PI * 2 - Math.PI / 2;
      const sx = WW / 2 + Math.cos(sunAngle) * 320;
      const sy = WH * 0.5 + Math.sin(sunAngle) * 280;
      if (sy < WH * 0.55) {
        const sunGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 28);
        sunGrad.addColorStop(0, "rgba(255,240,100,1)");
        sunGrad.addColorStop(0.5, "rgba(255,180,0,0.8)");
        sunGrad.addColorStop(1, "rgba(255,140,0,0)");
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, 28, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (sky.alpha > 0.5) {
      // Moon arc (offset by half cycle)
      const moonAngle = (t + 0.5) * Math.PI * 2 - Math.PI / 2;
      const mx = WW / 2 + Math.cos(moonAngle) * 320;
      const my = WH * 0.5 + Math.sin(moonAngle) * 280;
      if (my < WH * 0.55) {
        ctx.fillStyle = "rgba(220,230,255,0.9)";
        ctx.beginPath();
        ctx.arc(mx, my, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(10,0,30,0.7)";
        ctx.beginPath();
        ctx.arc(mx + 6, my - 4, 13, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // === BLOCKS ===
    if (bd) {
      for (let y = 0; y < bd.length; y++) {
        for (let x = 0; x < bd[y].length; x++) {
          const blk = bd[y][x];
          if (blk === "air") continue;
          const col = BLOCK_COLORS[blk] ?? "#1e293b";
          ctx.fillStyle = col;
          ctx.fillRect(x * BS, y * BS, BS, BS);
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          ctx.fillRect(x * BS + 1, y * BS + 1, BS - 2, 5);
          ctx.strokeStyle = "rgba(0,0,0,0.35)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x * BS + 0.5, y * BS + 0.5, BS - 1, BS - 1);
        }
      }
    }

    // === PLAYER ===
    const { px, py, facingRight: fr } = p;
    ctx.fillStyle = "#1e4d2b";
    ctx.fillRect(px + 5, py + 14, PW - 10, PH - 14);
    ctx.fillStyle = "#fbbf24";
    ctx.fillRect(px + 3, py + 2, PW - 6, 14);
    ctx.fillStyle = "#000";
    ctx.fillRect(fr ? px + 13 : px + 5, py + 7, 4, 4);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(fr ? px + 14 : px + 6, py + 8, 2, 2);
    if (tool === "wrench") {
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(fr ? px + PW + 1 : px - 7, py + 14, 6, 12);
      ctx.fillStyle = "#78350f";
      ctx.fillRect(fr ? px + PW + 2 : px - 6, py + 12, 4, 4);
    } else {
      ctx.fillStyle = "#9ca3af";
      ctx.fillRect(fr ? px + PW + 1 : px - 5, py + 16, 4, 14);
      ctx.fillStyle = "#6b7280";
      ctx.fillRect(fr ? px + PW : px - 6, py + 13, 6, 6);
    }

    // === NIGHT OVERLAY ===
    if (sky.alpha > 0) {
      ctx.fillStyle = `rgba(0,0,20,${sky.alpha * 0.45})`;
      ctx.fillRect(0, 0, WW, WH);
    }

    // Scanlines
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    for (let y = 0; y < WH; y += 4) ctx.fillRect(0, y, WW, 2);

    rafRef.current = requestAnimationFrame(drawFrame);
  }, [solid, tool]);

  useEffect(() => {
    lastTRef.current = performance.now();
    rafRef.current = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawFrame]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      keysRef.current.add(e.key);
      const p = physRef.current;
      if (["ArrowLeft","a","A"].includes(e.key)) { p.vx = -MOVE_SPEED; p.facingRight = false; }
      if (["ArrowRight","d","D"].includes(e.key)) { p.vx = MOVE_SPEED; p.facingRight = true; }
      if ([" ","ArrowUp","w","W"].includes(e.key) && p.onGround) {
        p.vy = JUMP_VY; p.onGround = false; e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key);
      const keys = keysRef.current;
      const goLeft = keys.has("ArrowLeft") || keys.has("a") || keys.has("A");
      const goRight = keys.has("ArrowRight") || keys.has("d") || keys.has("D");
      if (!goLeft && !goRight) physRef.current.vx = 0;
      else if (goLeft) { physRef.current.vx = -MOVE_SPEED; physRef.current.facingRight = false; }
      else { physRef.current.vx = MOVE_SPEED; physRef.current.facingRight = true; }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, []);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bx = Math.floor(((e.clientX - rect.left) / rect.width) * WW / BS);
    const by = Math.floor(((e.clientY - rect.top) / rect.height) * WH / BS);
    const bd = worldRef.current;
    if (!bd || by >= bd.length || bx >= bd[0].length || by < 0 || bx < 0) return;
    if (bd[by][bx] === "air") return;

    const p = physRef.current;
    const pcx = (p.px + PW / 2) / BS;
    const pcy = (p.py + PH / 2) / BS;
    const dist = Math.sqrt((bx - pcx) ** 2 + (by - pcy) ** 2);
    if (dist > 2.8) { toast({ title: "TOO FAR", description: "Move closer to mine.", className: "bg-black border-border text-muted-foreground font-mono" }); return; }

    if (tool === "wrench") {
      toast({ title: `INSPECT: ${bd[by][bx].toUpperCase().replace(/_/g, " ")}`, description: "Wrench interacts with placed machines only.", className: "bg-black border-yellow-500 text-yellow-500 font-mono uppercase" });
      return;
    }

    gameAction.mutate(
      { data: { actionType: "break", worldName: "start", x: bx, y: by } },
      {
        onSuccess: (data) => {
          if (data.wizardChallenge) { setWizard(true); return; }
          if (data.success) {
            if (worldRef.current) {
              const updated = worldRef.current.map((row) => [...row]);
              updated[by][bx] = "air";
              worldRef.current = updated;
            }
            if (data.dropItem) toast({ title: `+1 ${data.dropItem.toUpperCase().replace(/_/g, " ")}`, className: "border-primary bg-black text-primary font-mono uppercase" });
            refetchWorld();
          }
        },
      }
    );
  };

  const mobileMove = (dir: "left" | "right" | "stop" | "jump") => {
    const p = physRef.current;
    if (dir === "left") { p.vx = -MOVE_SPEED; p.facingRight = false; }
    if (dir === "right") { p.vx = MOVE_SPEED; p.facingRight = true; }
    if (dir === "stop") p.vx = 0;
    if (dir === "jump" && p.onGround) { p.vy = JUMP_VY; p.onGround = false; }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col h-full bg-background overflow-hidden">
      {/* HUD */}
      <div className="flex justify-between items-center px-3 py-1.5 bg-sidebar/95 border-b border-border z-10 shrink-0 gap-2">
        <div className="flex items-center gap-2 text-xs font-mono">
          <div className="bg-black/50 px-2 py-1 rounded border border-primary/20">
            <span className="text-muted-foreground uppercase block leading-none mb-0.5">Agent</span>
            <span className="text-white font-bold">{username}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setTool("pickaxe")}
            className={`p-1.5 rounded border font-bold ${tool === "pickaxe" ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground hover:border-primary/50"}`}
            title="Pickaxe — mine blocks"
          >
            <Pickaxe className="w-4 h-4" />
          </button>
          <button
            onClick={() => setTool("wrench")}
            className={`p-1.5 rounded border font-bold ${tool === "wrench" ? "border-yellow-500 text-yellow-400 bg-yellow-500/10" : "border-border text-muted-foreground hover:border-yellow-500/50"}`}
            title="Wrench — interact with machines"
          >
            <Wrench className="w-4 h-4" />
          </button>
          <div className="bg-black/50 px-2 py-1 rounded border border-accent/30 text-xs font-mono">
            <span className="text-muted-foreground uppercase block leading-none mb-0.5">Energy</span>
            <div className="flex items-center text-accent font-bold">
              <Zap className="w-3 h-3 mr-0.5" />{wallet?.actionCount ?? 0}/100
            </div>
          </div>
          <div className="bg-black/50 px-2 py-1 rounded border border-primary/30 text-xs font-mono text-right">
            <span className="text-muted-foreground uppercase block leading-none mb-0.5">Gems</span>
            <span className="text-primary font-bold">{wallet?.gems ?? 0}</span>
          </div>
          <button
            onClick={() => setChatOpen((s) => !s)}
            className={`p-1.5 rounded border ${chatOpen ? "border-primary text-primary bg-primary/10" : "border-border text-muted-foreground"}`}
            title="World Chat"
          >
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Canvas + Chat */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 bg-[#050d14] flex items-center justify-center relative overflow-hidden">
          <canvas
            ref={canvasRef}
            width={WW}
            height={WH}
            onClick={handleCanvasClick}
            className="max-w-full max-h-full object-contain cursor-crosshair border border-border/30"
            style={{ imageRendering: "pixelated" }}
          />
        </div>

        {chatOpen && (
          <div className="w-60 flex flex-col bg-black/95 border-l border-border font-mono text-xs shrink-0">
            <div className="px-3 py-2 border-b border-border text-primary uppercase tracking-widest font-bold text-[10px]">
              World Chat
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1 min-h-0">
              {chatMsgs.length === 0 && (
                <p className="text-muted-foreground italic text-[10px]">No messages yet — say hi!</p>
              )}
              {chatMsgs.map((m, i) => (
                <div key={i} className="break-words">
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

      {/* Mobile Controls */}
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

      {/* Wizard Modal */}
      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center tracking-widest uppercase">
              <TriangleAlert className="mr-2" /> Anti-Bot Verification
            </DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground">High action rate detected. Enter override sequence:</p>
            <p className="text-2xl font-bold text-white">2 + 3 = ?</p>
            <Input value={wizardAns} onChange={(e) => setWizardAns(e.target.value)} className="text-center text-xl font-bold text-primary border-primary/50" />
          </div>
          <DialogFooter>
            <Button
              className="w-full bg-destructive hover:bg-destructive/80 font-bold uppercase tracking-widest"
              onClick={() => {
                if (wizardAns === "5") { setWizard(false); setWizardAns(""); toast({ title: "VERIFIED", className: "bg-black border-primary text-primary" }); }
                else toast({ title: "ACCESS DENIED", variant: "destructive" });
              }}
            >Verify Identity</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
