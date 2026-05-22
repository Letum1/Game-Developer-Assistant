import { useGetLeaderboard, useGetPoolStatus, getGetLeaderboardQueryKey, getGetPoolStatusQueryKey } from "@workspace/api-client-react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trophy, Clock, DollarSign, Users, Award } from "lucide-react";

export default function Leaderboard() {
  const { data: leaderboard } = useGetLeaderboard({ query: { refetchInterval: 10000, queryKey: getGetLeaderboardQueryKey() } });
  const { data: poolStatus } = useGetPoolStatus({ query: { refetchInterval: 10000, queryKey: getGetPoolStatusQueryKey() } });

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 space-y-8 max-w-6xl mx-auto font-mono">
      
      <div>
        <h1 className="text-3xl font-black text-primary tracking-tighter uppercase drop-shadow-[0_0_8px_rgba(34,197,94,0.5)]">
          Global Ranks
        </h1>
        <p className="text-muted-foreground text-sm tracking-widest uppercase mt-1">Live Competitive Metrics & Revenue Pool</p>
      </div>

      {/* Revenue Pool Banner */}
      <Card className="border-accent/30 bg-accent/5 overflow-hidden relative shadow-[0_0_30px_rgba(34,211,238,0.1)]">
        <div className="absolute inset-0 pointer-events-none opacity-20 bg-[linear-gradient(90deg,rgba(34,211,238,0.2)_1px,transparent_1px)] bg-[length:20px_100%]" />
        <CardContent className="p-6 md:p-8 flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
          <div className="flex-1 space-y-2 text-center md:text-left">
             <div className="text-accent uppercase tracking-widest text-sm flex items-center justify-center md:justify-start">
                <DollarSign className="w-4 h-4 mr-1" /> Active Revenue Pool
             </div>
             <div className="text-4xl md:text-6xl font-black text-white tracking-tighter tabular-nums drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">
               ${poolStatus?.currentPool?.toFixed(2) || "0.00"}
             </div>
             <div className="text-muted-foreground text-xs uppercase tracking-widest">
               Distribution: {poolStatus?.userCut || 0}% Players / {poolStatus?.houseCut || 0}% System
             </div>
          </div>
          
          <div className="bg-black/60 border border-accent/30 rounded p-4 text-center min-w-[200px]">
             <div className="text-accent uppercase tracking-widest text-xs flex items-center justify-center mb-2">
                <Clock className="w-3 h-3 mr-1" /> Next Payout In
             </div>
             <div className="text-3xl font-black text-white tabular-nums">
               {Math.floor((poolStatus?.nextPayoutIn || 0) / 3600)}h : {Math.floor(((poolStatus?.nextPayoutIn || 0) % 3600) / 60)}m
             </div>
          </div>
        </CardContent>
      </Card>

      {/* Leaderboard Table */}
      <Card className="border-border bg-sidebar/50 backdrop-blur">
        <CardHeader className="border-b border-border">
          <CardTitle className="text-white uppercase tracking-widest text-lg flex items-center">
            <Trophy className="w-5 h-5 mr-2 text-primary" /> Top Operatives
          </CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-xs uppercase bg-black/50 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-6 py-4 font-bold tracking-widest">Rank</th>
                <th className="px-6 py-4 font-bold tracking-widest">Callsign</th>
                <th className="px-6 py-4 font-bold tracking-widest text-right">Gems</th>
                <th className="px-6 py-4 font-bold tracking-widest text-right">Rig Lvl</th>
                <th className="px-6 py-4 font-bold tracking-widest text-right">Window Pts</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard?.map((entry, idx) => (
                <tr key={entry.username} className={`border-b border-border/50 hover:bg-white/5 transition-colors ${idx < 3 ? 'bg-primary/5' : ''}`}>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className={`font-black text-lg ${idx === 0 ? 'text-yellow-400 drop-shadow-[0_0_5px_rgba(250,204,21,0.8)]' : idx === 1 ? 'text-gray-300' : idx === 2 ? 'text-amber-700' : 'text-muted-foreground'}`}>
                      #{entry.rank}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap font-bold text-white flex items-center">
                    {idx === 0 && <Award className="w-4 h-4 mr-2 text-yellow-400" />}
                    {entry.username}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right font-bold text-primary tabular-nums">
                    {entry.gems.toLocaleString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-muted-foreground tabular-nums">
                    {entry.minerLevel}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-accent font-bold tabular-nums">
                    {entry.windowPoints.toLocaleString()}
                  </td>
                </tr>
              ))}
              {(!leaderboard || leaderboard.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-muted-foreground uppercase tracking-widest">
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
