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
console.log("Applied OpenCharts mobile tools drawer.");
