// ============================================================
// not-found.tsx — 404 fallback page
//
// Shown when the Wouter router can't match the current path.
// This can happen if the user arrives at a legacy URL like /old-game/.
// We auto-redirect them to the root (login / auth page) after a brief
// moment, so no one ever gets stuck on a dead white page.
// ============================================================

import { useEffect } from "react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  // Redirect to the root (auth/login) after a very short delay so the
  // user at least sees a readable message instead of snapping instantly.
  useEffect(() => {
    const id = setTimeout(() => setLocation("/"), 1200);
    return () => clearTimeout(id);
  }, [setLocation]);

  return (
    // Match the game's dark theme — never a jarring white screen
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center gap-4 font-mono">
      <div className="text-primary text-4xl">⛏</div>
      <h1 className="text-primary font-black uppercase tracking-widest text-lg">
        Wrong Grid
      </h1>
      <p className="text-muted-foreground text-xs uppercase tracking-widest animate-pulse">
        Redirecting to base…
      </p>
    </div>
  );
}
