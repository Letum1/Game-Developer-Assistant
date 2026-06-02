# Adsterra Ad Units — MineVault

Dashboard: https://beta.publishers.adsterra.com  
Website registered: `game-developer-assistant-api-server-git-main-letum1s-projects.vercel.app`

---

## 1. Smartlink (Rewarded Ads — popup)

Used by the in-game "Watch Ad" buttons. The server returns this URL and the
client opens it in a popup window. Configured in:
`artifacts/api-server/src/routes/monetization.ts` → `AD_URL`

```
https://www.effectivecpmnetwork.com/jh72a2xr?key=4b8ea0885e0edebf30ad4b1234ebcc20
```

---

## 2. Popunder

Fires once per session on the first user interaction. Paste in `<head>`.
**Currently embedded in:** `artifacts/mining-game/index.html`

```html
<script src="https://pl29614133.effectivecpmnetwork.com/b4/8f/7d/b48f7de69fdfe29e02092c3f75b57777.js"></script>
```

---

## 3. Social Bar

Sticky floating bar that appears at the bottom of every page.
Paste right before `</body>`.
**Currently embedded in:** `artifacts/mining-game/index.html`

```html
<script src="https://pl29614136.effectivecpmnetwork.com/b1/e9/e2/b1e9e232d69d8182e2912c14598aa953.js"></script>
```

---

## 4. Native Banner (4:1 widget)

Auto-adapts to look native. Can be placed anywhere in the page body.
Drop-in a React component like this:

```tsx
// NativeBanner.tsx
import { useEffect } from "react";

export function NativeBanner() {
  useEffect(() => {
    const script = document.createElement("script");
    script.async = true;
    script.setAttribute("data-cfasync", "false");
    script.src = "https://pl29614135.effectivecpmnetwork.com/cd20e544dce0ee39ac86e57bb6ff4c40/invoke.js";
    document.body.appendChild(script);
    return () => { document.body.removeChild(script); };
  }, []);
  return <div id="container-cd20e544dce0ee39ac86e57bb6ff4c40" />;
}
```

Raw HTML version:
```html
<script async="async" data-cfasync="false"
  src="https://pl29614135.effectivecpmnetwork.com/cd20e544dce0ee39ac86e57bb6ff4c40/invoke.js">
</script>
<div id="container-cd20e544dce0ee39ac86e57bb6ff4c40"></div>
```

---

## 5. Banner 468×60 (iframe)

Classic display banner. Paste the two tags together in any page body location.

```html
<script>
atOptions = {
  'key'    : 'df53d771dc3c13f7975d3f17b514e0ce',
  'format' : 'iframe',
  'height' : 60,
  'width'  : 468,
  'params' : {}
};
</script>
<script src="https://www.highperformanceformat.com/df53d771dc3c13f7975d3f17b514e0ce/invoke.js"></script>
```

---

## Notes

- **One popunder per page** — Adsterra enforces this; adding a second one breaks both.
- The Social Bar is global (sticks to the bottom) — no need to repeat it per page.
- For the rewarded-ad popup, the Smartlink URL must only be opened **synchronously**
  inside a user-gesture handler (button click) or iOS Safari will block it as a popup.
- The Native Banner and 468×60 Banner can be placed on lower-traffic pages (Miner dashboard,
  Store, Leaderboard) without affecting the game canvas performance.
