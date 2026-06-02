/**
 * AdBanner.tsx — Adsterra sticky bottom banner ad
 *
 * Injects the Adsterra Social Bar / banner script once on mount.
 * To update the ad code:
 *   1. Log into your Adsterra dashboard
 *   2. Go to Sites → Ad Units → choose "Social Bar" or "Banner 728x90 / 320x50"
 *   3. Copy the generated <script> tag
 *   4. Replace the script src and atOptions key below
 *
 * The container is always rendered so Adsterra's script has a target element.
 * On mobile the banner sits just above the bottom nav tab (z-index 15).
 * On desktop it sits at the very bottom of the main content column.
 */

import { useEffect, useRef } from "react";

// ── Adsterra banner configuration ─────────────────────────────────────────────
// Replace these values with the ones from your Adsterra ad unit dashboard.
// key:    the unique identifier for this ad unit
// format: "iframe" | "auto"  (use "iframe" for fixed-size banners)
// height/width: banner dimensions (320x50 = mobile, 728x90 = desktop leaderboard)
const BANNER_KEY    = "4b8ea0885e0edebf30ad4b1234ebcc20"; // replace with your banner key
const BANNER_INVOKE = "//www.effectivecpmnetwork.com/jh72a2xr/invoke.js"; // replace with your invoke.js URL

export default function AdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const injectedRef  = useRef(false);

  useEffect(() => {
    // Only inject once — React strict-mode runs effects twice in dev, guard against that
    if (injectedRef.current || !containerRef.current) return;
    injectedRef.current = true;

    // ── Inject atOptions config script ────────────────────────────────────────
    const configScript = document.createElement("script");
    configScript.type  = "text/javascript";
    configScript.text  = `
      atOptions = {
        'key'    : '${BANNER_KEY}',
        'format' : 'iframe',
        'height' : 50,
        'width'  : 320,
        'params' : {}
      };
    `;
    containerRef.current.appendChild(configScript);

    // ── Inject Adsterra invoke script ─────────────────────────────────────────
    const invokeScript    = document.createElement("script");
    invokeScript.type     = "text/javascript";
    invokeScript.src      = BANNER_INVOKE;
    invokeScript.async    = true;
    invokeScript.setAttribute("data-cfasync", "false");
    containerRef.current.appendChild(invokeScript);
  }, []);

  return (
    // ── Banner wrapper ─────────────────────────────────────────────────────────
    // min-h-[50px] reserves layout space even before the ad loads.
    // overflow-hidden prevents the ad from expanding beyond its container.
    // bg-black/80 gives a dark background that matches the game aesthetic.
    <div
      className="w-full flex items-center justify-center bg-black/80 border-t border-border overflow-hidden"
      style={{ minHeight: 50 }}
      aria-label="Advertisement"
    >
      <div ref={containerRef} className="flex items-center justify-center" />
    </div>
  );
}
