// ============================================================
// LeaderboardWindow.tsx — compact floating leaderboard panel
//
// Shows the global top-10 rankings and pool timer inside the
// game view. Toggled from the HUD so players can check ranks
// without navigating away from the canvas.
// ============================================================

import { X, Trophy, Clock, DollarSign } from "lucide-react";
import { useGetLeaderboard, useGetPoolStatus } from "@workspace/api-client-react";

type LeaderboardWindowProps = {
  onClose: () => void;
};

export default function LeaderboardWindow({ onClose }: LeaderboardWindowProps) {
  const { data: board } = useGetLeaderboard({ query: { refetchInterval: 15000 } });
  const { data: pool  } = useGetPoolStatus({ query: { refetchInterval: 15000 } });

  // Time-remaining breakdown for the payout countdown
  const nextSec   = pool?.nextPayoutIn ?? 0;
  const hours     = Math.floor(nextSec / 3600);
  const minutes   = Math.floor((nextSec % 3600) / 60);

  // Top 10 only in the compact view
  const entries = (board as unknown as Array<{ username: string; gems: number; windowPoints: number; rank?: number }> | undefined)?.slice(0, 10) ?? [];

  return (
    <div className="w-64 bg-black/96 border border-accent/40 rounded-lg shadow-[0_0_20px_rgba(34,211,238,0.12)] font-mono text-xs pointer-events-auto select-none">

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-accent/20">
        <div className="flex items-center gap-1.5">
          <Trophy className="w-3 h-3 text-accent" />
          <span className="text-accent font-bold uppercase tracking-widest text-[10px]">Leaderboard</span>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-white transition-colors">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Pool strip */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-accent/5 border-b border-accent/15">
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground uppercase">
          <DollarSign className="w-2.5 h-2.5 text-accent" />
          Pool
          <span className="text-white font-bold ml-1">${pool?.currentPool?.toFixed(2) ?? "0.00"}</span>
        </div>
        <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
          <Clock className="w-2.5 h-2.5 text-accent" />
          <span className="text-white font-bold tabular-nums">{hours}h {minutes}m</span>
        </div>
      </div>

      {/* Rankings */}
      <div className="max-h-52 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="text-center text-muted-foreground text-[10px] py-4 italic">
            No rankings yet
          </div>
        ) : (
          entries.map((entry, i) => {
            const rank  = entry.rank ?? i + 1;
            const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

            return (
              <div
                key={entry.username}
                className={`flex items-center justify-between px-3 py-1 border-b border-border/30 ${
                  rank <= 3 ? "bg-accent/5" : ""
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-[10px] shrink-0">{medal}</span>
                  <span className="text-white text-[10px] truncate font-bold">{entry.username}</span>
                </div>
                <div className="flex flex-col items-end shrink-0 ml-2">
                  <span className="text-primary text-[9px] font-bold">{entry.gems} 💎</span>
                  <span className="text-muted-foreground text-[8px]">{Math.floor(entry.windowPoints)} pts</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
