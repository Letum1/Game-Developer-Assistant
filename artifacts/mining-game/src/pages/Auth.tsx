import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useLogin, useRegister } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { TerminalSquare } from "lucide-react";

export default function Auth() {
  const [, setLocation] = useLocation();
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checking, setChecking] = useState(true);
  const { toast } = useToast();

  const loginMutation = useLogin();
  const registerMutation = useRegister();

  useEffect(() => {
    const userId = localStorage.getItem("userId");
    if (!userId) { setChecking(false); return; }

    fetch("/api/wallet", { headers: { "x-user-id": userId } })
      .then((r) => {
        if (r.ok) {
          setLocation("/game");
        } else {
          localStorage.removeItem("userId");
          localStorage.removeItem("username");
          setChecking(false);
        }
      })
      .catch(() => {
        setChecking(false);
      });
  }, [setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;

    const payload = { data: { username, password } };

    if (isLogin) {
      loginMutation.mutate(payload, {
        onSuccess: (data) => {
          if (data.success) {
            localStorage.setItem("userId", data.userId.toString());
            localStorage.setItem("username", data.username);
            // Store admin flag so Layout can show/hide the admin nav link.
            // The server sets isAdmin based on the ADMIN_USERNAME env var.
            localStorage.setItem("isAdmin", data.isAdmin ? "true" : "false");
            setLocation("/game");
          } else {
            toast({ title: "Login Failed", variant: "destructive" });
          }
        },
        onError: () => {
          toast({ title: "Login Failed", variant: "destructive" });
        }
      });
    } else {
      registerMutation.mutate(payload, {
        onSuccess: (data) => {
          if (data.success) {
            localStorage.setItem("userId", data.userId.toString());
            localStorage.setItem("username", data.username);
            localStorage.setItem("isAdmin", data.isAdmin ? "true" : "false");
            setLocation("/game");
          } else {
            toast({ title: "Registration Failed", variant: "destructive" });
          }
        },
        onError: () => {
          toast({ title: "Registration Failed", variant: "destructive" });
        }
      });
    }
  };

  if (checking) {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center">
        <div className="text-primary font-mono text-sm animate-pulse uppercase tracking-widest">
          Connecting to grid...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden font-mono">
      <div className="absolute inset-0 pointer-events-none opacity-20"
           style={{
             backgroundImage: 'linear-gradient(rgba(34, 197, 94, 0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(34, 197, 94, 0.2) 1px, transparent 1px)',
             backgroundSize: '20px 20px'
           }} />
      <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(transparent_50%,rgba(0,0,0,1)_50%)] bg-[length:100%_4px]" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="z-10 w-full max-w-md"
      >
        <div className="text-center mb-8">
          <TerminalSquare className="w-16 h-16 text-primary mx-auto mb-4 drop-shadow-[0_0_15px_rgba(34,197,94,0.5)]" />
          <h1 className="text-4xl md:text-6xl font-black text-primary drop-shadow-[0_0_15px_rgba(34,197,94,0.8)] tracking-tighter uppercase mb-2">
            MINEVAULT
          </h1>
          <p className="text-muted-foreground uppercase tracking-widest text-sm">System Access Terminal v1.0.0</p>
        </div>

        <Card className="border-primary/30 bg-black/60 backdrop-blur-md shadow-[0_0_30px_rgba(0,0,0,0.8)]">
          <form onSubmit={handleSubmit}>
            <CardHeader>
              <CardTitle className="text-xl uppercase tracking-wider text-primary">{isLogin ? "Authenticate" : "Initialize User"}</CardTitle>
              <CardDescription>Enter credentials to access the grid.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="uppercase tracking-widest text-xs text-muted-foreground">Callsign</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-black/50 border-primary/20 focus-visible:border-primary focus-visible:ring-primary/50 font-mono"
                  placeholder="HACKER_99"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="uppercase tracking-widest text-xs text-muted-foreground">Access Code</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-black/50 border-primary/20 focus-visible:border-primary focus-visible:ring-primary/50 font-mono tracking-widest"
                  placeholder="••••••••"
                  required
                />
              </div>
            </CardContent>
            <CardFooter className="flex flex-col space-y-4">
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/80 text-primary-foreground font-black tracking-widest uppercase transition-all shadow-[0_0_15px_rgba(34,197,94,0.4)] hover:shadow-[0_0_25px_rgba(34,197,94,0.6)] border border-primary"
                disabled={loginMutation.isPending || registerMutation.isPending}
              >
                {isLogin ? "Execute Login" : "Execute Register"}
              </Button>
              <button
                type="button"
                onClick={() => setIsLogin(!isLogin)}
                className="text-xs text-muted-foreground hover:text-primary transition-colors uppercase tracking-widest"
              >
                {isLogin ? "Establish New Link (Register)" : "Return to Login"}
              </button>
            </CardFooter>
          </form>
        </Card>
      </motion.div>
    </div>
  );
}
