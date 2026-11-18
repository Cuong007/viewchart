import { useEffect } from "react";
import { getAdapter } from "../adapter/registry.ts";
import { mark } from "../services/demo/engine.ts";
import { useTradingStore } from "../services/store.tsx";
export function AdapterMarketDataBridge() {
  const updateTick=useTradingStore(s=>s.updateTick), updateCandle=useTradingStore(s=>s.updateCandleFromWs);
  useEffect(()=>getAdapter().marketData.subscribe(event=>{
    if(event.type==="tick") {
      updateTick(event.symbol,event.bid,event.ask,event.timestamp??Date.now());
      // The built-in paper engine must consume the same live price stream as the chart.
      // This also enables instruments whose candles/quotes come from a host adapter.
      if(getAdapter().name === "demo" && !useTradingStore.getState().isReplaying) {
        mark(event.symbol, (event.bid + event.ask) / 2);
      }
    }
    else if(event.type==="candle"){
      updateCandle(event.symbol,event.timeframe,{open:event.open,high:event.high,low:event.low,close:event.close,volume:event.volume,timestamp:event.timestamp});
      updateTick(event.symbol,event.close,event.close,event.timestamp);
    }
  }),[updateTick,updateCandle]);
  return null;
}
