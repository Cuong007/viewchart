import { useState, useEffect, useRef } from "react";
import { BookOpen, Clock, Code2, Database, Globe, History, Newspaper, Pencil, Plus, Trash2, TrendingUp, X, Save, FolderOpen } from "lucide-react";
import { useAuthStore } from "../../services/store.tsx";
import { useTradingStore } from "../../services/store.tsx";
import { api } from "../../services/api.ts";
import {
  useCancelOrder,
  useClosePosition,
  useCloseAllPositions,
  useClosedPositions,
} from "../../services/queries.ts";
import type {
  JournalEntry,
  CreateJournalEntryInput,
  UpdateJournalEntryInput,
} from "../../services/api/journal.ts";
import type { Account, ClosedPosition, Order, Position } from "../../services/schemas.ts";
import { Button } from "../../components/ui/button.tsx";
import { TradeJournalPanel } from "../../components/TradingDialogs.tsx";
import {
  TradingViewEconomicCalendar,
  TradingViewTimeline,
  isTradingViewAllowed,
} from "../../components/TradingViewWidgets.tsx";
import { toast } from "../../services/toast.ts";
import { formatCurrency, formatNumber, formatDate, cn, pnlClass } from "../../lib/utils.ts";
import { MOCK_EVENTS } from "./constants.ts";
import { PositionsTable } from "./PositionsTable.tsx";
import { OrdersTable } from "./OrdersTable.tsx";
import { computeLivePnl, computeLivePrice } from "../../lib/livePnl.ts";
import { safeStorage } from "../../lib/safe-storage.ts";
import { isHyperliquidMode } from "../../hyperliquid/ui/mode.ts";
import { INDICATOR_REGISTRY, type CustomIndicatorDefinition, type IndicatorType } from "../../lib/indicators.ts";

type TradingActionError = {
  error?: { message?: string };
  message?: string;
};

/** Closed positions from adapters that report the platform fee separately (Hyperliquid). */
type ClosedWithPlatformFee = ClosedPosition & { platformFee?: number };

type AccountOption = Pick<Account, "id"> & { label?: string | null };

function getErrorMessage(error: unknown): string {
  const actionError = error as TradingActionError;
  return actionError.error?.message || actionError.message || "Request failed";
}

export interface BottomPanelProps {
  tab: "positions" | "orders" | "history" | "journal" | "calendar" | "news" | "indicators" | "indicator-code" | "data-sources";
  onTabChange: (t: "positions" | "orders" | "history" | "journal" | "calendar" | "news" | "indicators" | "indicator-code" | "data-sources") => void;
  activeIndicators: IndicatorType[];
  onToggleIndicator: (type: IndicatorType) => void;
  indicatorParams: Record<IndicatorType, Record<string, number>>;
  onIndicatorParamChange: (type: IndicatorType, key: string, value: number) => void;
  indicatorCodeOverrides: Partial<Record<IndicatorType, string>>;
  customIndicators: CustomIndicatorDefinition[];
  onSaveIndicatorCode: (type: IndicatorType, code: string) => void;
  onSaveCustomIndicator: (name: string, code: string, id?: string) => void;
  onDeleteIndicator: (type: IndicatorType) => void;
  onDeleteCustomIndicator: (id: string) => void;
  onToggleCustomIndicator: (id: string) => void;
  positions: Position[];
  orders: Order[];
  accountId: string | null;
  onModifyPosition?: (position: Position) => void;
  onModifyOrder?: (order: Order) => void;
  onSelectPositionSymbol?: (symbolName: string) => void;
  onSelectOrderSymbol?: (symbolName: string) => void;
  journalEntries: JournalEntry[];
  journalLoading: boolean;
  onCreateJournal: (data: CreateJournalEntryInput) => void;
  onUpdateJournal: (id: string, data: UpdateJournalEntryInput) => void;
  onDeleteJournal: (id: string) => void;
  height?: number;
  isFeedConnected?: boolean;
}


type ManagedDataSource = { id: string; name: string; provider: string; endpoint: string; enabled: boolean };
type ManagedInstrument = { symbol: string; name: string; assetClass: string; sourceId: string };

