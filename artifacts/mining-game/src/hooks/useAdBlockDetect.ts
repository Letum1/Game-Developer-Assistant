// ============================================================
// useAdBlockDetect.ts — React hook for adblocker detection
//
// Runs detectAdBlock() once on mount, then:
//   1. Sets `adBlockDetected` state
//   2. Reports the result to POST /api/adblock-report so the
//      admin panel can identify which users have adblockers
//
// Usage:
//   const adBlockDetected = useAdBlockDetect();
//   if (adBlockDetected) { /* show overlay, block mining, etc. */ }
// ============================================================

import { useState, useEffect } from "react";
import { detectAdBlock } from "../lib/adblock-detect";

/**
 * Detects adblockers on mount and reports the result to the server.
 * Returns the latest detected state (initially false until detection runs).
 */
export function useAdBlockDetect(): boolean {
  const [adBlockDetected, setAdBlockDetected] = useState(false);

  useEffect(() => {
    let cancelled = false;

    detectAdBlock().then((detected) => {
      if (cancelled) return;
      setAdBlockDetected(detected);

      // Report to server — fire-and-forget (don't block the UI on this)
      const userId = localStorage.getItem("userId");
      if (!userId) return;

      fetch("/api/adblock-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": userId,
        },
        body: JSON.stringify({ detected }),
      }).catch(() => {
        // Intentionally swallow — if the user has an adblocker they may also
        // block this request; we handle it gracefully on the client side anyway.
      });
    });

    return () => { cancelled = true; };
  }, []);

  return adBlockDetected;
}
