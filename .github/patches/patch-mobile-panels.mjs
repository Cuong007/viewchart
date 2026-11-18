import { readFileSync, writeFileSync } from "node:fs";

const path = "src/pages/TradingPage.tsx";
let source = readFileSync(path, "utf8");

if (source.includes("OpenCharts mobile tools drawer")) {
  console.log("Mobile tools drawer already applied.");
  process.exit(0);
}

const stateAnchor = '  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);';
if (!source.includes(stateAnchor)) throw new Error("Could not find mobile panel state anchor.");
source = source.replace(stateAnchor, stateAnchor + '\n  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);');

const anchor = '      {/* ── Mobile Trading Panel (small screens only) ──── */}';
if (!source.includes(anchor)) throw new Error("Could not find mobile trading panel anchor.");

const mobileTools = [
'      {/* OpenCharts mobile tools drawer: expose panels hidden by the desktop-only sidebar. */}',
'      <div className="md:hidden fixed bottom-2 left-2 right-20 z-40 flex items-center gap-1 rounded-xl border border-border bg-card/95 p-1 shadow-lg backdrop-blur">',
'        {([',
'          ["watchlist", "Mã"],',
'          ["dom", "DOM"],',
'          ["news", "Tin"],',
'          ["tv-analysis", "TA"],',
'        ] as const).map(([panel, label]) => (',
'          <button',
'            key={panel}',
'            type="button"',
'            onClick={() => { setRightPanel(panel); setMobileToolsOpen(true); }}',
'            className={"flex-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors " + (rightPanel === panel && mobileToolsOpen ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}',
'          >',
'            {label}',
'          </button>',
'        ))}',
'      </div>',
'',
'      {mobileToolsOpen && (',
'        <div className="md:hidden fixed inset-0 z-[60] bg-black/50" onClick={() => setMobileToolsOpen(false)}>',
'          <section',
'            className="absolute inset-x-0 bottom-0 flex h-[78vh] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl safe-area-bottom"',
'            onClick={(event) => event.stopPropagation()}',
'            aria-label="OpenCharts mobile tools"',
'          >',
'            <div className="flex items-center justify-between border-b border-border px-4 py-3">',
'              <span className="text-sm font-semibold">',
'                {rightPanel === "watchlist" ? "Danh sách mã" : rightPanel === "dom" ? "Sổ lệnh DOM" : rightPanel === "news" ? "Tin thị trường" : "Phân tích kỹ thuật"}',
'              </span>',
'              <button type="button" onClick={() => setMobileToolsOpen(false)} className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted">Đóng</button>',
'            </div>',
'            <div className="min-h-0 flex-1 overflow-y-auto">',
'              {rightPanel === "dom" && <DOMPanel symbol={selectedSymbol} tick={tick} />}',
'              {rightPanel === "watchlist" && (',
'                <WatchlistPanel',
'                  symbols={symbols}',
'                  ticks={ticks}',
'                  selectedSymbol={selectedSymbol}',
'                  onSelect={(symbol) => { setSelectedSymbol(symbol); setMobileToolsOpen(false); }}',
'                  oneClick={oneClick}',
'                  accountId={activeAccountId}',
'                  isFeedConnected={isFeedConnected}',
'                />',
'              )}',
'              {rightPanel === "news" && <div className="space-y-2 p-2"><MarketNewsFeed symbol={selectedSymbol} /></div>}',
'              {rightPanel === "tv-analysis" && (',
'                <TradingViewTechnicalAnalysis symbol={selectedSymbol} theme={isDark ? "dark" : "light"} interval={timeframe} width="100%" height="100%" />',
'              )}',
'            </div>',
'          </section>',
'        </div>',
'      )}',
'',
].join('\n');

source = source.replace(anchor, mobileTools + '\n' + anchor);
writeFileSync(path, source);

// Android network compatibility: explicitly permit Binance REST + secure WebSocket.
const cspPath = "src/hyperliquid/compliance/csp.ts";
let csp = readFileSync(cspPath, "utf8");
csp = csp.replace(
  'return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;',
  'return ["https:", "http:", "wss:", "ws:"].includes(u.protocol) ? u.origin : undefined;',
);
writeFileSync(cspPath, csp);
 
