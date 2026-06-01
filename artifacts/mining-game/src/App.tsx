// App.tsx — Root router.  Wraps everything in React-Query + Tooltip + Toaster.
//
// Route map:
//   /            → Auth (login / register)
//   /game        → WorldSelect (Growtopia-style world entry)
//   /game/:world → Game (actual 2-D canvas game for the named world)
//   /craft       → Craft page
//   /miner       → Passive miner dashboard
//   /inventory   → Inventory list
//   /store       → Gem shop
//   /leaderboard → Leaderboard / revenue pool
//   /wallet      → Wallet page
//   /admin       → Admin debug panel (server-side guard rejects non-admin users)

import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster }         from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound    from "@/pages/not-found";
import Auth        from "@/pages/Auth";
import WorldSelect from "@/pages/WorldSelect";
import Game        from "@/pages/Game";
import Miner       from "@/pages/Miner";
import Craft       from "@/pages/Craft";
import Inventory   from "@/pages/Inventory";
import Store       from "@/pages/Store";
import Leaderboard from "@/pages/Leaderboard";
import WalletPage  from "@/pages/Wallet";
import Admin       from "@/pages/Admin";
import Layout      from "@/components/Layout";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry:     1,
      staleTime: 10_000,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Auth} />

      {/* World entry screen — players type a world name to enter */}
      <Route path="/game">
        <Layout><WorldSelect /></Layout>
      </Route>

      {/* Actual game — worldName param is the named world to load */}
      <Route path="/game/:worldName">
        {(params) => (
          <Layout>
            <Game worldName={(params as { worldName: string }).worldName} />
          </Layout>
        )}
      </Route>

      <Route path="/craft">
        <Layout><Craft /></Layout>
      </Route>
      <Route path="/miner">
        <Layout><Miner /></Layout>
      </Route>
      <Route path="/inventory">
        <Layout><Inventory /></Layout>
      </Route>
      <Route path="/store">
        <Layout><Store /></Layout>
      </Route>
      <Route path="/leaderboard">
        <Layout><Leaderboard /></Layout>
      </Route>
      <Route path="/wallet">
        <Layout><WalletPage /></Layout>
      </Route>

      {/* Admin panel — server-side guard rejects non-admin users */}
      <Route path="/admin">
        <Layout><Admin /></Layout>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
