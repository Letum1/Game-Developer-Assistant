// ============================================================
// Leaderboard.tsx — Revenue pool standings & live competitive metrics.
// Mobile: compact table (hides Rig Lvl + Window Pts columns),
//         reduced cell padding, truncated usernames.
// Desktop: full table with all columns.
// ============================================================

import { useGetLeaderboard, useGetPoolStatus, getGetLeaderboardQueryKey, getGetPoolStatusQueryKey } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trophy, Clock, DollarSign, Award } from "lucide-react";

export default function Leaderboard() {
  const { data: leaderboard } = useGetLeaderboard({
    query: { refetchInterval: 10000, queryKey: getGetLeaderboardQueryKey() },
  });
  const { data: poolStatus } = useGetPoolStatus({
    query: { refetchInterval: 10000, queryKey: getGetPoolStatusQueryKey() },
  });

  const nextPayout = poolStatus?.nextPayoutIn ?? 0;
  const hours      = Math.floor(nextPayout / 3600);
  const minutes    = Math.floor((nextPayout % 3600) / 60);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="p-4 md:p-8 space-y-6 max-w-6xl mx-auto font-mono overflow-y-auto h-full"
    >
      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
          Global Ranks
        </h1>
        <p className="text-muted-foreground text-xs sm:text-sm tracking-widest uppercase mt-1">
          Live Competitive Metrics &amp; Revenue Pool
        </p>
      </div>

      {/* ── Revenue Pool Banner ─────────────────────────────────────────── */}
      <Card className="border-accent/30 bg-accent/5 overflow-hidden relative shadow-[0_0_30px_rgba(34,211,238,0.1)]">
        {/* Subtle grid lines decoration */}
        <div className="absolute inset-0 pointer-events-none opacity-20 bg-[linear-gradient(90deg,rgba(34,211,238,0.2)_1px,transparent_1px)] bg-[length:20px_100%]" />

        <CardContent className="p-4 md:p-8 flex flex-col sm:flex-row items-center justify-between gap-4 relative z-10">
          {/* Pool total */}
          <div className="flex-1 space-y-1 text-center sm:text-left">
            <div className="text-accent uppercase tracking-widest text-xs flex items-center justify-center sm:justify-start">
              <DollarSign className="w-3 h-3 mr-1" /> Active Revenue Pool
            </div>
            <div className="text-3xl sm:text-5xl font-black text-white tracking-tighter tabular-nums drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">
              ${poolStatus?.currentPool?.toFixed(2) ?? "0.00"}
            </div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-widest">
              Distribution: {poolStatus?.userCut ?? 0}% Players / {poolStatus?.houseCut ?? 0}% System
            </div>
          </div>

          {/* Countdown */}
          <div className="bg-black/60 border border-accent/30 rounded p-3 sm:p-4 text-center min-w-[150px]">
            <div className="text-accent uppercase tracking-widest text-[10px] flex items-center justify-center mb-1">
              <Clock className="w-3 h-3 mr-1" /> Next Payout In
            </div>
            <div className="text-2xl sm:text-3xl font-black text-white tabular-nums">
              {hours}h : {String(minutes).padStart(2, "0")}m
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Leaderboard Table ────────────────────────────────────────────── */}
      <Card className="border-border bg-sidebar/50 backdrop-blur">
        <CardHeader className="border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <CardTitle className="text-white uppercase tracking-widest text-base sm:text-lg flex items-center">
            <Trophy className="w-4 h-4 mr-2 text-primary" /> Top Operatives
          </CardTitle>
        </CardHeader>

        {/* overflow-x-auto so the table can scroll horizontally on very small screens */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-[10px] sm:text-xs uppercase bg-black/50 text-muted-foreground border-b border-border">
              <tr>
                {/* Rank — always visible */}
                <th className="px-3 py-2 sm:px-6 sm:py-4 font-bold tracking-widest">Rank</th>
                {/* Callsign — always visible */}
                <th className="px-3 py-2 sm:px-6 sm:py-4 font-bold tracking-widest">Callsign</th>
                {/* Gems — always visible */}
                <th className="px-3 py-2 sm:px-6 sm:py-4 font-bold tracking-widest text-right">Gems</th>
                {/* Rig Lvl — hidden on mobile to save space */}
                <th className="hidden sm:table-cell px-6 py-4 font-bold tracking-widest text-right">Rig Lvl</th>
                {/* Window Pts — hidden on mobile */}
                <th className="hidden sm:table-cell px-6 py-4 font-bold tracking-widest text-right">Window Pts</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard?.map((entry, idx) => (
                <tr
                  key={entry.username}
                  className={`border-b border-border/50 hover:bg-white/5 transition-colors ${idx < 3 ? "bg-primary/5" : ""}`}
                >
                  {/* Rank */}
                  <td className="px-3 py-2 sm:px-6 sm:py-4 whitespace-nowrap">
                    <span className={`font-black text-base sm:text-lg ${
                      idx === 0 ? "text-yellow-400 drop-shadow-[0_0_5px_rgba(250,204,21,0.8)]"
                      : idx === 1 ? "text-gray-300"
                      : idx === 2 ? "text-amber-700"
                      : "text-muted-foreground"
                    }`}>
                      #{entry.rank}
                    </span>
                  </td>

                  {/* Callsign — truncated to prevent email addresses blowing out the table */}
                  <td className="px-3 py-2 sm:px-6 sm:py-4 font-bold text-white">
                    <div className="flex items-center gap-1 min-w-0">
                      {idx === 0 && <Award className="w-3 h-3 sm:w-4 sm:h-4 text-yellow-400 shrink-0" />}
                      {/* max-w keeps long emails from overflowing; truncate adds ellipsis */}
                      <span className="max-w-[110px] sm:max-w-[220px] truncate block" title={entry.username}>
                        {entry.username}
                      </span>
                    </div>
                  </td>

                  {/* Gems */}
                  <td className="px-3 py-2 sm:px-6 sm:py-4 whitespace-nowrap text-right font-bold text-primary tabular-nums">
                    {entry.gems.toLocaleString()}
                  </td>

                  {/* Rig Lvl — desktop only */}
                  <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap text-right text-muted-foreground tabular-nums">
                    {entry.minerLevel}
                  </td>

                  {/* Window Pts — desktop only */}
                  <td className="hidden sm:table-cell px-6 py-4 whitespace-nowrap text-right text-accent font-bold tabular-nums">
                    {entry.windowPoints.toLocaleString()}
                  </td>
                </tr>
              ))}

              {(!leaderboard || leaderboard.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground uppercase tracking-widest text-xs">
                    No data available in current sector
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

    </motion.div>
  );
}