// Replace the synthetic Binance DOM ladder with the exchange's live top-20 depth stream.
const domPath = "src/pages/trading/DOMPanel.tsx";
let dom = readFileSync(domPath, "utf8");
if (!dom.includes("function BinanceDOMPanel")) {
  dom = dom.replace(
    'import { lazy, Suspense, useMemo } from "react";',
    'import { lazy, Suspense, useEffect, useMemo, useState } from "react";',
  );
  const panelAnchor = '  return <SimulatedDOMPanel {...props} />;';
  if (!dom.includes(panelAnchor)) throw new Error("Could not find DOM panel fallback anchor.");
  dom = dom.replace(panelAnchor, '  return <BinanceDOMPanel symbol={props.symbol} />;');
  const component = `
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
`;
  const insertAt = 'function SimulatedDOMPanel(';
  if (!dom.includes(insertAt)) throw new Error("Could not find DOM component insertion point.");
  dom = dom.replace(insertAt, component + "\n" + insertAt);
  const simulatedIndex = dom.indexOf("\nfunction SimulatedDOMPanel(");
  if (simulatedIndex >= 0) dom = dom.slice(0, simulatedIndex) + "\n";
  dom = dom.replace('import { lazy, Suspense, useEffect, useMemo, useState } from "react";', 'import { lazy, Suspense, useEffect, useState } from "react";');
  dom = dom.replace('import { formatNumber, cn } from "../../lib/utils.ts";', 'import { formatNumber } from "../../lib/utils.ts";');
  const syntheticStart = dom.indexOf("/**\n * Deterministic pseudo-random depth");
  const panelStart = dom.indexOf("export function DOMPanel", syntheticStart);
  if (syntheticStart >= 0 && panelStart >= 0) dom = dom.slice(0, syntheticStart) + dom.slice(panelStart);
  writeFileSync(domPath, dom);
}

// Normalize tick-size powers of ten to decimal precision (avoid 0.000099999999…).
const symbolsPath = "src/hyperliquid/symbols.ts";
let symbols = readFileSync(symbolsPath, "utf8");
symbols = symbols.replace("return 10 ** -decimals;", "return Number((10 ** -decimals).toFixed(decimals));");
if (!symbols.includes("return Number((10 ** -decimals).toFixed(decimals));")) {
  throw new Error("Could not normalize Hyperliquid tick-size precision.");
}
writeFileSync(symbolsPath, symbols);

// Use Binance's public market-data mirror for REST candles/quotes. The
// official WebSocket remains the live tick transport.
const binancePath = "examples/binance-adapter/binance-adapter.ts";
let binance = readFileSync(binancePath, "utf8");
if (!binance.includes('DOGEUSD: { pair: "DOGEUSDT"')) {
  if (!binance.includes("  XRPUSD: { pair: \"XRPUSDT\", label: \"XRP\", tickSize: 0.0001 },")) throw new Error("Could not find Binance symbol-map anchor.");
  binance = binance.replace("  XRPUSD: { pair: \"XRPUSDT\", label: \"XRP\", tickSize: 0.0001 },", "  XRPUSD: { pair: \"XRPUSDT\", label: \"XRP\", tickSize: 0.0001 },\n  DOGEUSD: { pair: \"DOGEUSDT\", label: \"Dogecoin\", tickSize: 0.00001 },\n  LTCUSD: { pair: \"LTCUSDT\", label: \"Litecoin\", tickSize: 0.01 },\n  TRXUSD: { pair: \"TRXUSDT\", label: \"TRON\", tickSize: 0.0001 },\n  LINKUSD: { pair: \"LINKUSDT\", label: \"Chainlink\", tickSize: 0.001 },\n  AVAXUSD: { pair: \"AVAXUSDT\", label: \"Avalanche\", tickSize: 0.001 },\n  DOTUSD: { pair: \"DOTUSDT\", label: \"Polkadot\", tickSize: 0.001 },\n  BCHUSD: { pair: \"BCHUSDT\", label: \"Bitcoin Cash\", tickSize: 0.01 },\n  UNIUSD: { pair: \"UNIUSDT\", label: \"Uniswap\", tickSize: 0.001 },\n  NEARUSD: { pair: \"NEARUSDT\", label: \"NEAR Protocol\", tickSize: 0.001 },\n  APTUSD: { pair: \"APTUSDT\", label: \"Aptos\", tickSize: 0.001 },\n  ARBUSD: { pair: \"ARBUSDT\", label: \"Arbitrum\", tickSize: 0.0001 },\n  OPUSD: { pair: \"OPUSDT\", label: \"Optimism\", tickSize: 0.0001 },\n  SUIUSD: { pair: \"SUIUSDT\", label: \"Sui\", tickSize: 0.0001 },\n  TONUSD: { pair: \"TONUSDT\", label: \"Toncoin\", tickSize: 0.001 },\n  PEPEUSD: { pair: \"PEPEUSDT\", label: \"Pepe\", tickSize: 0.00000001 },\n  SHIBUSD: { pair: \"SHIBUSDT\", label: \"Shiba Inu\", tickSize: 0.00000001 },\n  XLMUSD: { pair: \"XLMUSDT\", label: \"Stellar\", tickSize: 0.0001 },\n  ETCUSD: { pair: \"ETCUSDT\", label: \"Ethereum Classic\", tickSize: 0.001 },");
}

