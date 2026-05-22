import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Gamepad2, Server, Backpack, Store, Trophy, LogOut } from "lucide-react";
import { useGetWallet, getGetWalletQueryKey } from "@workspace/api-client-react";

export default function Layout({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const { data: wallet } = useGetWallet({ query: { enabled: !!localStorage.getItem("userId"), queryKey: getGetWalletQueryKey() } });

  const logout = () => {
    localStorage.removeItem("userId");
    localStorage.removeItem("username");
    setLocation("/");
  };

  const navItems = [
    { href: "/game", icon: Gamepad2, label: "Game" },
    { href: "/miner", icon: Server, label: "Miner" },
    { href: "/inventory", icon: Backpack, label: "Inventory" },
    { href: "/store", icon: Store, label: "Store" },
    { href: "/leaderboard", icon: Trophy, label: "Leaderboard" },
  ];

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background text-foreground font-mono">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r border-border bg-sidebar/50 backdrop-blur-sm">
        <div className="p-6 border-b border-border">
          <h1 className="text-2xl font-black text-primary drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] tracking-tighter uppercase">MINEVAULT</h1>
          {wallet && (
            <div className="mt-4 flex items-center space-x-2 bg-black/50 p-2 rounded border border-primary/20">
              <span className="text-primary font-bold">{wallet.gems} GEMS</span>
            </div>
          )}
        </div>
        
        <nav className="flex-1 overflow-y-auto p-4 space-y-2">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href}>
              <a className={`flex items-center space-x-3 px-4 py-3 rounded transition-colors ${location === item.href ? "bg-primary/20 text-primary border border-primary/50 drop-shadow-[0_0_5px_rgba(34,197,94,0.3)]" : "hover:bg-accent/10 text-muted-foreground hover:text-accent"}`}>
                <item.icon className="w-5 h-5" />
                <span className="font-bold tracking-wider">{item.label}</span>
              </a>
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-border">
          <button onClick={logout} className="flex items-center space-x-2 text-muted-foreground hover:text-destructive w-full px-4 py-2 rounded transition-colors">
            <LogOut className="w-5 h-5" />
            <span className="font-bold tracking-wider">LOGOUT</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative overflow-hidden">
        {/* Mobile Header */}
        <header className="md:hidden flex items-center justify-between p-4 border-b border-border bg-sidebar/80 backdrop-blur z-10">
          <h1 className="text-xl font-black text-primary drop-shadow-[0_0_8px_rgba(34,197,94,0.5)] uppercase tracking-tighter">MINEVAULT</h1>
          {wallet && <span className="font-bold text-primary">{wallet.gems} G</span>}
        </header>

        <div className="flex-1 overflow-y-auto pb-16 md:pb-0 relative z-0">
          {children}
        </div>

        {/* Mobile Bottom Tab */}
        <nav className="md:hidden absolute bottom-0 left-0 right-0 h-16 border-t border-border bg-sidebar/90 backdrop-blur z-20 flex items-center justify-around px-2">
          {navItems.map((item) => (
            <Link key={item.href} href={item.href}>
              <a className={`flex flex-col items-center justify-center w-full h-full space-y-1 ${location === item.href ? "text-primary drop-shadow-[0_0_5px_rgba(34,197,94,0.5)]" : "text-muted-foreground"}`}>
                <item.icon className="w-5 h-5" />
                <span className="text-[10px] font-bold uppercase">{item.label}</span>
              </a>
            </Link>
          ))}
        </nav>
      </main>
    </div>
  );
}
