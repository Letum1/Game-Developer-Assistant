import { useQuery } from "@tanstack/react-query";

async function fetchBtcPrice(): Promise<number> {
  const res = await fetch("/api/btc-price");
  if (!res.ok) throw new Error("Failed to fetch BTC price");
  const data = (await res.json()) as { price: number };
  return data.price;
}

export function useBtcPrice() {
  const { data } = useQuery({
    queryKey: ["btc-price"],
    queryFn: fetchBtcPrice,
    refetchInterval: 60_000,
    staleTime: 55_000,
  });
  return data ?? null;
}

export function satoshiToUsd(satoshis: number, btcUsdPrice: number): string {
  const usd = (satoshis / 100_000_000) * btcUsdPrice;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}