binance = binance.replace(
  'const REST_BASE = "https://api.binance.com/api/v3";',
  'const REST_BASE = "https://data-api.binance.vision/api/v3";',
);
const pollingStateAnchor = '  let closedByUs = false;\n\n  const setState =';
const pollingStatePatch = [
  '  let closedByUs = false;',
  '  let pollTimer: ReturnType<typeof setInterval> | null = null;',
  '  let pollInFlight = false;',
  '',
  '  const stopPolling = () => {',
  '    if (pollTimer) clearInterval(pollTimer);',
  '    pollTimer = null;',
  '  };',
  '',
  '  const pollQuotes = async () => {',
  '    if (pollInFlight || closedByUs) return;',
  '    pollInFlight = true;',
  '    try {',
  '      const results = await Promise.all(names.map(async (name) => {',
  '        const pair = toBinancePair(name);',
  '        if (!pair) return false;',
  '        const response = await doFetch(`${REST_BASE}/ticker/bookTicker?symbol=${pair}`);',
  '        if (!response.ok) return false;',
  '        const quote = await response.json() as { bidPrice?: string; askPrice?: string };',
  '        if (quote.bidPrice == null || quote.askPrice == null) return false;',
  '        emit({ type: "tick", symbol: name, bid: Number(quote.bidPrice), ask: Number(quote.askPrice), timestamp: Date.now() });',
  '        return true;',
  '      }));',
  '      setState(results.some(Boolean) ? "connected" : "reconnecting");',
  '    } catch {',
  '      setState("reconnecting");',
  '    } finally {',
  '      pollInFlight = false;',
  '    }',
  '  };',
  '',
  '  const startPolling = () => {',
  '    if (pollTimer || closedByUs) return;',
  '    void pollQuotes();',
  '    pollTimer = setInterval(() => void pollQuotes(), 3000);',
  '  };',
  '',
  '  const setState =',
].join("\n");
if (!binance.includes('let pollTimer: ReturnType<typeof setInterval> | null = null;')) {
  if (!binance.includes(pollingStateAnchor)) throw new Error("Could not find Binance polling-state anchor.");
  binance = binance.replace(pollingStateAnchor, pollingStatePatch);
}
binance = binance.replace(
  '    socket.onopen = () => {\n      reconnectAttempt = 0;',
  '    socket.onopen = () => {\n      stopPolling();\n      reconnectAttempt = 0;',
);
binance = binance.replace(
  '      setState("reconnecting");\n      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);',
  '      setState("reconnecting");\n      startPolling();\n      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);',
);
binance = binance.replace(
  '      if (reconnectTimer) clearTimeout(reconnectTimer);\n      reconnectTimer = null;',
  '      if (reconnectTimer) clearTimeout(reconnectTimer);\n      stopPolling();\n      reconnectTimer = null;',
);
writeFileSync(binancePath, binance);



// Improve the generic watchlist for touch devices: searchable display names,
// visible touch quick-trade controls, and an explicit empty state.
const watchlistPath = "src/pages/trading/WatchlistPanel.tsx";
let watchlist = readFileSync(watchlistPath, "utf8");
watchlist = watchlist.replace(
  'if (filter && !s.name.toLowerCase().includes(filter.toLowerCase())) return false;',
  'if (filter && !s.name.toLowerCase().includes(filter.toLowerCase()) && !(s.displayName || "").toLowerCase().includes(filter.toLowerCase())) return false;',
);
watchlist = watchlist.replace(
  'className="hidden group-hover:flex flex-col gap-0.5 ml-1"',
  'className="flex flex-col gap-0.5 ml-1 md:opacity-0 md:group-hover:opacity-100"',
);
watchlist = watchlist.replace(
  '                className={cn(\n                  "shrink-0 mr-1",',
  '                aria-label={isFav ? "Remove " + s.name + " from favorites" : "Add " + s.name + " to favorites"}\n                className={cn(\n                  "shrink-0 mr-1",',
);
const listAnchor = '        {filtered.map((s) => {';
if (watchlist.includes(listAnchor) && !watchlist.includes('No instruments match your filter')) {
  watchlist = watchlist.replace(
    listAnchor,
    '        {filtered.length === 0 && (\n          <div className="px-3 py-8 text-center text-xs text-muted-foreground">No instruments match your filter.</div>\n        )}\n        {filtered.map((s) => {',
  );
}
writeFileSync(watchlistPath, watchlist);



