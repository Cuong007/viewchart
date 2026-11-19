import { useEffect, useRef, useState } from "react";
import { Play, Loader2, AlertCircle, CheckCircle2, Settings2, FileCode2, Plus, Pencil, Trash2, Eye, EyeOff, Save, X, List, SlidersHorizontal } from "lucide-react";
import pineFeatureTest from "../../../examples/pine-scripts/opencharts-feature-test.pine?raw";
import type { Candle } from "../../services/schemas.ts";
import { safeStorage } from "../../lib/safe-storage.ts";
import type { PineExecutionResult, PineInputMeta } from "../../lib/pine-script-runtime.ts";
import { executePineScriptInWorker, getPineInputsInWorker } from "../../lib/pine-script-worker-client.ts";

const STORAGE_KEY = "opencharts_pine_script_source_v1";
const LIST_STORAGE_KEY = "opencharts_pine_indicators_v2";
const DEFAULT_SOURCE = `//@version=5
indicator("EMA 9 / 21", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
plot(fast, "EMA 9", color=color.green, linewidth=2)
plot(slow, "EMA 21", color=color.red, linewidth=2)
`;
interface SavedPineIndicator {
  id: string;
  title: string;
  code: string;
  inputs: Record<string, unknown>;
  enabled: boolean;
}
interface PineScriptEditorProps { candles: Candle[]; onExecution: (result: PineExecutionResult | null) => void; }
function inputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return String(value);
  return String(value);
}
function readSavedIndicators(): SavedPineIndicator[] {
  try {
    const raw = safeStorage.getItem(LIST_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is SavedPineIndicator =>
      item && typeof item.id === "string" && typeof item.code === "string"
      && typeof item.enabled === "boolean" && item.inputs && typeof item.inputs === "object"
    ) : [];
  } catch { return []; }
}
function combineExecutions(items: Array<{ id: string; result: PineExecutionResult }>): PineExecutionResult | null {
  if (!items.length) return null;
  const plots = items.flatMap(({ id, result }) => result.plots.map(plot => ({
    ...plot, id: id + "::" + plot.id, title: result.title + " · " + plot.title,
  })));
  const rawPlots: Record<string, any> = {};
  for (const { id, result } of items) {
    for (const [key, value] of Object.entries(result.rawPlots ?? {})) {
      const mapped = { ...value };
      if (mapped.plot1) mapped.plot1 = id + "::" + mapped.plot1;
      if (mapped.plot2) mapped.plot2 = id + "::" + mapped.plot2;
      if (mapped.options?.plot1) mapped.options = { ...mapped.options, plot1: id + "::" + mapped.options.plot1 };
      if (mapped.options?.plot2) mapped.options = { ...mapped.options, plot2: id + "::" + mapped.options.plot2 };
      rawPlots[id + "::" + key] = mapped;
    }
  }
  const strategies = items.filter(item => item.result.kind === "strategy");
  const trades = items.flatMap(({ id, result }) => result.trades.map(trade => ({ ...trade, id: id + "::" + trade.id })));
  const closed = strategies.reduce((sum, item) => sum + item.result.summary.totalTrades, 0);
  const wins = strategies.reduce((sum, item) => sum + item.result.summary.winningTrades, 0);
  const totalPoints = strategies.reduce((sum, item) => sum + item.result.summary.totalPoints, 0);
  const first = items[0]!.result;
  return {
    kind: strategies.length ? "strategy" : "indicator",
    title: items.map(item => item.result.title).join(" + "),
    version: Math.max(...items.map(item => item.result.version)),
    plots, rawPlots, trades,
    summary: {
      totalTrades: closed, winningTrades: wins,
      losingTrades: strategies.reduce((sum, item) => sum + item.result.summary.losingTrades, 0),
      winRate: closed ? wins / closed * 100 : 0,
      totalPoints, averagePoints: closed ? totalPoints / closed : 0,
    },
    warnings: items.flatMap(item => item.result.warnings),
  };
}

