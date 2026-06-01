// ============================================================
// WorldSelect.tsx — Growtopia-style world entry screen.
//
// Players type a world name and press GO.  If the world exists on the
// server it is loaded; otherwise the server generates fresh seeded terrain.
// Recent worlds are stored in localStorage for one-tap re-entry.
// ============================================================

import { useState, useEffect } from "react";
import { useLocation }         from "wouter";
import { Globe, ArrowRight, Clock, Layers } from "lucide-react";

// ─── World name rules ────────────────────────────────────────────────────────
// Mirror Growtopia convention: uppercase letters, digits, underscores.
// Max 24 characters.  The regex is enforced both on keypress (filter) and on
// submit (hard validation).
const MAX_LEN  = 24;
const VALID_RE = /^[A-Z0-9_]{1,24}$/;

// ─── Helpers: localStorage recent worlds ─────────────────────────────────────
function getRecentWorlds(): string[] {
  try { return JSON.parse(localStorage.getItem("recentWorlds") ?? "[]") as string[]; }
  catch { return []; }
}

function addRecentWorld(name: string): void {
  const prev    = getRecentWorlds();
  const updated = [name, ...prev.filter((w) => w !== name)].slice(0, 10);
  localStorage.setItem("recentWorlds", JSON.stringify(updated));
}

// ─── Component ───────────────────────────────────────────────────────────────
export default function WorldSelect() {
  const [, navigate]     = useLocation();
  const [input,   setInput]   = useState("");
  const [error,   setError]   = useState("");
  const [recent,  setRecent]  = useState<string[]>([]);
  const [serverWorlds, setServerWorlds] = useState<string[]>([]);

  // Load recent worlds from localStorage and active worlds from server
  useEffect(() => {
    setRecent(getRecentWorlds());

    const userId = localStorage.getItem("userId") ?? "";
    fetch("/api/worlds", { headers: { "x-user-id": userId } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { worlds?: string[] } | null) => {
        if (data?.worlds) setServerWorlds(data.worlds);
      })
      .catch(() => {/* network error — ignore, server list is optional */});
  }, []);

  // Navigate into a world, recording it as a recent world
  const enterWorld = (rawName: string) => {
    const name = rawName.toUpperCase().trim();
    if (!VALID_RE.test(name)) {
      setError("World name must be 1–24 letters, digits, or underscores.");
      return;
    }
    setError("");
    addRecentWorld(name);
    setRecent(getRecentWorlds());
    navigate(`/game/${name}`);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    enterWorld(input);
  };

  // Server worlds not already in recent list (avoid duplicates)
  const discoveryWorlds = serverWorlds.filter((w) => !recent.includes(w));

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-background p-4 overflow-y-auto">
      <div className="w-full max-w-sm space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="text-center">
          <Globe className="w-10 h-10 text-primary mx-auto mb-2 drop-shadow-[0_0_12px_rgba(34,197,94,0.6)]" />
          <h2 className="text-2xl font-black text-primary uppercase tracking-widest drop-shadow-[0_0_8px_rgba(34,197,94,0.4)]">
            ENTER WORLD
          </h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">
            Type a name to visit or create a world
          </p>
        </div>

        {/* ── World name input ────────────────────────────────────────────── */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="relative">
            <input
              type="text"
              value={input}
              onChange={(e) => {
                // Strip disallowed chars and enforce uppercase / max length live
                const cleaned = e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9_]/g, "")
                  .slice(0, MAX_LEN);
                setInput(cleaned);
                setError("");
              }}
              placeholder="WORLD NAME"
              className="w-full bg-black border border-primary/50 text-primary font-mono text-lg px-4 py-3 rounded focus:outline-none focus:border-primary tracking-widest placeholder:text-primary/30 placeholder:tracking-widest"
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            {/* Character counter */}
            {input.length > 0 && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-mono">
                {input.length}/{MAX_LEN}
              </span>
            )}
          </div>

          {/* Validation error */}
          {error && (
            <p className="text-xs text-red-400 font-mono px-1">{error}</p>
          )}

          <button
            type="submit"
            disabled={input.trim().length === 0}
            className="w-full bg-primary hover:bg-primary/90 text-black font-black text-sm uppercase tracking-widest py-3 rounded flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            GO <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* ── Recently visited worlds ─────────────────────────────────────── */}
        {recent.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
              <Clock className="w-3 h-3" />
              <span>Recent</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {recent.map((name) => (
                <button
                  key={name}
                  onClick={() => enterWorld(name)}
                  className="bg-black/60 border border-border hover:border-primary/60 text-primary/80 hover:text-primary font-mono text-xs py-2 px-3 rounded uppercase tracking-wider text-left transition-all truncate"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Active worlds (from server, excluding already-shown recents) ─── */}
        {discoveryWorlds.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
              <Layers className="w-3 h-3" />
              <span>Active Worlds</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {discoveryWorlds.slice(0, 6).map((name) => (
                <button
                  key={name}
                  onClick={() => enterWorld(name)}
                  className="bg-black/30 border border-border/40 hover:border-primary/40 text-muted-foreground hover:text-primary/80 font-mono text-xs py-2 px-3 rounded uppercase tracking-wider text-left transition-all truncate"
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Tip ─────────────────────────────────────────────────────────── */}
        <p className="text-center text-[10px] text-muted-foreground/50 font-mono">
          Each world has unique terrain seeded by its name.
          <br />Share a name with a friend to play together!
        </p>

      </div>
    </div>
  );
}
