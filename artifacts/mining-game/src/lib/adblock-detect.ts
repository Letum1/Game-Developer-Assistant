// ============================================================
// adblock-detect.ts — Bait-element adblocker detection
//
// Strategy:
//   1. Insert a hidden <div> with CSS class names and IDs that common
//      adblocker filter lists (EasyList, uBlock) are known to target.
//   2. After a short delay, measure whether the element has been
//      collapsed (offsetParent === null or zero height/width).
//   3. Return true if the bait was hidden (= adblocker is active).
//
// This is purely heuristic — no method catches every adblocker.
// False-negative rate is low for common browser extensions.
// ============================================================

/**
 * Resolves with `true` if an adblocker appears to be active,
 * `false` if the bait element survived unharmed.
 *
 * @param delayMs - How long to wait before measuring (default 250ms).
 *                  Give the adblocker time to process the DOM.
 */
export function detectAdBlock(delayMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    // Create a bait element with names commonly targeted by filter lists
    const bait = document.createElement("div");
    bait.id = "ad-banner";
    bait.className =
      "ad ads adsbox doubleclick ad-placement carbon-ads ad_unit banner_ad sponsor";
    bait.setAttribute("aria-label", "Advertisement");

    // Make it technically visible so adblockers have a reason to hide it,
    // but visually off-screen so users never see it
    bait.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";

    document.body.appendChild(bait);

    setTimeout(() => {
      // Detection: the element is "hidden" if its dimensions collapsed to zero,
      // if it's been removed from the DOM, or if offsetParent is null
      // (which happens when display:none is applied to it or an ancestor).
      const hidden =
        !document.body.contains(bait) ||
        bait.offsetHeight === 0 ||
        bait.offsetWidth === 0 ||
        bait.offsetParent === null ||
        getComputedStyle(bait).display === "none" ||
        getComputedStyle(bait).visibility === "hidden";

      // Clean up — we don't want to pollute the DOM
      bait.remove();

      resolve(hidden);
    }, delayMs);
  });
}
