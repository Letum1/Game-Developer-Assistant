import { useEffect, useRef, useState } from "react";
import { useGetWorld, useGameAction, useGetWallet, getGetWorldQueryKey, getGetWalletQueryKey } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Zap, TriangleAlert } from "lucide-react";

export default function Game() {
  const userId = localStorage.getItem("userId");
  const username = localStorage.getItem("username");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const { data: world, refetch: refetchWorld } = useGetWorld("start", { query: { enabled: !!userId, queryKey: getGetWorldQueryKey("start") } });
  const { data: wallet } = useGetWallet({ query: { enabled: !!userId, queryKey: getGetWalletQueryKey() } });
  const gameAction = useGameAction();
  const { toast } = useToast();

  const [playerPos, setPlayerPos] = useState({ x: 5, y: 5 });
  const [wizardChallenge, setWizardChallenge] = useState(false);
  const [wizardAnswer, setWizardAnswer] = useState("");

  const BLOCK_SIZE = 40;

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !world) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw blocks
    for (let y = 0; y < world.blockData.length; y++) {
      for (let x = 0; x < world.blockData[y].length; x++) {
        const block = world.blockData[y][x];
        
        if (block !== "air") {
          switch (block) {
            case "block_grass": ctx.fillStyle = "#22c55e"; break;
            case "block_dirt": ctx.fillStyle = "#78350f"; break;
            case "block_rock": ctx.fillStyle = "#4b5563"; break;
            case "block_iron": ctx.fillStyle = "#94a3b8"; break;
            case "block_gold": ctx.fillStyle = "#eab308"; break;
            case "block_diamond": ctx.fillStyle = "#06b6d4"; break;
            case "block_lava": ctx.fillStyle = "#ef4444"; break;
            default: ctx.fillStyle = "#1e293b";
          }
          
          ctx.fillRect(x * BLOCK_SIZE, y * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
          ctx.strokeStyle = "#0f172a";
          ctx.lineWidth = 2;
          ctx.strokeRect(x * BLOCK_SIZE, y * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
        }
      }
    }

    // Draw Player
    ctx.fillStyle = "#10b981"; // Neon green player
    ctx.fillRect(playerPos.x * BLOCK_SIZE + 4, playerPos.y * BLOCK_SIZE + 4, BLOCK_SIZE - 8, BLOCK_SIZE - 8);
    
    // Player Eyes (Hacker vibe)
    ctx.fillStyle = "#000";
    ctx.fillRect(playerPos.x * BLOCK_SIZE + 12, playerPos.y * BLOCK_SIZE + 12, 4, 4);
    ctx.fillRect(playerPos.x * BLOCK_SIZE + 24, playerPos.y * BLOCK_SIZE + 12, 4, 4);
    ctx.fillStyle = "#22c55e"; // glow
    ctx.fillRect(playerPos.x * BLOCK_SIZE + 13, playerPos.y * BLOCK_SIZE + 13, 2, 2);
    ctx.fillRect(playerPos.x * BLOCK_SIZE + 25, playerPos.y * BLOCK_SIZE + 13, 2, 2);
  };

  useEffect(() => {
    draw();
  }, [world, playerPos]);

  const movePlayer = (dx: number, dy: number) => {
    if (!world) return;
    const newX = Math.max(0, Math.min(world.blockData[0].length - 1, playerPos.x + dx));
    const newY = Math.max(0, Math.min(world.blockData.length - 1, playerPos.y + dy));
    
    // Collision
    if (world.blockData[newY][newX] === "air") {
      setPlayerPos({ x: newX, y: newY });
    }
  };

  const handleMine = (tx: number, ty: number) => {
    if (!world) return;
    
    // Only mine adjacent
    const dist = Math.abs(tx - playerPos.x) + Math.abs(ty - playerPos.y);
    if (dist > 1.5 || dist === 0) return;

    if (world.blockData[ty][tx] !== "air") {
      gameAction.mutate(
        { data: { actionType: "break", worldName: "start", x: tx, y: ty } },
        {
          onSuccess: (data) => {
            if (data.wizardChallenge) {
              setWizardChallenge(true);
              return;
            }
            if (data.success) {
              if (data.dropItem) {
                toast({ title: "LOOT ACQUIRED", description: `+1 ${data.dropItem.toUpperCase()}`, className: "border-primary bg-black text-primary font-mono uppercase" });
              }
              refetchWorld();
            }
          }
        }
      );
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const x = Math.floor((e.clientX - rect.left) / BLOCK_SIZE);
    const y = Math.floor((e.clientY - rect.top) / BLOCK_SIZE);
    
    // Check if moving or mining
    if (world && world.blockData[y][x] === "air") {
      // Basic teleport if adjacent
       const dist = Math.abs(x - playerPos.x) + Math.max(0, Math.abs(y - playerPos.y));
       if(dist <= 1.5) {
          movePlayer(x - playerPos.x, y - playerPos.y);
       }
    } else {
      handleMine(x, y);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
        case "a":
        case "A": movePlayer(-1, 0); break;
        case "ArrowRight":
        case "d":
        case "D": movePlayer(1, 0); break;
        case "ArrowUp":
        case "w":
        case "W": movePlayer(0, -1); break;
        case "ArrowDown":
        case "s":
        case "S": movePlayer(0, 1); break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerPos, world]);

  return (
    <motion.div 
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      className="flex flex-col h-full bg-background"
    >
      {/* HUD */}
      <div className="flex justify-between p-4 bg-sidebar/80 border-b border-border shadow-[0_4px_20px_rgba(0,0,0,0.5)] z-10">
        <div className="flex items-center space-x-4">
           <div className="bg-black/50 px-3 py-1 rounded border border-primary/20">
             <span className="text-xs text-muted-foreground uppercase block">Sector</span>
             <span className="text-primary font-bold">{world?.name || "START"}</span>
           </div>
           <div className="bg-black/50 px-3 py-1 rounded border border-primary/20">
             <span className="text-xs text-muted-foreground uppercase block">Callsign</span>
             <span className="text-white font-bold">{username}</span>
           </div>
        </div>
        <div className="flex items-center space-x-4">
           <div className="bg-black/50 px-3 py-1 rounded border border-accent/30 text-right">
             <span className="text-xs text-muted-foreground uppercase block">Energy</span>
             <div className="flex items-center text-accent">
               <Zap className="w-4 h-4 mr-1" />
               <span className="font-bold">{wallet?.actionCount || 0}/100</span>
             </div>
           </div>
           <div className="bg-black/50 px-3 py-1 rounded border border-primary/30 text-right">
             <span className="text-xs text-muted-foreground uppercase block">Gems</span>
             <span className="text-primary font-bold shadow-primary drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]">
               {wallet?.gems || 0}
             </span>
           </div>
        </div>
      </div>

      {/* Game View */}
      <div className="flex-1 overflow-auto bg-black relative flex items-center justify-center p-4">
        {/* Scanlines over canvas */}
        <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(transparent_50%,rgba(0,0,0,1)_50%)] bg-[length:100%_4px] z-10" />
        
        <div className="border border-border p-1 bg-sidebar/50 rounded shadow-[0_0_30px_rgba(34,197,94,0.1)]">
          <canvas
            ref={canvasRef}
            width={800}
            height={600}
            onClick={handleCanvasClick}
            className="bg-black cursor-crosshair max-w-full h-auto object-contain"
          />
        </div>
      </div>

      {/* Mobile Controls */}
      <div className="md:hidden grid grid-cols-3 gap-2 p-4 bg-sidebar/90 border-t border-border">
        <Button variant="outline" className="border-border bg-black hover:bg-accent/20 hover:text-accent" onClick={() => movePlayer(-1, 0)}>LEFT</Button>
        <Button variant="outline" className="border-border bg-black hover:bg-accent/20 hover:text-accent" onClick={() => movePlayer(0, -1)}>UP</Button>
        <Button variant="outline" className="border-border bg-black hover:bg-accent/20 hover:text-accent" onClick={() => movePlayer(1, 0)}>RIGHT</Button>
      </div>

      {/* Wizard Challenge Modal */}
      <Dialog open={wizardChallenge} onOpenChange={setWizardChallenge}>
        <DialogContent className="border-destructive bg-black font-mono">
          <DialogHeader>
            <DialogTitle className="text-destructive flex items-center tracking-widest uppercase">
              <TriangleAlert className="mr-2" /> Anti-Bot Verification
            </DialogTitle>
          </DialogHeader>
          <div className="py-6 text-center space-y-4">
            <p className="text-muted-foreground">High action rate detected. Enter override sequence:</p>
            <p className="text-2xl font-bold text-white">2 + 3 = ?</p>
            <Input 
              value={wizardAnswer} 
              onChange={e => setWizardAnswer(e.target.value)} 
              className="text-center text-xl tracking-widest font-bold text-primary border-primary/50 focus-visible:ring-primary"
            />
          </div>
          <DialogFooter>
            <Button 
              className="w-full bg-destructive text-destructive-foreground hover:bg-destructive/80 font-bold uppercase tracking-widest"
              onClick={() => {
                if (wizardAnswer === "5") {
                  setWizardChallenge(false);
                  setWizardAnswer("");
                  toast({ title: "VERIFIED", description: "Clearance granted.", className: "bg-black border-primary text-primary" });
                } else {
                  toast({ title: "ACCESS DENIED", variant: "destructive" });
                }
              }}
            >
              Verify Identity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}