export function PineScriptEditor({ candles, onExecution }: PineScriptEditorProps) {
  const [indicators, setIndicators] = useState<SavedPineIndicator[]>(readSavedIndicators);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [code, setCode] = useState(() => safeStorage.getItem(STORAGE_KEY) || DEFAULT_SOURCE);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PineExecutionResult | null>(null);
  const [inputMeta, setInputMeta] = useState<PineInputMeta[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [showSettings, setShowSettings] = useState(true);
  const [resultsById, setResultsById] = useState<Record<string, PineExecutionResult>>({});
  const runSequence = useRef(0);
  const inspectSequence = useRef(0);
  const indicatorsRef = useRef(indicators);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resultsRef = useRef(resultsById);
  const selected = indicators.find(item => item.id === selectedId) ?? null;

  useEffect(() => { indicatorsRef.current = indicators; safeStorage.setItem(LIST_STORAGE_KEY, JSON.stringify(indicators)); }, [indicators]);
  useEffect(() => { resultsRef.current = resultsById; }, [resultsById]);

  const publish = (nextResults: Record<string, PineExecutionResult>, currentIndicators = indicatorsRef.current) => {
    const active = currentIndicators.filter(item => item.enabled && nextResults[item.id]).map(item => ({ id: item.id, result: nextResults[item.id]! }));
    const combined = combineExecutions(active);
    setResult(combined);
    onExecution(combined);
  };

  useEffect(() => {
    const sequence = ++inspectSequence.current;
    if (inspectTimer.current) clearTimeout(inspectTimer.current);
    inspectTimer.current = setTimeout(() => {
      void getPineInputsInWorker(code).then(meta => {
        if (sequence !== inspectSequence.current) return;
        setInputMeta(meta);
        const saved = indicatorsRef.current.find(item => item.id === selectedId);
        setInputValues(saved ? { ...Object.fromEntries(meta.map(item => [item.id, item.defval])), ...saved.inputs } : Object.fromEntries(meta.map(item => [item.id, item.defval])));
      }).catch(cause => {
        if (sequence === inspectSequence.current) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 250);
    return () => { if (inspectTimer.current) clearTimeout(inspectTimer.current); inspectSequence.current++; };
  }, [code, selectedId]);

  const executeOne = async (item: SavedPineIndicator, candleSet = candles) => {
    return executePineScriptInWorker(item.code, candleSet, item.inputs);
  };

  const runEnabled = async (list: SavedPineIndicator[], candleSet = candles, showSpinner = false) => {
    const sequence = ++runSequence.current;
    if (showSpinner) { setRunning(true); setError(""); }
    try {
      const nextResults = { ...resultsRef.current };
      for (const item of list.filter(entry => entry.enabled)) {
        const value = await executeOne(item, candleSet);
        if (sequence !== runSequence.current) return;
        nextResults[item.id] = value;
      }
      for (const item of list) if (!item.enabled) delete nextResults[item.id];
      if (sequence !== runSequence.current) return;
      setResultsById(nextResults);
      resultsRef.current = nextResults;
      publish(nextResults, list);
      if (showSpinner) setError("");
    } catch (cause) {
      if (sequence !== runSequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (sequence === runSequence.current && showSpinner) setRunning(false);
    }
  };

  useEffect(() => {
    if (!indicators.some(item => item.enabled) || candles.length < 2) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void runEnabled(indicatorsRef.current, candles, false); }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  // Candle arrays are refreshed as live data changes; rerun the enabled Pine scripts on the latest bars.
  }, [candles]);

  const newIndicator = () => {
    runSequence.current++;
    setSelectedId(null);
    setCode(DEFAULT_SOURCE);
    setInputValues({});
    setInputMeta([]);
    setError("");
    setShowSettings(true);
  };

  const selectIndicator = (item: SavedPineIndicator) => {
    runSequence.current++;
    setSelectedId(item.id);
    setCode(item.code);
    setInputValues({ ...item.inputs });
    setError("");
    setShowSettings(true);
  };

  const saveAndRun = async () => {
    const id = selectedId ?? "pine-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
    const existing = indicatorsRef.current.find(item => item.id === id);
    const titleMatch = code.match(/\b(?:indicator|strategy)\s*\(\s*["']([^"']+)/);
    const item: SavedPineIndicator = {
      id, title: titleMatch?.[1] || existing?.title || "Pine Indicator",
      code, inputs: { ...inputValues }, enabled: existing?.enabled ?? true,
    };
    const next = existing ? indicatorsRef.current.map(entry => entry.id === id ? item : entry) : [...indicatorsRef.current, item];
    setIndicators(next);
    setSelectedId(id);
    safeStorage.setItem(STORAGE_KEY, code);
    const sequence = ++runSequence.current;
    setRunning(true); setError("");
    try {
      const value = await executeOne(item);
      if (sequence !== runSequence.current) return;
      const nextResults = { ...resultsRef.current, [id]: value };
      setResultsById(nextResults); resultsRef.current = nextResults;
      publish(nextResults, next);
      setShowSettings(true);
    } catch (cause) {
      if (sequence !== runSequence.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (sequence === runSequence.current) setRunning(false); }
  };

  const toggleEnabled = async (item: SavedPineIndicator) => {
    const next = indicatorsRef.current.map(entry => entry.id === item.id ? { ...entry, enabled: !entry.enabled } : entry);
    setIndicators(next);
    if (item.enabled) {
      const nextResults = { ...resultsRef.current }; delete nextResults[item.id];
      setResultsById(nextResults); resultsRef.current = nextResults; publish(nextResults, next);
    } else {
      await runEnabled(next, candles, true);
    }
  };

  const deleteIndicator = (item: SavedPineIndicator) => {
    if (!window.confirm(`Xóa chỉ báo "${item.title}" khỏi danh sách và biểu đồ?`)) return;
    const next = indicatorsRef.current.filter(entry => entry.id !== item.id);
    const nextResults = { ...resultsRef.current }; delete nextResults[item.id];
    setIndicators(next); setResultsById(nextResults); resultsRef.current = nextResults;
    if (selectedId === item.id) {
      setSelectedId(null); setCode(DEFAULT_SOURCE); setInputValues({}); setInputMeta([]);
    }
    publish(nextResults, next);
  };

  const updateInput = (meta: PineInputMeta, raw: string | boolean) => {
    let value: unknown = raw;
    if (typeof raw === "string" && (meta.type === "int" || meta.type === "float" || meta.type === "price")) value = raw === "" ? meta.defval : Number(raw);
    setInputValues(current => ({ ...current, [meta.id]: value }));
  };
  const renderInput = (meta: PineInputMeta) => {
    const value = inputValues[meta.id] ?? meta.defval;
    const title = meta.title || meta.name;
    const common = "w-full min-w-0 rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary";
    if (meta.type === "bool") return <label key={meta.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={Boolean(value)} onChange={e=>updateInput(meta,e.target.checked)} /><span>{title}</span></label>;
    if (Array.isArray(meta.options) && meta.options.length) return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><select className={common} value={String(value)} onChange={e=>updateInput(meta,e.target.value)}>{meta.options.map((option,index)=><option key={index} value={String(option)}>{String(option)}</option>)}</select></label>;
    if (meta.type === "int" || meta.type === "float" || meta.type === "price") return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><input className={common} type="number" value={String(value)} min={meta.minval} max={meta.maxval} step={meta.step ?? (meta.type === "int" ? 1 : "any")} onChange={e=>updateInput(meta,e.target.value)} /></label>;
    return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><input className={common} type="text" value={inputValue(value)} onChange={e=>updateInput(meta,e.target.value)} /></label>;
  };
  const groups = [...new Set(inputMeta.map(meta => meta.group || ""))];

  return <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><div className="font-semibold text-sm">Pine Script</div><p className="mt-0.5 text-muted-foreground">Quản lý nhiều chỉ báo Pine độc lập trên biểu đồ.</p></div>
      <button type="button" onClick={newIndicator} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground"><Plus className="h-3.5 w-3.5" />Chỉ báo mới</button>
    </div>

    <section className="shrink-0 rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 font-semibold"><span className="inline-flex items-center gap-2"><List className="h-3.5 w-3.5" />Danh sách chỉ báo ({indicators.length})</span><span className="text-[10px] font-normal text-muted-foreground">{indicators.filter(item=>item.enabled).length} đang bật</span></div>
      {indicators.length === 0 ? <p className="px-3 py-4 text-center text-muted-foreground">Chưa có chỉ báo. Nhấn “Chỉ báo mới” để tạo hoặc nạp mã Pine.</p> :
        <div className="max-h-[180px] divide-y divide-border overflow-y-auto">
          {indicators.map(item=><div key={item.id} className={`flex items-center gap-2 px-2 py-2 ${selectedId===item.id?"bg-primary/5":""}`}>
            <button type="button" onClick={()=>void toggleEnabled(item)} title={item.enabled?"Tắt chỉ báo":"Bật chỉ báo"} className="rounded p-1 hover:bg-secondary">{item.enabled?<Eye className="h-4 w-4 text-emerald-500"/>:<EyeOff className="h-4 w-4 text-muted-foreground"/>}</button>
            <button type="button" onClick={()=>selectIndicator(item)} className="min-w-0 flex-1 text-left"><span className="block truncate font-medium">{item.title}</span><span className="block truncate text-[10px] text-muted-foreground">{item.enabled?"Đang hiển thị":"Đã tắt"} · {item.code.match(/\b(?:indicator|strategy)\s*\(/)?.[0]?.replace("(","") || "Pine"}</span></button>
            <button type="button" onClick={()=>selectIndicator(item)} title="Sửa mã và thông số" className="rounded p-1.5 hover:bg-secondary"><Pencil className="h-3.5 w-3.5"/></button>
            <button type="button" onClick={()=>deleteIndicator(item)} title="Xóa chỉ báo" className="rounded p-1.5 text-destructive hover:bg-destructive/10"><Trash2 className="h-3.5 w-3.5"/></button>
          </div>)}
        </div>}
    </section>

    <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold text-sm">{selected ? `Chỉnh sửa: ${selected.title}` : "Tạo chỉ báo Pine mới"}</div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setCode(pineFeatureTest); setError(""); }} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-2 font-medium hover:bg-secondary"><FileCode2 className="h-3.5 w-3.5"/>Nạp mã mẫu</button>
        <button type="button" onClick={saveAndRun} disabled={running || candles.length<2} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50">{running?<Loader2 className="h-3.5 w-3.5 animate-spin"/>:<><Save className="h-3.5 w-3.5"/><Play className="h-3.5 w-3.5"/></>}{running?"Đang chạy...":selected?"Lưu sửa & áp dụng":"Thêm vào biểu đồ"}</button>
      </div>
    </div>
    <textarea value={code} onChange={event=>{runSequence.current++;setRunning(false);setCode(event.target.value);}} spellCheck={false} aria-label="Pine Script source" className="min-h-[130px] w-full shrink-0 resize-y rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5 outline-none focus:border-primary"/>

    {inputMeta.length>0 && <section className="shrink-0 rounded-md border border-border">
      <button type="button" onClick={()=>setShowSettings(v=>!v)} className="flex w-full items-center justify-between px-3 py-2 text-left font-semibold"><span className="inline-flex items-center gap-2"><SlidersHorizontal className="h-3.5 w-3.5"/>Thay đổi thông số ({inputMeta.length})</span><span className="text-muted-foreground">{showSettings?"Thu gọn":"Mở rộng"}</span></button>
      {showSettings && <div className="max-h-[230px] overflow-y-auto border-t border-border p-2"><div className="space-y-2">{groups.map(group=><section key={group}><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group||"Thông số"}</div>{inputMeta.filter(meta=>(meta.group||"")===group).map(renderInput)}</section>)}</div><p className="mt-2 text-[10px] text-muted-foreground">Thay đổi thông số xong nhấn “Lưu sửa & áp dụng” để cập nhật chỉ báo trên biểu đồ.</p></div>}
    </section>}
    {error && <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0"/><span>{error}</span></div>}
    {result && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2"><span className="inline-flex items-center gap-1 font-medium text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5"/>{result.kind==="strategy"?"Strategy":"Indicator"}: {result.title}</span><span className="text-muted-foreground">Pine v{result.version}</span><span className="text-muted-foreground">{result.plots.length} plot</span>{result.kind==="strategy"&&<span className="text-muted-foreground">{result.summary.totalTrades} giao dịch · {result.summary.totalPoints>=0?"+":""}{result.summary.totalPoints.toFixed(2)} điểm</span>}</div>}
    {result?.warnings.map((warning,index)=><p key={index} className="text-amber-600">{warning}</p>)}
    {!result&&!error&&<p className="text-muted-foreground">Dữ liệu nến hiện có: {candles.length.toLocaleString("vi-VN")} bars.</p>}
  </div>;
}
