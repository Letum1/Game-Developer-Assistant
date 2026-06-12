// ============================================================
// Layout.tsx — App shell with sidebar (desktop) + bottom nav (mobile)
//
// Restock notifications: polls GET /api/store every 60 s. When a
// new restock is detected (restockNumber increases), shows a toast
// and lights up a pulsing dot on the "Shop" nav item until visited.
// ============================================================

import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  Gamepad2, Server, Backpack, Store, Trophy, LogOut,
  Hammer, Wallet, ShieldAlert,
} from "lucide-react";
import { useGetWallet, getGetWalletQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import AdBanner from "./AdBanner";

type NavItem = {
  href:   string;
  icon:   React.ElementType;
  label:  string;
  badge?: boolean; // pulsing notification dot
};

export default function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: wallet }        = useGetWallet({
    query: { enabled: !!localStorage.getItem("userId"), queryKey: getGetWalletQueryKey() },
  });
  const { toast } = useToast();

  const isAdmin = localStorage.getItem("isAdmin") === "true";

  // ── Restock notification state ──────────────────────────────────────────────
  // hasNewRestock → lights up the "Shop" dot until the user visits /store
  const [hasNewRestock, setHasNewRestock] = useState(false);
  const lastRestockNumRef = useRef<number | null>(null);

  useEffect(() => {
    const check = async () => {
      const uid = localStorage.getItem("userId");
      if (!uid) return;
      try {
        const res  = await fetch("/api/store");
        const data = await res.json() as { restockNumber: number; items: { rarity: string; displayName: string; quantity: number }[] };
        const num  = data.restockNumber;

        if (lastRestockNumRef.current !== null && num > lastRestockNumRef.current) {
          // New restock — show a toast and light up the nav badge
          setHasNewRestock(true);
          const hot = data.items.filter((i) => i.rarity === "ultra" || i.rarity === "rare");
          if (hot.length > 0) {
            toast({
              title:       "⚡ RARE RESTOCK!",
              description: hot.slice(0, 3).map((i) => `${i.displayName} ×${i.quantity}`).join("  ·  "),
              className:   "bg-purple-950 border-purple-400 text-purple-100 font-mono",
            });
          } else {
            toast({
              title:       "🏪 Shop Restocked!",
              description: "New items available in the Black Market.",
              className:   "bg-black border-primary text-primary font-mono",
            });
          }
        }
        lastRestockNumRef.current = num;
      } catch {
        // Network error — silently ignore, will retry on next poll
      }
    };

    check();
    const iv = setInterval(check, 60_000);
    return () => clearInterval(iv);
  }, [toast]);

  // Clear the notification dot when the user navigates to the store
  useEffect(() => {
    if (location === "/store") setHasNewRestock(false);
  }, [location]);

  const logout = () => {
    localStorage.removeItem("userId");
    localStorage.removeItem("username");
    localStorage.removeItem("isAdmin");
    setLocation("/");
  };

  const navItems: NavItem[] = [
    { href: "/game",        icon: Gamepad2,    label: "Game"  },
    { href: "/craft",       icon: Hammer,      label: "Craft" },
    { href: "/miner",       icon: Server,      label: "Miner" },
    { href: "/wallet",      icon: Wallet,      label: "Wallet" },
    { href: "/inventory",   icon: Backpack,    label: "Items" },
    { href: "/store",       icon: Store,       label: "Shop",  badge: hasNewRestock },
    { href: "/leaderboard", icon: Trophy,      label: "Board" },
    ...(isAdmin ? [{ href: "/admin", icon: ShieldAlert, label: "Admin" }] : []),
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-mono">

      {/* ── Desktop Sidebar ── */}
      <aside className="hidden md:flex flex-col w-56 border-r border-border bg-sidebar/50 backdrop-blur-sm shrink-0">
        <div className="p-5 border-b border-border">
          <h1 className="text-xl font-black text-primary drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] tracking-tighter uppercase">
            MINEVAULT
          </h1>
          {wallet && (
            <div className="mt-3 bg-black/50 px-2 py-1.5 rounded border border-primary/20 text-xs">
              <span className="text-muted-foreground uppercase block text-[10px] mb-0.5">Balance</span>
              <span className="text-primary font-bold">{wallet.gems} GEMS</span>
            </div>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex items-center space-x-3 px-3 py-2.5 rounded transition-all text-sm ${
                location === item.href
                  ? "bg-primary/15 text-primary border border-primary/40 drop-shadow-[0_0_5px_rgba(34,197,94,0.2)]"
                  : "hover:bg-accent/10 text-muted-foreground hover:text-accent"
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="font-bold tracking-wider uppercase text-xs">{item.label}</span>
              {/* Restock notification dot */}
              {item.badge && (
                <span className="ml-auto w-2 h-2 rounded-full bg-purple-400 animate-pulse shrink-0" />
              )}
            </Link>
          ))}
        </nav>

        <div className="p-3 border-t border-border">
          <button
            onClick={logout}
            className="flex items-center space-x-2 text-muted-foreground hover:text-destructive w-full px-3 py-2 rounded transition-colors text-xs"
          >
            <LogOut className="w-4 h-4" />
            <span className="font-bold tracking-wider uppercase">Logout</span>
          </button>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className="flex-1 flex flex-col relative overflow-hidden min-w-0">
        {/* Mobile Header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-sidebar/80 backdrop-blur z-10 shrink-0">
          <h1 className="text-lg font-black text-primary drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] uppercase tracking-tighter">
            MINEVAULT
          </h1>
          <div className="flex items-center gap-3">
            {wallet && (
              <span className="font-bold text-primary text-sm">{wallet.gems} 💎</span>
            )}
            <button
              onClick={logout}
              className="flex items-center gap-1 text-muted-foreground hover:text-destructive transition-colors p-1"
              title="Logout"
              aria-label="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Content area */}
        <div className="flex-1 overflow-hidden relative z-0 min-h-0 flex flex-col pb-[116px] md:pb-[60px]">
          {children}
        </div>

        {/* Ad Banner */}
        <div className="absolute bottom-14 md:bottom-0 left-0 right-0 z-10" style={{ height: 60 }}>
          <AdBanner />
        </div>

        {/* Mobile Bottom Tab */}
        <nav className="md:hidden absolute bottom-0 left-0 right-0 h-14 border-t border-border bg-sidebar/95 backdrop-blur z-20 flex items-center justify-around px-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`relative flex flex-col items-center justify-center px-1 h-full space-y-0.5 ${
                location === item.href
                  ? "text-primary drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]"
                  : "text-muted-foreground"
              }`}
            >
              <item.icon className="w-4 h-4" />
              <span className="text-[9px] font-bold uppercase">{item.label}</span>
              {/* Restock dot on mobile */}
              {item.badge && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
              )}
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
