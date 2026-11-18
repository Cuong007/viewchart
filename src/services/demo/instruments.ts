import type { Symbol } from "../schemas.ts";

/**
 * Demo instruments. These mirror the crypto pairs whose real historical OHLC
 * is bundled under ./data (see scripts/fetch-demo-data.mjs). Quoted in USD.
 */
function crypto(name: string, displayName: string, tickSize: number): Symbol {
  return {
    id: name,
    name,
    displayName,
    category: "CRYPTO",
    contractSize: 1,
    tickSize,
    tickValue: tickSize,
    marginPercent: 1,
    maxLeverage: 100,
    commission: 0,
    swapLong: 0,
    swapShort: 0,
    tradingHoursStart: null,
    tradingHoursEnd: null,
    isActive: true,
  };
}

export const DEMO_SYMBOLS: Symbol[] = [
  crypto("BTCUSD", "Bitcoin", 0.01),
  crypto("ETHUSD", "Ethereum", 0.01),
  crypto("SOLUSD", "Solana", 0.01),
  crypto("BNBUSD", "BNB", 0.01),
  crypto("XRPUSD", "XRP", 0.0001),
  crypto("ADAUSD", "Cardano", 0.0001),
  {
    ...crypto("PAXGUSD", "PAX Gold (1 oz)", 0.01),
    category: "COMMODITIES",
    maxLeverage: 20,
  },
  {
    ...crypto("VN30F1M", "VN30F1M Futures", 0.1),
    category: "INDICES",
    maxLeverage: 20,
  },
];

/** Only instruments with bundled historical replay data are fed by demo/feed.ts. */
export const DEMO_FEED_SYMBOLS: Symbol[] = DEMO_SYMBOLS.filter(
  (s) => !["PAXGUSD", "VN30F1M"].includes(s.name),
);

export const DEMO_SYMBOL_NAMES = DEMO_SYMBOLS.map((s) => s.name);

export function getDemoSymbol(name: string): Symbol | undefined {
  return DEMO_SYMBOLS.find((s) => s.name === name);
}