// Install live TradingView news timeline in both the side panel and bottom tab.
// The official embed avoids unreliable public RSS proxies and requires no API key.
const widgetsPath = "src/components/TradingViewWidgets.tsx";
let widgets = readFileSync(widgetsPath, "utf8");
if (!widgets.includes("export const TradingViewTimeline")) {
  const anchor = "// ── Mini Chart Widget ───────────────────────────────────────";
  if (!widgets.includes(anchor)) throw new Error("Could not find TradingView widget insertion point.");
  const timeline = `
 // ── News Timeline Widget ─────────────────────────────────────
interface TradingViewTimelineProps {
  symbol?: string;
  theme: "dark" | "light";
  height?: number | string;
  className?: string;
}

export const TradingViewTimeline = memo(function TradingViewTimeline({
  symbol = "BINANCE:BTCUSDT",
  theme,
  height = 520,
  className = "",
}: TradingViewTimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTradingViewAllowed() || !containerRef.current) return;
    const container = containerRef.current;
    safeClear(container);

    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    widgetDiv.style.height = "100%";
    widgetDiv.style.width = "100%";
    container.appendChild(widgetDiv);

    const config = {
      feedMode: "symbol",
      symbol: mapSymbol(symbol),
      isTransparent: true,
      displayMode: "regular",
      width: "100%",
      height: "100%",
      colorTheme: theme,
      locale: "en",
    };

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-timeline.js";
    script.type = "text/javascript";
    script.async = true;
    script.textContent = JSON.stringify(config);
    container.appendChild(script);

    return () => safeClear(container);
  }, [symbol, theme]);

  return (
    <div
      ref={containerRef}
      className={`tradingview-widget-container ${className}`}
      style={{ height: typeof height === "number" ? `${height}px` : height, width: "100%" }}
      aria-label={`Live market news for ${symbol}`}
    />
  );
});

`;
  widgets = widgets.replace(anchor, timeline + anchor);
}
writeFileSync(widgetsPath, widgets);

// Replace the right-side sample headlines with a clearly attributed live widget.
const powerPath = "src/components/TradingPowerFeatures.tsx";
let power = readFileSync(powerPath, "utf8");
const newsMarker = "// ── News feed (sample data)";
const newsStart = power.indexOf(newsMarker);
if (newsStart >= 0) {
  power = power.slice(0, newsStart) + `
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Newspaper } from "lucide-react";
import { TradingViewTimeline } from "./TradingViewWidgets.tsx";

export function NewsFeed({
  symbol,
  theme = "dark",
}: {
  symbol: string;
  theme?: "dark" | "light";
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-accent" />
          Market News
          <span className="ml-auto text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
            Live feed
          </span>
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          Headlines and market stories for {symbol}, provided by TradingView.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <TradingViewTimeline symbol={symbol} theme={theme} height={520} />
      </CardContent>
    </Card>
  );
}
`;
  power = power.replace('import { Clock, Globe } from "lucide-react";\nimport { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";\nimport { cn } from "@/lib/utils";\n', "");
  writeFileSync(powerPath, power);
}

// Replace the bottom-panel sample news list with the same live provider.
const bottomPath = "src/pages/trading/BottomPanel.tsx";
let bottom = readFileSync(bottomPath, "utf8");
if (!bottom.includes("TradingViewTimeline")) {
  bottom = bottom.replace(
    '  TradingViewEconomicCalendar,\n  isTradingViewAllowed,',
    '  TradingViewEconomicCalendar,\n  TradingViewTimeline,\n  isTradingViewAllowed,',
  );
  const feedStart = bottom.indexOf("// ── News Feed ────────────────────────────────────────────────");
  if (feedStart < 0) throw new Error("Could not find bottom-panel news feed.");
  bottom = bottom.slice(0, feedStart) + `// ── Live News Feed ───────────────────────────────────────────
function NewsFeed() {
  return (
    <div className="h-full min-h-[360px] overflow-y-auto">
      <div className="px-3 py-1.5 bg-secondary/40 text-[10px] text-muted-foreground">
        Live market headlines provided by TradingView. Stories are informational, not trading advice.
      </div>
      <TradingViewTimeline symbol="BINANCE:BTCUSDT" theme="dark" height={520} />
    </div>
  );
}
`;
  writeFileSync(bottomPath, bottom);
}
console.log("Installed live TradingView news timeline in OpenCharts panels.");

console.log("Applied OpenCharts mobile tools and Android network compatibility patches.");
