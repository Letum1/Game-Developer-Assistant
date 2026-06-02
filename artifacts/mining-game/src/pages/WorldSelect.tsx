// ============================================================
// WorldSelect.tsx — Growtopia-style world entry screen.
//
// Players type a world name and press GO.  If the world exists on the
// server it is loaded; otherwise the server generates fresh seeded terrain.
// Recent worlds are stored in localStorage for one-tap re-entry.
//
// World lock: locked worlds show a 🔒 icon. Owners can lock/unlock from
// the Recent panel using a World Lock item from the Store.
// ============================================================

import { useState, useEffect } from "react";
import { useLocation }         from "wouter";
import { Globe, ArrowRight, Clock, Layers, Lock, Unlock } from "lucide-react";

// ─── World name rules ────────────────────────────────────────────────────────
const MAX_LEN  = 24;
const VALID_RE = /^[A-Z0-9_]{1,24}$/;

// ─── Types ───────────────────────────────────────────────────────────────────
interface WorldInfo {
  name:    string;
  locked:  boolean;
  ownerId: number | null;
}

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
  const [, navigate]   = useLocation();
  const [input,  setInput]  = useState("");
  const [error,  setError]  = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [serverWorlds, setServerWorlds] = useState<WorldInfo[]>([]);
  const [lockBusy, setLockBusy] = useState<string | null>(null); // world name being locked/unlocked

  // Current user id — for comparing with world ownerId
  const currentUserId = parseInt(localStorage.getItem("userId") ?? "0") || 0;

  // Load recent worlds from localStorage and active worlds from server
  const fetchWorlds = () => {
    const userId = localStorage.getItem("userId") ?? "";
    fetch("/api/worlds", { headers: { "x-user-id": userId } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { worlds?: WorldInfo[] | string[] } | null) => {
        if (!data?.worlds) return;
        // Support both the old string[] format and the new WorldInfo[] format
        const worlds = (data.worlds as Array<WorldInfo | string>).map((w) =>
          typeof w === "string" ? { name: w, locked: false, ownerId: null } : w
        );
        setServerWorlds(worlds);
      })
      .catch(() => {/* ignore network errors — server list is optional */});
  };

  useEffect(() => {
    setRecent(getRecentWorlds());
    fetchWorlds();
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

  // ── Lock / Unlock a world from the WorldSelect screen ──────────────────────
  const toggleLock = async (world: WorldInfo, e: React.MouseEvent) => {
    e.stopPropagation(); // don't enter the world
    const userId = localStorage.getItem("userId") ?? "";
    setLockBusy(world.name);
    try {
      const endpoint = world.locked ? "unlock" : "lock";
      const res = await fetch(`/api/world/${encodeURIComponent(world.name)}/${endpoint}`, {
        method: "POST",
        headers: { "x-user-id": userId, "Content-Type": "application/json" },
      });
      const data = await res.json() as { success?: boolean; error?: string; message?: string };
      if (!res.ok) {
        alert(data.error ?? "Request failed");
      } else {
        // Refresh the world list so the lock icon updates immediately
        fetchWorlds();
      }
    } catch {
      alert("Network error — try again.");
    } finally {
      setLockBusy(null);
    }
  };

  // Server worlds not already in recent list (avoid duplicates)
  const recentSet      = new Set(recent);
  const discoveryWorlds = serverWorlds.filter((w) => !recentSet.has(w.name));

  // Build enriched recent list — augmented with lock info from the server
  const worldInfoMap = new Map(serverWorlds.map((w) => [w.name, w]));
  const recentWorlds: WorldInfo[] = recent.map((name) =>
    worldInfoMap.get(name) ?? { name, locked: false, ownerId: null }
  );

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
            {input.length > 0 && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground font-mono">
                {input.length}/{MAX_LEN}
              </span>
            )}
          </div>

          {error && <p className="text-xs text-red-400 font-mono px-1">{error}</p>}

          <button
            type="submit"
            disabled={input.trim().length === 0}
            className="w-full bg-primary hover:bg-primary/90 text-black font-black text-sm uppercase tracking-widest py-3 rounded flex items-center justify-center gap-2 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            GO <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        {/* ── Recently visited worlds ─────────────────────────────────────── */}
        {recentWorlds.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
              <Clock className="w-3 h-3" />
              <span>Recent</span>
            </div>
            <div className="flex flex-col gap-2">
              {recentWorlds.map((world) => {
                const isOwner = world.ownerId === currentUserId && currentUserId !== 0;
                const busy    = lockBusy === world.name;
                return (
                  <div key={world.name} className="flex items-center gap-2">
                    {/* World entry button */}
                    <button
                      onClick={() => enterWorld(world.name)}
                      className="flex-1 bg-black/60 border border-border hover:border-primary/60 text-primary/80 hover:text-primary font-mono text-xs py-2 px-3 rounded uppercase tracking-wider text-left transition-all flex items-center gap-2 min-w-0"
                    >
                      {/* Lock icon shows lock status for all worlds */}
                      {world.locked && <Lock className="w-3 h-3 text-yellow-400 shrink-0" />}
                      <span className="truncate">{world.name}</span>
                    </button>

                    {/* Lock/Unlock toggle — only shown for worlds the current user owns */}
                    {isOwner && (
                      <button
                        onClick={(e) => toggleLock(world, e)}
                        disabled={busy}
                        title={world.locked ? "Unlock world" : "Lock world (costs 1 World Lock)"}
                        className={`shrink-0 border rounded p-1.5 transition-colors text-[10px] font-mono uppercase tracking-widest flex items-center gap-1 ${
                          world.locked
                            ? "border-yellow-500/60 text-yellow-400 hover:bg-yellow-500/20"
                            : "border-border text-muted-foreground hover:text-primary hover:border-primary/60"
                        } ${busy ? "opacity-40 cursor-not-allowed" : ""}`}
                      >
                        {busy ? "..." : world.locked
                          ? <><Unlock className="w-3 h-3" /> Unlock</>
                          : <><Lock   className="w-3 h-3" /> Lock</>
                        }
                      </button>
                    )}
                  </div>
                );
              })}
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
              {discoveryWorlds.slice(0, 6).map((world) => (
                <button
                  key={world.name}
                  onClick={() => enterWorld(world.name)}
                  className="bg-black/30 border border-border/40 hover:border-primary/40 text-muted-foreground hover:text-primary/80 font-mono text-xs py-2 px-3 rounded uppercase tracking-wider text-left transition-all flex items-center gap-1.5 min-w-0"
                >
                  {world.locked && <Lock className="w-3 h-3 text-yellow-400 shrink-0" />}
                  <span className="truncate">{world.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── Tip ─────────────────────────────────────────────────────────── */}
        <p className="text-center text-[10px] text-muted-foreground/50 font-mono">
          Each world has unique terrain seeded by its name.
          <br />Share a name with a friend to play together!
          <br />Buy a <span className="text-yellow-400">World Lock</span> from the Store to secure yours.
        </p>

      </div>
    </div>
  );
}
