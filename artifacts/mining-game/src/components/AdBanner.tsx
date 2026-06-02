/**
 * AdBanner.tsx — Adsterra compact 468×60 iframe banner
 *
 * Renders a single fixed-height (60px) display banner at the bottom of every page.
 * The Social Bar + Popunder are handled separately in index.html.
 *
 * ── DOMAIN NOTE ────────────────────────────────────────────────────────────────
 * Adsterra only serves ads to the domain registered in their dashboard.
 * If ads are blank, log into beta.publishers.adsterra.com → Sites → Add New Site,
 * register your current domain, then update BANNER_KEY and BANNER_INVOKE below.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * To swap the ad unit:
 *   1. Log into beta.publishers.adsterra.com → Sites → Ad Units
 *   2. Copy the new key + invoke.js URL
 *   3. Update BANNER_KEY and BANNER_INVOKE below and redeploy
 */

import { useEffect, useRef, useState } from "react";

// ── Banner 468×60 — compact iframe display banner ─────────────────────────────
// Update these two values when you register the new domain in Adsterra.
const BANNER_KEY    = "df53d771dc3c13f7975d3f17b514e0ce";
const BANNER_INVOKE = "https://www.highperformanceformat.com/df53d771dc3c13f7975d3f17b514e0ce/invoke.js";

// How long (ms) to wait for the ad iframe to appear before hiding the banner bar.
// Adsterra injects an <iframe> into the container almost instantly when the domain
// is registered; if nothing appears within this window the domain is unregistered
// or the user has an ad blocker and we collapse the bar to reclaim the space.
const AD_TIMEOUT_MS = 3000;

export default function AdBanner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const injectedRef  = useRef(false);
  // visible: true while we wait + while an ad is showing. false once we confirm no fill.
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    // Guard against React strict-mode double-invocation in development
    if (injectedRef.current || !containerRef.current) return;
    injectedRef.current = true;

    const container = containerRef.current;

    // atOptions config script must appear immediately before the invoke script
    const configScript    = document.createElement("script");
    configScript.type     = "text/javascript";
    configScript.text     = `
      atOptions = {
        'key'    : '${BANNER_KEY}',
        'format' : 'iframe',
        'height' : 60,
        'width'  : 468,
        'params' : {}
      };
    `;
    container.appendChild(configScript);

    const invokeScript = document.createElement("script");
    invokeScript.type  = "text/javascript";
    invokeScript.src   = BANNER_INVOKE;
    invokeScript.async = true;
    invokeScript.setAttribute("data-cfasync", "false");
    container.appendChild(invokeScript);

    // Poll for the injected iframe — if Adsterra fills the slot an <iframe> appears
    // inside the container. If the timeout fires with nothing, collapse the bar.
    const deadline = Date.now() + AD_TIMEOUT_MS;
    const timer = setInterval(() => {
      const hasAd = container.querySelector("iframe") !== null;
      if (hasAd) {
        clearInterval(timer);
        return; // ad filled — stay visible
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        setVisible(false); // no ad — collapse bar
      }
    }, 200);

    return () => clearInterval(timer);
  }, []);

  // Collapse entirely when no ad loaded — frees the 60px so content isn't cut off
  if (!visible) return null;

  return (
    // Strict 60px height — overflow hidden so the ad can NEVER grow taller than this
    // and push content upward. bg-black/80 matches the dark game aesthetic.
    <div
      className="w-full flex items-center justify-center bg-black/80 border-t border-border"
      style={{ height: 60, overflow: "hidden", flexShrink: 0 }}
      aria-label="Advertisement"
    >
      <div
        ref={containerRef}
        style={{ width: 468, height: 60, maxWidth: "100%", overflow: "hidden" }}
      />
    </div>
  );
}
