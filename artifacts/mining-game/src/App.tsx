import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Auth from "@/pages/Auth";
import Game from "@/pages/Game";
import Miner from "@/pages/Miner";
import Craft from "@/pages/Craft";
import Inventory from "@/pages/Inventory";
import Store from "@/pages/Store";
import Leaderboard from "@/pages/Leaderboard";
import Layout from "@/components/Layout";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Auth} />
      <Route path="/game">
        <Layout><Game /></Layout>
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
