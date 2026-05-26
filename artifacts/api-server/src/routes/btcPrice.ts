import { Router } from "express";

const router = Router();

let cached: { price: number; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

router.get("/btc-price", async (_req, res) => {
  try {
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      res.json({ price: cached.price });
      return;
    }

    const response = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=1d",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Yahoo Finance responded with ${response.status}`);
    }

    const data = (await response.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> };
    };

    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price || typeof price !== "number") {
      throw new Error("Could not parse BTC price from Yahoo Finance response");
    }

    cached = { price, fetchedAt: Date.now() };
    res.json({ price });
  } catch (err) {
    const fallback = cached?.price ?? null;
    if (fallback !== null) {
      res.json({ price: fallback, stale: true });
    } else {
      res.status(502).json({ error: "Failed to fetch BTC price" });
    }
  }
});

export default router;
