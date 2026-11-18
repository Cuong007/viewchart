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
const cspAnchor = '  "https://sepolia-rollup.arbitrum.io",\n];';
const cspOrigins = [
  '  "https://sepolia-rollup.arbitrum.io",',
  '  "https://api.binance.com",',
  '  "https://data-api.binance.vision",',
  '  "https://stream.binance.com:9443",',
  '  "wss://stream.binance.com:9443",',
  '];',
].join("\n");
if (!csp.includes('"wss://stream.binance.com:9443"')) {
  if (!csp.includes(cspAnchor)) throw new Error("Could not find CSP connect-origin anchor.");
  csp = csp.replace(cspAnchor, cspOrigins);
}
csp = csp.replace(
  'return u.protocol === "https:" || u.protocol === "http:" ? u.origin : undefined;',
  'return ["https:", "http:", "wss:", "ws:"].includes(u.protocol) ? u.origin : undefined;',
);
writeFileSync(cspPath, csp);

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

console.log("Applied OpenCharts mobile tools and Android network compatibility patches.");
