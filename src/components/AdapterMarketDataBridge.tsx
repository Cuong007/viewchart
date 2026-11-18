import { useEffect } from "react";
import { getAdapter } from "../adapter/registry.ts";
import { useTradingStore } from "../services/store.tsx";

/** Forwards the installed adapter's live stream into the terminal's shared market store. */
export function AdapterMarketDataBridge() {
  const updateTick = useTradingStore((state) => state.updateTick);
  const updateCandle = useTradingStore((state) => state.updateCandleFromWs);
  useEffect(() => {
    const source = getAdapter().marketData;
    return source.subscribe((event) => {
      if (event.type === "tick") {
        updateTick(event.symbol, event.bid, event.ask, event.timestamp ?? Date.now());
      } else if (event.type === "candle") {
        updateCandle(event.symbol, event.timeframe, {
          open: event.open, high: event.high, low: event.low, close: event.close,
          volume: event.volume, timestamp: event.timestamp,
        });
        updateTick(event.symbol, event.close, event.close, event.timestamp);
      }
    });
  }, [updateTick, updateCandle]);
  return null;
}
