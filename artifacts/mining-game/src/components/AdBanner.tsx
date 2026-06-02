/**
 * AdBanner.tsx — Adsterra compact 468×60 iframe banner
 *
 * Renders a single fixed-height (60px) display banner at the bottom of every page.
 * The native banner format was removed because it renders large image cards that
 * overflow the layout and cover game content.
 *
 * The Social Bar + Popunder are handled separately in index.html.
 *
 * To swap the ad unit:
 *   1. Log into beta.publishers.adsterra.com → Sites → Ad Units
 *   2. Copy the new key + invoke.js URL
 *   3. Update BANNER_KEY and BANNER_INVOKE below and redeploy
 */

import { useEffect, useRef } from "react";

// ── Banner 468×60 — compact iframe display banner ─────────────────────────────
const BANNER_KEY    = "df53d771dc3c13f7975d3f17b514e0ce";
const BANNER_INVOKE = "https://www.highperformanceformat.com/df53d771dc3c13f7975d3f17b514e0ce/invoke.js";

export default function AdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const injectedRef  = useRef(false);

  useEffect(() => {
    // Guard against React strict-mode double-invocation in development
    if (injectedRef.current || !containerRef.current) return;
    injectedRef.current = true;

    // atOptions config script must appear immediately before the invoke script
    const configScript      = document.createElement("script");
    configScript.type       = "text/javascript";
    configScript.text       = `
      atOptions = {
        'key'    : '${BANNER_KEY}',
        'format' : 'iframe',
        'height' : 60,
        'width'  : 468,
        'params' : {}
      };
    `;
    containerRef.current.appendChild(configScript);

    const invokeScript          = document.createElement("script");
    invokeScript.type           = "text/javascript";
    invokeScript.src            = BANNER_INVOKE;
    invokeScript.async          = true;
    invokeScript.setAttribute("data-cfasync", "false");
    containerRef.current.appendChild(invokeScript);
  }, []);

  return (
    // Strict 60px height — overflow hidden so the ad can NEVER grow taller than this
    // and push content upward. bg-black/80 matches the dark game aesthetic.
    <div
      className="w-full flex items-center justify-center bg-black/80 border-t border-border"
      style={{ height: 60, overflow: "hidden", flexShrink: 0 }}
      aria-label="Advertisement"
    >
      <div ref={containerRef} style={{ width: 468, height: 60, maxWidth: "100%", overflow: "hidden" }} />
    </div>
  );
}
