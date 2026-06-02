/**
 * AdBanner.tsx — Adsterra display banners (Native + 468×60 iframe)
 *
 * Renders two ad units stacked:
 *   1. Native Banner — auto-adapts to look native, served from pl29614135.*
 *   2. 468×60 iframe Banner — classic display banner from highperformanceformat.com
 *
 * Both scripts are injected once on mount (guarded against React strict-mode
 * double-invocation). The Social Bar + Popunder live in index.html — do NOT
 * add them here or Adsterra will suppress one of them.
 *
 * To update ad codes:
 *   1. Log into beta.publishers.adsterra.com
 *   2. Go to Sites → Ad Units → copy the new script src / key
 *   3. Update the constants below and re-deploy
 */

import { useEffect, useRef } from "react";

// ── Native Banner — auto-adaptive (4:1 ratio) ─────────────────────────────────
// Script injects into the div with id matching NATIVE_CONTAINER_ID.
const NATIVE_INVOKE_SRC  = "https://pl29614135.effectivecpmnetwork.com/cd20e544dce0ee39ac86e57bb6ff4c40/invoke.js";
const NATIVE_CONTAINER_ID = "container-cd20e544dce0ee39ac86e57bb6ff4c40";

// ── Banner 468×60 — classic iframe display banner ─────────────────────────────
// Needs an atOptions config block THEN the invoke script immediately after.
const BANNER_468_KEY    = "df53d771dc3c13f7975d3f17b514e0ce";
const BANNER_468_INVOKE = "https://www.highperformanceformat.com/df53d771dc3c13f7975d3f17b514e0ce/invoke.js";

export default function AdBanner() {
  const nativeRef   = useRef<HTMLDivElement>(null);
  const banner468Ref = useRef<HTMLDivElement>(null);
  const injectedRef  = useRef(false);

  useEffect(() => {
    // Guard against React strict-mode double-invocation in development
    if (injectedRef.current) return;
    injectedRef.current = true;

    // ── 1. Native Banner ─────────────────────────────────────────────────────
    // Just inject the script — Adsterra finds the div by its id automatically.
    if (nativeRef.current) {
      const nativeScript         = document.createElement("script");
      nativeScript.async         = true;
      nativeScript.setAttribute("data-cfasync", "false");
      nativeScript.src           = NATIVE_INVOKE_SRC;
      document.body.appendChild(nativeScript);
    }

    // ── 2. Banner 468×60 (iframe format) ─────────────────────────────────────
    // atOptions config script must come IMMEDIATELY before the invoke script.
    if (banner468Ref.current) {
      const configScript       = document.createElement("script");
      configScript.type        = "text/javascript";
      configScript.text        = `
        atOptions = {
          'key'    : '${BANNER_468_KEY}',
          'format' : 'iframe',
          'height' : 60,
          'width'  : 468,
          'params' : {}
        };
      `;
      banner468Ref.current.appendChild(configScript);

      const invokeScript           = document.createElement("script");
      invokeScript.type            = "text/javascript";
      invokeScript.src             = BANNER_468_INVOKE;
      invokeScript.async           = true;
      invokeScript.setAttribute("data-cfasync", "false");
      banner468Ref.current.appendChild(invokeScript);
    }
  }, []);

  return (
    // ── Wrapper — dark background matches game aesthetic ───────────────────────
    // min-h-[60px] reserves layout space before ads load.
    // overflow-hidden prevents expanded ads from breaking surrounding layout.
    <div
      className="w-full flex flex-col items-center justify-center gap-1 bg-black/80 border-t border-border overflow-hidden py-1"
      style={{ minHeight: 60 }}
      aria-label="Advertisement"
    >
      {/* Native Banner — auto-adapts to width, sits on top */}
      <div
        id={NATIVE_CONTAINER_ID}
        ref={nativeRef}
        className="w-full flex items-center justify-center"
      />

      {/* 468×60 iframe Banner — classic display banner */}
      <div
        ref={banner468Ref}
        className="flex items-center justify-center"
        style={{ width: 468, height: 60, maxWidth: "100%" }}
      />
    </div>
  );
}
