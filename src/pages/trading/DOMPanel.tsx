import { lazy, Suspense, useEffect, useState } from "react";
import { formatNumber } from "../../lib/utils.ts";
import { isHyperliquidMode } from "../../hyperliquid/ui/mode.ts";

// Live brokers show the real book; loaded on demand so the demo bundle is unchanged.
const HlDepthPanel = lazy(() =>
  import("../../hyperliquid/ui/HlDepthPanel.tsx").then((m) => ({ default: m.HlDepthPanel })),
);

export function DOMPanel(props: { symbol: string; tick?: { bid: number; ask: number } }) {
  if (isHyperliquidMode()) {
    return (
      <Suspense fallback={null}>
        <HlDepthPanel symbol={props.symbol} />
      </Suspense>
    );
  }
  return <BinanceDOMPanel symbol={props.symbol} />;
}


type BinanceDepth = { bids: [string, string][]; asks: [string, string][]; lastUpdateId?: number };

function BinanceDOMPanel({ symbol }: { symbol: string }) {
  const pair = symbol.replace(/USD$/, "USDT").toLowerCase();
  const [book, setBook] = useState<BinanceDepth | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const endpoint = "https://data-api.binance.vision/api/v3/depth?symbol=" + pair.toUpperCase() + "&limit=20";
    const loadSnapshot = async () => {
      try {
        const response = await fetch(endpoint);
        if (!response.ok) throw new Error("Depth snapshot unavailable");
        const data = await response.json() as BinanceDepth;
        if (active) setBook(data);
      } catch {
        if (active) setConnected(false);
      }
    };
    void loadSnapshot();
    try {
      socket = new WebSocket("wss://stream.binance.com:9443/ws/" + pair + "@depth20@100ms");
      socket.onopen = () => { if (active) setConnected(true); };
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(String(event.data)) as BinanceDepth;
          if (active && Array.isArray(data.bids) && Array.isArray(data.asks)) {
            setBook({ bids: data.bids, asks: data.asks, lastUpdateId: data.lastUpdateId });
          }
        } catch { /* Ignore malformed depth frames. */ }
      };
      socket.onerror = () => { if (active) setConnected(false); };
      socket.onclose = () => { if (active) setConnected(false); };
    } catch {
      setConnected(false);
    }
    poll = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) void loadSnapshot();
    }, 3000);
    return () => {
      active = false;
      if (poll) clearInterval(poll);
      socket?.close();
    };
  }, [pair]);

  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const rows = Math.max(bids.length, asks.length, 1);
  const maxQty = Math.max(1, ...bids.map((x) => Number(x[1])), ...asks.map((x) => Number(x[1])));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Depth of Market · Binance</h3>
        <span className={connected ? "text-xs text-buy" : "text-xs text-muted-foreground"}>{connected ? "LIVE" : "Đang kết nối"}</span>
      </div>
      <div className="flex items-center justify-between px-3 py-1 text-[10px] text-muted-foreground">
        <span>{symbol.replace(/USD$/, "/USDT")}</span><span>{book ? "Top 20 levels" : "Đang tải order book…"}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 z-10 bg-card"><tr>
            <th className="w-[30%] text-right">Bid Qty</th><th className="w-[40%] text-center">Price</th><th className="w-[30%] text-left">Ask Qty</th>
          </tr></thead>
          <tbody>
            {Array.from({ length: rows }, (_, i) => {
              const ask = asks[i]; const bid = bids[i];
              return <tr key={i} className="relative hover:bg-secondary/50">
                <td className="relative text-right text-buy">
                  {bid && <><span className="relative z-[1]">{Number(bid[1]).toLocaleString(undefined, { maximumFractionDigits: 5 })}</span><div className="absolute inset-y-0 right-0 bg-buy/20" style={{ width: (Number(bid[1]) / maxQty * 100) + "%" }} /></>}
                </td>
                <td className="text-center font-mono">
                  {bid && <div className="text-buy">{formatNumber(Number(bid[0]), 8)}</div>}
                  {ask && <div className="text-sell">{formatNumber(Number(ask[0]), 8)}</div>}
                </td>
                <td className="relative text-left text-sell">
                  {ask && <><span className="relative z-[1]">{Number(ask[1]).toLocaleString(undefined, { maximumFractionDigits: 5 })}</span><div className="absolute inset-y-0 left-0 bg-sell/20" style={{ width: (Number(ask[1]) / maxQty * 100) + "%" }} /></>}
                </td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