function DataSourcesPanel() {
  const sourceKey = "opencharts_managed_data_sources_v1";
  const instrumentKey = "opencharts_managed_instruments_v1";
  const [sources, setSources] = useState<ManagedDataSource[]>(() => {
    try { return JSON.parse(safeStorage.getItem(sourceKey) || "[]"); } catch { return []; }
  });
  const [instruments, setInstruments] = useState<ManagedInstrument[]>(() => {
    try {
      const saved = JSON.parse(safeStorage.getItem(instrumentKey) || "null");
      return Array.isArray(saved) ? saved : [
        { symbol: "XAUUSD", name: "Vàng giao ngay", assetClass: "Kim loại", sourceId: "" },
        { symbol: "VN30F1M", name: "Hợp đồng tương lai VN30 tháng gần nhất", assetClass: "Phái sinh Việt Nam", sourceId: "" },
      ];
    } catch { return []; }
  });
  const [name, setName] = useState("");
  const [kind, setKind] = useState("REST API");
  const [endpoint, setEndpoint] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [symbol, setSymbol] = useState("");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("Kim loại");
  const saveSources = (v: ManagedDataSource[]) => { setSources(v); safeStorage.setJSON(sourceKey, v); };
  const saveInstruments = (v: ManagedInstrument[]) => { setInstruments(v); safeStorage.setJSON(instrumentKey, v); window.dispatchEvent(new Event("opencharts:instruments-updated")); };
  const saveSource = () => {
    if (!name.trim() || !endpoint.trim()) { toast.warning("Thiếu thông tin", "Hãy nhập tên nguồn và endpoint."); return; }
    const id = editing || crypto.randomUUID();
    const row = { id, name: name.trim(), provider: kind, endpoint: endpoint.trim(), enabled: true };
    saveSources(editing ? sources.map(s => s.id === id ? row : s) : [...sources, row]);
    setName(""); setEndpoint(""); setEditing(null);
    toast.success("Đã lưu", "Cấu hình nguồn đã được lưu trên thiết bị.");
  };
  const addSymbol = () => {
    const code = symbol.trim().toUpperCase();
    if (!code) { toast.warning("Thiếu mã", "Nhập mã như XAUUSD hoặc VN30F1M."); return; }
    if (instruments.some(i => i.symbol === code)) { toast.warning("Mã đã tồn tại", code + " đã có trong danh mục."); return; }
    saveInstruments([...instruments, { symbol: code, name: label.trim() || code, assetClass: category, sourceId: "" }]);
    setSymbol(""); setLabel("");
  };
  return <div className="p-3 space-y-4 text-xs">
    <div><h3 className="font-semibold text-sm">Quản lý nguồn dữ liệu thị trường</h3><p className="text-muted-foreground mt-1">Khai báo nhà cung cấp và danh mục thị trường ngoài crypto. Cấu hình được lưu trên thiết bị.</p></div>
    <section className="rounded-lg border border-border p-3 space-y-3">
      <div className="font-semibold">{editing ? "Sửa nguồn dữ liệu" : "Thêm nguồn dữ liệu"}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="space-y-1"><span className="text-muted-foreground">Tên nguồn</span><input value={name} onChange={e=>setName(e.target.value)} placeholder="Ví dụ: Twelve Data, SSI..." className="w-full rounded border border-border bg-background px-2 py-2"/></label>
        <label className="space-y-1"><span className="text-muted-foreground">Loại kết nối</span><select value={kind} onChange={e=>setKind(e.target.value)} className="w-full rounded border border-border bg-background px-2 py-2"><option>REST API</option><option>WebSocket</option><option>CSV / URL dữ liệu</option><option>TradingView</option><option>Broker API</option></select></label>
        <label className="space-y-1 sm:col-span-2"><span className="text-muted-foreground">Endpoint / URL</span><input value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder="https://api.example.com/..." className="w-full rounded border border-border bg-background px-2 py-2"/></label>
      </div>
      <div className="flex gap-2"><Button size="sm" onClick={saveSource}><Plus className="h-3 w-3 mr-1"/>Lưu nguồn</Button>{editing && <Button size="sm" variant="outline" onClick={()=>{setEditing(null);setName("");setEndpoint("");}}>Hủy</Button>}</div>
    </section>
    <section className="space-y-2"><div className="font-semibold">Nguồn đã khai báo</div>
      {sources.length===0 ? <p className="rounded border border-dashed border-border p-4 text-center text-muted-foreground">Chưa có nguồn bổ sung. Binance hiện tại tiếp tục hoạt động như nguồn crypto mặc định.</p> : sources.map(s=><div key={s.id} className="flex flex-wrap items-center gap-2 rounded border border-border p-3">
        <div className="min-w-0 flex-1"><div className="font-medium">{s.name}</div><div className="break-all text-muted-foreground">{s.provider} · {s.endpoint}</div></div>
        <label className="flex items-center gap-1"><input type="checkbox" checked={s.enabled} onChange={e=>saveSources(sources.map(x=>x.id===s.id?{...x,enabled:e.target.checked}:x))}/> Bật</label>
        <Button size="sm" variant="outline" onClick={()=>{setEditing(s.id);setName(s.name);setKind(s.provider);setEndpoint(s.endpoint);}}>Sửa</Button>
        <Button size="sm" variant="ghost" onClick={()=>{if(confirm("Xóa nguồn "+s.name+"?")){saveSources(sources.filter(x=>x.id!==s.id));saveInstruments(instruments.map(i=>i.sourceId===s.id?{...i,sourceId:""}:i));}}}><Trash2 className="h-3 w-3"/></Button>
      </div>)}
    </section>
    <section className="rounded-lg border border-border p-3 space-y-3">
      <div><div className="font-semibold">Danh mục mã thị trường</div><p className="mt-1 text-muted-foreground">Có sẵn XAUUSD và VN30F1M để cấu hình nguồn giá; có thể thêm mã khác.</p></div>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <input value={symbol} onChange={e=>setSymbol(e.target.value)} placeholder="Mã: XAUUSD" className="rounded border border-border bg-background px-2 py-2"/>
        <input value={label} onChange={e=>setLabel(e.target.value)} placeholder="Tên hiển thị" className="rounded border border-border bg-background px-2 py-2"/>
        <select value={category} onChange={e=>setCategory(e.target.value)} className="rounded border border-border bg-background px-2 py-2"><option>Kim loại</option><option>Chỉ số</option><option>Phái sinh Việt Nam</option><option>Forex</option><option>Cổ phiếu</option><option>Hàng hóa</option><option>Khác</option></select>
        <Button size="sm" onClick={addSymbol}><Plus className="h-3 w-3 mr-1"/>Thêm mã</Button>
      </div>
      <div className="divide-y divide-border">{instruments.map(i=><div key={i.symbol} className="flex flex-wrap items-center gap-2 py-2">
        <div className="min-w-0 flex-1"><span className="font-semibold">{i.symbol}</span><span className="ml-2 text-muted-foreground">{i.name} · {i.assetClass}</span></div>
        <select aria-label={"Nguồn cho "+i.symbol} value={i.sourceId} onChange={e=>saveInstruments(instruments.map(x=>x.symbol===i.symbol?{...x,sourceId:e.target.value}:x))} className="max-w-40 rounded border border-border bg-background px-2 py-1"><option value="">Chưa gán nguồn</option>{sources.filter(s=>s.enabled).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button aria-label={"Xóa "+i.symbol} onClick={()=>saveInstruments(instruments.filter(x=>x.symbol!==i.symbol))} className="rounded p-1 hover:bg-secondary"><X className="h-3 w-3"/></button>
      </div>)}</div>
    </section>
    <p className="text-muted-foreground">Lưu ý: tab này hiện quản lý cấu hình nguồn và mã. Muốn hiển thị nến/giá trực tiếp của XAUUSD hoặc VN30F1M, cần tích hợp adapter đúng API và định dạng dữ liệu của nhà cung cấp; chỉ nhập URL không tự tạo ra feed giá.</p>
  </div>;
}

export function BottomPanel({
  tab,
  onTabChange,
  positions,
  orders,
  accountId,
  onModifyPosition,
  onModifyOrder,
  onSelectPositionSymbol,
  onSelectOrderSymbol,
  journalEntries,
  journalLoading,
  onCreateJournal,
  onUpdateJournal,
  onDeleteJournal,
  height = 220,
  isFeedConnected = true,
  activeIndicators,
  onToggleIndicator,
  indicatorParams,
  onIndicatorParamChange,
  indicatorCodeOverrides,
  customIndicators,
  onSaveIndicatorCode,
  onSaveCustomIndicator,
  onDeleteIndicator,
  onDeleteCustomIndicator,
  onToggleCustomIndicator,
}: BottomPanelProps) {
  const isDemo = useAuthStore((s) => s.isDemo);
  const [editingIndicator, setEditingIndicator] = useState<IndicatorType | null>(null);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [isNewCustom, setIsNewCustom] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorCode, setEditorCode] = useState("");
  const [loadedJournalSnapshot, setLoadedJournalSnapshot] = useState<JournalEntry[] | null>(null);
  const journalSessionKey = "opencharts_trade_journal_session_" + (accountId || "none");
  const [journalSessionStart, setJournalSessionStart] = useState<number>(() => Number(safeStorage.getItem(journalSessionKey) || 0));
  useEffect(() => { setJournalSessionStart(Number(safeStorage.getItem(journalSessionKey) || 0)); setLoadedJournalSnapshot(null); }, [journalSessionKey]);
  const visibleJournalEntries = journalSessionStart ? journalEntries.filter((entry) => Date.parse(entry.createdAt) >= journalSessionStart) : journalEntries;
  const startNewJournal = () => { if (!window.confirm("Tạo nhật ký mới? Nhật ký cũ sẽ được ẩn khỏi phiên thử nghiệm này nhưng không bị xóa.")) return; const startedAt = Date.now(); safeStorage.setItem(journalSessionKey, String(startedAt)); setJournalSessionStart(startedAt); setLoadedJournalSnapshot(null); toast.success("Đã tạo nhật ký mới", "Dữ liệu cũ được giữ nguyên và tách khỏi phiên thử nghiệm mới."); };
  const beginEditIndicator = (type: IndicatorType) => {
    const templates: Partial<Record<IndicatorType, string>> = {
      SMA: "(candles, params) => {\n  const period = params.period || 20;\n  const result = [];\n  for (let i = period - 1; i < candles.length; i++) {\n    const slice = candles.slice(i - period + 1, i + 1);\n    const value = slice.reduce((sum, candle) => sum + candle.close, 0) / period;\n    result.push({ time: candles[i].time, value });\n  }\n  return result;\n}",
      EMA: "(candles, params) => {\n  const period = params.period || 20;\n  const k = 2 / (period + 1);\n  const result = [];\n  let value = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;\n  for (let i = period - 1; i < candles.length; i++) {\n    if (i >= period) value = candles[i].close * k + value * (1 - k);\n    result.push({ time: candles[i].time, value });\n  }\n  return result;\n}",
      RSI: "(candles, params) => {\n  const period = params.period || 14;\n  const result = [];\n  for (let i = period; i < candles.length; i++) {\n    let gain = 0, loss = 0;\n    for (let j = i - period + 1; j <= i; j++) {\n      const change = candles[j].close - candles[j - 1].close;\n      if (change > 0) gain += change; else loss -= change;\n    }\n    const rs = loss === 0 ? 100 : gain / loss;\n    result.push({ time: candles[i].time, value: 100 - 100 / (1 + rs) });\n  }\n  return result;\n}",
    };
    setEditingIndicator(type); setEditingCustomId(null); setIsNewCustom(false);
    setEditorName(type);
    setEditorCode(indicatorCodeOverrides[type] || templates[type] || "(candles, params) => {\n  // Return [{ time, value }]\n  return candles.map(c => ({ time: c.time, value: c.close }));\n}");
    onTabChange("indicator-code");
  };
  const beginEditCustom = (item: CustomIndicatorDefinition) => {
    setEditingIndicator(null); setEditingCustomId(item.id); setIsNewCustom(false);
    setEditorName(item.name); setEditorCode(item.code); onTabChange("indicator-code");
  };
  const beginNewCustom = () => {
    setEditingIndicator(null); setEditingCustomId(null); setIsNewCustom(true);
    setEditorName("Chỉ báo mới"); setEditorCode(""); onTabChange("indicator-code");
  };
  const saveCode = () => {
    if (!editorCode.trim()) { toast.warning("Thiếu mã", "Hãy nhập code chỉ báo trước khi lưu."); return; }
    // Hỗ trợ hai dạng code:
    // 1) Biểu thức hàm tính toán: (candles, params) => [{ time, value }]
    // 2) Module overlay tự khởi tạo API, ví dụ file FVGIndicator.js (IIFE/script).
    // Không được bọc dạng script trong "return (...)" vì dấu ; cuối file sẽ
    // khiến parser báo lỗi dù file JavaScript hoàn toàn hợp lệ.
    let expressionError: unknown = null;
    try {
      new Function("candles", "params", "return (" + editorCode + "\n);");
    } catch (error) {
      expressionError = error;
      try {
        new Function(editorCode);
      } catch (scriptError) {
        const message = scriptError instanceof Error ? scriptError.message
          : expressionError instanceof Error ? expressionError.message : "Lỗi cú pháp JavaScript";
        toast.error("Code không hợp lệ", message);
        return;
      }
    }
    if (editingIndicator) onSaveIndicatorCode(editingIndicator, editorCode);
    else if (editingCustomId) onSaveCustomIndicator(editorName, editorCode, editingCustomId);
    else if (isNewCustom) onSaveCustomIndicator(editorName, editorCode);
    setEditingIndicator(null); setEditingCustomId(null); setIsNewCustom(false);
    toast.success("Đã lưu", "Mã chỉ báo đã được lưu."); onTabChange("indicators");
  };
  const cancelOrder = useCancelOrder();
  const closePosition = useClosePosition();
  const closeAllPositions = useCloseAllPositions();
  const accounts = useTradingStore((s) => s.accounts as AccountOption[]);
  const activeAccount = accounts.find((account) => account.id === accountId);

  const handleCancel = (orderId: string) => {
    if (!accountId || isDemo) {
      if (isDemo) toast.warning("Demo Mode", "Trading actions are disabled in demo mode");
      return;
    }
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot cancel orders while disconnected");
      return;
    }
    if (cancelOrder.isPending) return;
    cancelOrder.mutate(
      { orderId, accountId },
      {
        onSuccess: () => toast.info("Order Cancelled", "Pending order has been cancelled"),
        onError: (err: unknown) => toast.error("Cancel Failed", getErrorMessage(err)),
      },
    );
  };

  const handleClosePosition = (positionId: string) => {
    if (!accountId || isDemo) {
      if (isDemo) toast.warning("Demo Mode", "Trading actions are disabled in demo mode");
      return;
    }
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    if (closePosition.isPending) return;
    closePosition.mutate(
      { positionId, accountId },
      {
        onSuccess: () => toast.success("Position Closed", "Position has been closed"),
        onError: (err: unknown) => toast.error("Close Failed", getErrorMessage(err)),
      },
    );
  };

  const handlePartialClose = (positionId: string, quantity: number) => {
    if (!accountId || isDemo) {
      if (isDemo) toast.warning("Demo Mode", "Trading actions are disabled in demo mode");
      return;
    }
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    if (closePosition.isPending) return;
    closePosition.mutate(
      { positionId, accountId, quantity },
      {
        onSuccess: () => toast.success("Partial Close", `Closed ${quantity} of the position`),
        onError: (err: unknown) => toast.error("Partial Close Failed", getErrorMessage(err)),
      },
    );
  };

  const handleCloseAll = () => {
    if (!accountId || isDemo) {
      if (isDemo) toast.warning("Demo Mode", "Trading actions are disabled in demo mode");
      return;
    }
    if (!isFeedConnected) {
      toast.warning("No Data Feed", "Cannot close positions while disconnected");
      return;
    }
    closeAllPositions.mutate(accountId, {
      onSuccess: () => toast.success("All Closed", "All positions have been closed"),
      onError: (err: unknown) => toast.error("Close All Failed", getErrorMessage(err)),
    });
  };

  const ticks = useTradingStore((s) => s.ticks);
  const isReplaying = useTradingStore((s) => s.isReplaying);
  // Positions passed by TerminalContext already contain replay marks and P&L.
  // Never overwrite those values with live ticks while replay is active.
  const openPositions = positions
    .filter((position) => position.quantity > 0)
    .map((p) => {
      if (isReplaying) return p;
      const tick = ticks[p.symbolName];
      if (!tick) return p;
      return {
        ...p,
        currentPrice: computeLivePrice(p, tick),
        unrealizedPnl: computeLivePnl(p, tick),
      };
    });
  const pendingOrders = orders.filter(
    (order) => order.status === "PENDING" || order.status === "NEW",
  );
  const totalPnl = openPositions.reduce((sum, position) => sum + (position.unrealizedPnl || 0), 0);

  const tabs: {
    key: typeof tab;
    label: string;
    icon: typeof Clock;
    count?: number;
  }[] = [
    {
      key: "positions",
      label: "Positions",
      icon: TrendingUp,
      count: openPositions.length,
    },
    {
      key: "orders",
      label: "Orders",
      icon: Clock,
      count: pendingOrders.length,
    },
    { key: "history", label: "Trade History", icon: History },
    {
      key: "journal",
      label: "Journal",
      icon: BookOpen,
      count: visibleJournalEntries.length,
    },
    { key: "calendar", label: "Calendar", icon: Globe },
    { key: "news", label: "News", icon: Newspaper },
    { key: "indicators", label: "Indicators", icon: TrendingUp },
    { key: "indicator-code", label: "Code chỉ báo", icon: Code2 },
    { key: "data-sources", label: "Nguồn dữ liệu", icon: Database },
  ];
  // The calendar and news tabs are sample data; a live broker must not show it.
  const visibleTabs = isHyperliquidMode()
    ? tabs.filter((t) => t.key !== "calendar" && t.key !== "news")
    : tabs;

  return (
    <div
      className="border-t border-border flex flex-col shrink-0 bg-card max-h-[38vh] md:max-h-none"
      style={{ height }}
    >
      {/* Tab bar */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-border bg-secondary text-xs overflow-x-auto no-scrollbar">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => onTabChange(t.key)}
            className={cn(
              "flex items-center gap-1 px-2.5 py-1 rounded shrink-0 whitespace-nowrap",
              tab === t.key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="h-3 w-3" />
            <span>{t.label}</span>
            {t.count !== undefined && t.count > 0 && (
              <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-[9px]">
                {t.count}
              </span>
            )}
          </button>
        ))}

        {tab === "positions" && openPositions.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <span className={cn("font-mono text-xs font-semibold", pnlClass(totalPnl))}>
              P&L: {totalPnl >= 0 ? "+" : ""}
              {formatCurrency(totalPnl)}
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleCloseAll}
              className="text-[10px] h-5"
              disabled={closeAllPositions.isPending || isDemo || !isFeedConnected}
            >
              Close All
            </Button>
          </div>
        )}

        {activeAccount &&
          (tab === "positions" || tab === "orders" || tab === "history") &&
          !(tab === "positions" && openPositions.length > 0) && (
            <span className="ml-auto text-[10px] text-muted-foreground font-mono px-2">
              {activeAccount.label || accountId?.slice(0, 8)}
            </span>
          )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === "data-sources" && <DataSourcesPanel />}
        {tab === "positions" && (
          <PositionsTable
            positions={openPositions}
            onClose={handleClosePosition}
            onModify={onModifyPosition as unknown as ((p: { id: string }) => void) | undefined}
            onPartialClose={handlePartialClose}
            onSelectSymbol={onSelectPositionSymbol}
          />
        )}
        {tab === "orders" && (
          <OrdersTable
            orders={pendingOrders}
            onCancel={handleCancel}
            onModify={onModifyOrder as unknown as ((order: { id: string }) => void) | undefined}
            onSelectSymbol={onSelectOrderSymbol}
          />
        )}
        {tab === "history" && <TradeHistoryTable accountId={accountId} />}
        {tab === "journal" && (
          <div className="flex flex-col h-full">
          <SnapshotToolbar<JournalEntry[]> storageKey={"opencharts_trade_journal_snapshots_" + (accountId || "none")} data={loadedJournalSnapshot ?? visibleJournalEntries} onLoad={setLoadedJournalSnapshot} onNew={startNewJournal} label="nhật ký giao dịch" isLoaded={loadedJournalSnapshot !== null} getData={async () => visibleJournalEntries}/>
          {loadedJournalSnapshot && <div className="px-2 py-1 text-[10px] text-warning">Đang xem bản nhật ký đã tải · chế độ chỉ đọc.</div>}
          <div className="flex-1 min-h-0">
          <TradeJournalPanel
            entries={loadedJournalSnapshot ?? visibleJournalEntries}
            isLoading={journalLoading}
            readOnly={false}
            accountId={accountId}
            onCreateEntry={
              onCreateJournal as unknown as (
                data: Partial<{ notes: string; tags: string[] }> & {
                  notes: string;
                  tags: string[];
                },
              ) => void
            }
            onUpdateEntry={
              onUpdateJournal as unknown as (
                id: string,
                data: Partial<{ notes: string; tags: string[] }> & {
                  notes: string;
                  tags: string[];
                },
              ) => void
            }
            onDeleteEntry={(id) => { if (loadedJournalSnapshot !== null) setLoadedJournalSnapshot((current) => current ? current.filter((entry) => entry.id !== id) : current); else onDeleteJournal(id); }}
          />
          </div></div>
        )}
        {tab === "calendar" && <EconomicCalendar />}
        {tab === "news" && <NewsFeed />}
        {tab === "indicators" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
            {INDICATOR_REGISTRY.map((indicator) => {
              const enabled = activeIndicators.includes(indicator.type);
              return (
                <div key={indicator.type} className="rounded-lg border border-border p-3 text-xs space-y-2">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input type="checkbox" checked={enabled} onChange={() => onToggleIndicator(indicator.type)} />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{indicator.label}</span>
                      <span className="text-muted-foreground">{indicator.type} · {indicator.pane === "overlay" ? "Overlay" : "Separate pane"}</span>
                    </span>
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: indicator.color }} />
                  </label>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => beginEditIndicator(indicator.type)}><Pencil className="h-3 w-3 mr-1" /> Sửa</Button>
                    <Button size="sm" variant="outline" onClick={() => { if (window.confirm("Xóa " + indicator.label + " khỏi biểu đồ?")) onDeleteIndicator(indicator.type); }}><Trash2 className="h-3 w-3 mr-1" /> Xóa</Button>
                  </div>
                  {Object.entries(indicator.defaultParams).map(([key, defaultValue]) => (
                    <label key={key} className="flex items-center justify-between gap-3 pl-6 text-muted-foreground">
                      <span>{key === "period" ? "Period" : key === "stdDev" ? "Độ lệch chuẩn" : key === "fast" ? "Fast" : key === "slow" ? "Slow" : key === "signal" ? "Signal" : key === "kPeriod" ? "%K period" : key === "dPeriod" ? "%D period" : key}</span>
                      <input type="number" min={1} max={5000} step={1}
                        value={indicatorParams[indicator.type]?.[key] ?? defaultValue}
                        onChange={(event) => onIndicatorParamChange(indicator.type, key, Number(event.target.value))}
                        disabled={!enabled}
                        className="w-20 rounded border border-border bg-background px-2 py-1 text-right text-foreground disabled:opacity-40" />
                    </label>
                  ))}
                </div>
              );
            })}
            {customIndicators.map((item) => (
              <div key={item.id} className="rounded-lg border border-border p-3 text-xs space-y-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={item.enabled === true} onChange={() => onToggleCustomIndicator(item.id)} />
                  <span className="min-w-0 flex-1 font-medium">{item.name}</span>
                </label>
                <div className="text-muted-foreground">Custom · JavaScript</div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" onClick={() => beginEditCustom(item)}><Pencil className="h-3 w-3 mr-1" /> Sửa</Button>
                  <Button size="sm" variant="outline" onClick={() => { if (window.confirm("Xóa chỉ báo " + item.name + "?")) onDeleteCustomIndicator(item.id); }}><Trash2 className="h-3 w-3 mr-1" /> Xóa</Button>
                </div>
              </div>
            ))}
            <div className="sm:col-span-2 flex justify-end"><Button size="sm" onClick={beginNewCustom}><Plus className="h-4 w-4 mr-1" /> Thêm chỉ báo</Button></div>
          </div>
        )}
        {tab === "indicator-code" && (
          <div className="h-full min-h-[220px] flex flex-col gap-2 p-3">
            <div className="flex items-center gap-2">
              <input value={editorName} onChange={(e) => setEditorName(e.target.value)} placeholder="Tên chỉ báo" disabled={!!editingIndicator}
                className="w-56 rounded border border-border bg-background px-2 py-1.5 text-xs" />
              <span className="text-xs text-muted-foreground">{editingIndicator ? "Đang sửa " + editingIndicator : isNewCustom ? "Chỉ báo tùy chỉnh mới" : "Chỉnh sửa code"}</span>
            </div>
            <textarea value={editorCode} onChange={(e) => setEditorCode(e.target.value)}
              placeholder="// Viết code chỉ báo tại đây. Ví dụ: (candles, params) => [{ time, value }]"
              spellCheck={false} className="flex-1 min-h-[150px] w-full resize-y rounded border border-border bg-background p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary" />
            <div className="text-[10px] text-muted-foreground">Hỗ trợ 2 dạng: hàm trả về mảng { "{ time, value }" } (candles gồm time, open, high, low, close, volume), hoặc module overlay JavaScript tự cung cấp API như FVGIndicator.init()/update(). Chỉ chạy code do bạn tin cậy; code được thực thi trong ứng dụng.</div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => onTabChange("indicators")}>Hủy</Button>
              <Button size="sm" onClick={saveCode}>Lưu code</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type DataSnapshot<T> = { id: string; name: string; createdAt: string; data: T };
function SnapshotToolbar<T>({ storageKey, data, onLoad, onNew, label, getData, isLoaded = false }: { storageKey: string; data: T; onLoad: (value: T | null) => void; onNew: () => void; label: string; getData?: () => Promise<T>; isLoaded?: boolean }) {
  const [snapshots, setSnapshots] = useState<DataSnapshot<T>[]>(() => { try { const v = JSON.parse(safeStorage.getItem(storageKey) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } });
  const [selectedId, setSelectedId] = useState("");
  const persist = (next: DataSnapshot<T>[]) => { setSnapshots(next); safeStorage.setJSON(storageKey, next); };
  const saveAs = async () => {
    const name = window.prompt("Đặt tên bản lưu " + label + ":");
    if (!name || !name.trim()) return;
    try {
      const source = getData ? await getData() : data;
      const snapshot: DataSnapshot<T> = {
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
        name: name.trim(), createdAt: new Date().toISOString(),
        data: JSON.parse(JSON.stringify(source)) as T,
      };
      persist([snapshot, ...snapshots]);
      setSelectedId(snapshot.id);
      toast.success("Đã lưu bản dữ liệu", name.trim());
    } catch (error) {
      toast.error("Không thể lưu", error instanceof Error ? error.message : "Lỗi đọc dữ liệu");
    }
  };
  const load = () => { const item = snapshots.find((x) => x.id === selectedId); if (!item) { toast.warning("Chưa chọn bản lưu", "Hãy chọn dữ liệu cần tải."); return; } onLoad(JSON.parse(JSON.stringify(item.data)) as T); toast.success("Đã tải dữ liệu", item.name); };
  const remove = () => { const item = snapshots.find((x) => x.id === selectedId); if (!item || !window.confirm("Xóa bản lưu '" + item.name + "'?")) return; persist(snapshots.filter((x) => x.id !== selectedId)); setSelectedId(""); onLoad(null); };
  return <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 border-b border-border bg-secondary/30">
    <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={onNew}><Plus className="h-3 w-3 mr-1"/>Tạo mới</Button>
     <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={saveAs}><Save className="h-3 w-3 mr-1"/>Save As</Button>
    <select aria-label={"Bản lưu " + label} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="min-w-0 max-w-[190px] h-7 rounded border border-border bg-background px-2 text-[10px]">
      <option value="">Chọn bản đã lưu ({snapshots.length})</option>{snapshots.map((x) => <option key={x.id} value={x.id}>{x.name} · {formatDate(x.createdAt)}</option>)}
    </select>
    <Button size="sm" variant="outline" className="h-7 text-[10px]" disabled={!selectedId} onClick={load}><FolderOpen className="h-3 w-3 mr-1"/>Load</Button>
     {isLoaded && <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => { const item = snapshots.find((x) => x.id === selectedId); if (!item) return; persist(snapshots.map((x) => x.id === selectedId ? { ...x, data: JSON.parse(JSON.stringify(data)) as T } : x)); toast.success("Đã cập nhật bản lưu", item.name); }}>Lưu thay đổi</Button>}
    <Button size="sm" variant="ghost" className="h-7 text-[10px] text-destructive" disabled={!selectedId} onClick={remove}><Trash2 className="h-3 w-3 mr-1"/>Xóa bản lưu</Button>
  </div>;
}
// ── Trade History Table ──────────────────────────────────────
function TradeHistoryTable({ accountId }: { accountId: string | null }) {
  const [page, setPage] = useState(1);
  const [loadedSnapshot, setLoadedSnapshot] = useState<ClosedWithPlatformFee[] | null>(null);
  const historySessionKey = "opencharts_trade_history_session_" + (accountId || "none");
  const [historySessionStart, setHistorySessionStart] = useState<number>(() => Number(safeStorage.getItem(historySessionKey) || 0));
  const startNewHistory = () => { if (!window.confirm("Tạo lịch sử giao dịch mới? Các giao dịch cũ sẽ được ẩn khỏi phiên thử nghiệm này nhưng không bị xóa.")) return; const startedAt = Date.now(); safeStorage.setItem(historySessionKey, String(startedAt)); setHistorySessionStart(startedAt); setLoadedSnapshot(null); setPage(1); toast.success("Đã tạo lịch sử mới", "Các giao dịch cũ được giữ nguyên và tách khỏi phiên mới."); };
  const { data: closedData, isLoading } = useClosedPositions(accountId, page);
  const liveTrades: ClosedWithPlatformFee[] = closedData?.data || [];
  const sessionTrades = historySessionStart ? liveTrades.filter((trade) => Date.parse(trade.openedAt || trade.closedAt || "") >= historySessionStart) : liveTrades;
  const trades: ClosedWithPlatformFee[] = loadedSnapshot ?? sessionTrades;
  const showPlatformFee = trades.some((t) => t.platformFee !== undefined);
  const totalPages = closedData?.totalPages || 1;
  const accounts = useTradingStore((s) => s.accounts as AccountOption[]);
  const activeAccount = accounts.find((account) => account.id === accountId);

  const prevAccRef = useRef(accountId);
  useEffect(() => {
    if (prevAccRef.current !== accountId) {
      setPage(1);
      setLoadedSnapshot(null);
      setHistorySessionStart(Number(safeStorage.getItem("opencharts_trade_history_session_" + (accountId || "none")) || 0));
      prevAccRef.current = accountId;
    }
  }, [accountId]);

  if (!accountId)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Select an account
      </div>
    );
  if (isLoading)
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading...
      </div>
    );
  if (trades.length === 0)
    return (
      <div className="flex flex-col h-full"><SnapshotToolbar<ClosedWithPlatformFee[]> storageKey={"opencharts_trade_history_snapshots_" + (accountId || "none")} data={trades} onLoad={setLoadedSnapshot} onNew={startNewHistory} label="lịch sử giao dịch" getData={async () => { if (!accountId) return []; const first = await api.getClosedPositions(accountId, 1); const all: ClosedWithPlatformFee[] = [...(first.data || [])]; for (let p = 2; p <= (first.totalPages || 1); p++) { const next = await api.getClosedPositions(accountId, p); all.push(...(next.data || [])); } return historySessionStart ? all.filter((trade) => Date.parse(trade.openedAt || trade.closedAt || "") >= historySessionStart) : all; }}/><div className="flex items-center justify-center flex-1 text-muted-foreground text-xs">
        No trade history yet
        {activeAccount ? ` for ${activeAccount.label || accountId?.slice(0, 8)}` : ""}
      </div></div>
    );

  return (
    <div className="flex flex-col h-full">
      <SnapshotToolbar<ClosedWithPlatformFee[]> storageKey={"opencharts_trade_history_snapshots_" + (accountId || "none")} data={trades} onLoad={setLoadedSnapshot} label="lịch sử giao dịch" getData={async () => { if (!accountId) return []; const first = await api.getClosedPositions(accountId, 1); const all: ClosedWithPlatformFee[] = [...(first.data || [])]; for (let p = 2; p <= (first.totalPages || 1); p++) { const next = await api.getClosedPositions(accountId, p); all.push(...(next.data || [])); } return all; }}/>
      {loadedSnapshot && <div className="px-2 py-1 text-[10px] text-warning">Đang xem bản lưu lịch sử giao dịch.</div>}
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-card z-10">
          <tr>
            <th>Closed</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Volume</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>{showPlatformFee ? "Fees" : "Commission"}</th>
            <th>Gross P&L</th>
            <th>Net P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const platform = t.platformFee ?? 0;
            const comm = (t.commission ?? 0) + platform;
            const gross = t.realizedPnl ?? 0;
            const net = gross - comm;
            return (
              <tr key={t.id} className="hover:bg-secondary/30">
                <td className="text-muted-foreground font-mono">
                  {formatDate(t.closedAt || t.openedAt)}
                </td>
                <td className="font-semibold">{t.symbolName}</td>
                <td className={t.side === "LONG" ? "text-buy" : "text-sell"}>{t.side}</td>
                <td className="font-mono">{t.quantity}</td>
                <td className="font-mono">{t.entryPrice ? formatNumber(t.entryPrice, 5) : "--"}</td>
                <td className="font-mono">{t.exitPrice ? formatNumber(t.exitPrice, 5) : "--"}</td>
                <td
                  className="font-mono text-muted-foreground"
                  title={
                    showPlatformFee
                      ? `Exchange fee ${(t.commission ?? 0).toFixed(4)} + platform fee ${platform.toFixed(4)} (closing fills only)`
                      : undefined
                  }
                >
                  {comm > 0 ? `-${comm.toFixed(2)}` : "0.00"}
                </td>
                <td
                  className={cn(
                    "font-mono",
                    gross >= 0 ? "text-success/70" : "text-destructive/70",
                  )}
                >
                  {`${gross >= 0 ? "+" : ""}${gross.toFixed(2)}`}
                </td>
                <td className={cn("font-mono font-semibold", pnlClass(net))}>
                  {`${net >= 0 ? "+" : ""}${net.toFixed(2)}`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!loadedSnapshot && !historySessionStart && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-1 border-t border-border text-[10px]">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page <= 1}
            className="px-1.5 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-muted-foreground">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="px-1.5 py-0.5 rounded bg-secondary hover:bg-secondary/80 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

// ── Economic Calendar ────────────────────────────────────────
function EconomicCalendar() {
  // Hyperliquid mode never loads third-party TradingView scripts (see TradingViewWidgets.tsx).
  const tvAllowed = isTradingViewAllowed();
  const [tvPref, setUseTvCalendar] = useState(
    () => safeStorage.getItem("tvEconCalendar") !== "false",
  );
  const useTvCalendar = tvAllowed && tvPref;
  const isDark = !document.documentElement.classList.contains("light");

  const impactColor = {
    low: "bg-muted text-muted-foreground",
    medium: "bg-warning/20 text-warning",
    high: "bg-destructive/20 text-destructive",
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border/40 shrink-0">
        <button
          onClick={() => {
            setUseTvCalendar(false);
            safeStorage.setItem("tvEconCalendar", "false");
          }}
          className={cn(
            "px-2 py-0.5 rounded text-[10px] font-medium",
            !useTvCalendar
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-secondary",
          )}
        >
          Sim Data
        </button>
        {tvAllowed && (
          <button
            onClick={() => {
              setUseTvCalendar(true);
              safeStorage.setItem("tvEconCalendar", "true");
            }}
            className={cn(
              "px-2 py-0.5 rounded text-[10px] font-medium",
              useTvCalendar
                ? "bg-[#2962ff] text-white"
                : "text-muted-foreground hover:bg-secondary",
            )}
          >
            TradingView Live
          </button>
        )}
      </div>
      {useTvCalendar ? (
        <div className="flex-1 min-h-0">
          <TradingViewEconomicCalendar
            theme={isDark ? "dark" : "light"}
            width="100%"
            height="100%"
          />
        </div>
      ) : (
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-card z-10">
            <tr>
              <th>Time</th>
              <th>Currency</th>
              <th>Impact</th>
              <th>Event</th>
              <th>Forecast</th>
              <th>Previous</th>
              <th>Actual</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td
                colSpan={7}
                className="px-3 py-1.5 bg-secondary/40 text-[10px] text-muted-foreground"
              >
                <span className="font-medium uppercase tracking-wide">Sample data</span>
                {tvAllowed ? " — switch the TradingView calendar back on for live events." : null}
              </td>
            </tr>
            {MOCK_EVENTS.map((ev, i) => (
              <tr key={i} className="hover:bg-secondary/30">
                <td className="text-muted-foreground">{ev.time}</td>
                <td className="font-semibold">{ev.currency}</td>
                <td>
                  <span
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[9px] font-medium",
                      impactColor[ev.impact],
                    )}
                  >
                    {ev.impact.toUpperCase()}
                  </span>
                </td>
                <td>{ev.event}</td>
                <td className="font-mono">{ev.forecast || "--"}</td>
                <td className="font-mono text-muted-foreground">{ev.previous || "--"}</td>
                <td className="font-mono font-semibold">{ev.actual || "--"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── News // ── Live News Feed ───────────────────────────────────────────
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
