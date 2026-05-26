import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Gamepad2, Server, Backpack, Store, Trophy, LogOut, Hammer, Wallet } from "lucide-react";
import { useGetWallet, getGetWalletQueryKey } from "@workspace/api-client-react";

export default function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: wallet } = useGetWallet({
    query: { enabled: !!localStorage.getItem("userId"), queryKey: getGetWalletQueryKey() },
  });

  const logout = () => {
    localStorage.removeItem("userId");
    localStorage.removeItem("username");
    setLocation("/");
  };

  const navItems = [
    { href: "/game",        icon: Gamepad2, label: "Game"      },
    { href: "/craft",       icon: Hammer,   label: "Craft"     },
    { href: "/miner",       icon: Server,   label: "Miner"     },
    { href: "/wallet",      icon: Wallet,   label: "Wallet"    },
    { href: "/inventory",   icon: Backpack, label: "Items"     },
    { href: "/store",       icon: Store,    label: "Store"     },
    { href: "/leaderboard", icon: Trophy,   label: "Board"     },
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-mono">
      {/* Desktop Sidebar */}
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
              className={`flex items-center space-x-3 px-3 py-2.5 rounded transition-all text-sm ${
                location === item.href
                  ? "bg-primary/15 text-primary border border-primary/40 drop-shadow-[0_0_5px_rgba(34,197,94,0.2)]"
                  : "hover:bg-accent/10 text-muted-foreground hover:text-accent"
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="font-bold tracking-wider uppercase text-xs">{item.label}</span>
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden min-w-0">
        {/* Mobile Header */}
        <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-border bg-sidebar/80 backdrop-blur z-10 shrink-0">
          <h1 className="text-lg font-black text-primary drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] uppercase tracking-tighter">
            MINEVAULT
          </h1>
          {wallet && <span className="font-bold text-primary text-sm">{wallet.gems} G</span>}
        </header>

        {/* overflow-hidden + flex flex-col so that children using h-full work correctly.
            pb-14 on mobile reserves the 56px bottom nav space above content. */}
        <div className="flex-1 overflow-hidden relative z-0 min-h-0 flex flex-col pb-14 md:pb-0">
          {children}
        </div>

        {/* Mobile Bottom Tab */}
        <nav className="md:hidden absolute bottom-0 left-0 right-0 h-14 border-t border-border bg-sidebar/95 backdrop-blur z-20 flex items-center justify-around px-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center px-1 h-full space-y-0.5 ${
                location === item.href
                  ? "text-primary drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]"
                  : "text-muted-foreground"
              }`}
            >
              <item.icon className="w-4 h-4" />
              <span className="text-[9px] font-bold uppercase">{item.label}</span>
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
