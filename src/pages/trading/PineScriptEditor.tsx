import { useEffect, useRef, useState } from "react";
import { Play, Loader2, AlertCircle, CheckCircle2, Settings2, FileCode2 } from "lucide-react";
import pineFeatureTest from "../../../examples/pine-scripts/opencharts-feature-test.pine?raw";
import type { Candle } from "../../services/schemas.ts";
import { safeStorage } from "../../lib/safe-storage.ts";
import type { PineExecutionResult, PineInputMeta } from "../../lib/pine-script-runtime.ts";
import { executePineScriptInWorker, getPineInputsInWorker } from "../../lib/pine-script-worker-client.ts";

const STORAGE_KEY = "opencharts_pine_script_source_v1";
const DEFAULT_SOURCE = `//@version=5
indicator("EMA 9 / 21", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
plot(fast, "EMA 9", color=color.green, linewidth=2)
plot(slow, "EMA 21", color=color.red, linewidth=2)
`;
interface PineScriptEditorProps { candles: Candle[]; onExecution: (result: PineExecutionResult | null) => void; }
function inputValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return String(value);
  return String(value);
}
export function PineScriptEditor({ candles, onExecution }: PineScriptEditorProps) {
  const [code, setCode] = useState(() => safeStorage.getItem(STORAGE_KEY) || DEFAULT_SOURCE);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PineExecutionResult | null>(null);
  const [inputMeta, setInputMeta] = useState<PineInputMeta[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, unknown>>({});
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [appliedInputs, setAppliedInputs] = useState<Record<string, unknown>>({});
  const lastFingerprint = useRef("");
  const runSequence = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inspectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fingerprint = () => {
    const first = candles[0]; const last = candles[candles.length - 1];
    return [candles.length, first?.time, last?.time, last?.open, last?.high, last?.low, last?.close, last?.volume].join(":");
  };
  useEffect(() => {
    if (inspectTimer.current) clearTimeout(inspectTimer.current);
    inspectTimer.current = setTimeout(() => {
      void getPineInputsInWorker(code).then(meta => {
        setInputMeta(meta);
        setInputValues(Object.fromEntries(meta.map(item => [item.id, item.defval])));
      }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    }, 350);
    return () => { if (inspectTimer.current) clearTimeout(inspectTimer.current); };
  }, [code]);
  const runSource = async (source: string, automatic = false, overrides: Record<string, unknown> = inputValues) => {
    const sequence = ++runSequence.current;
    if (!automatic) { setRunning(true); setError(""); }
    try {
      const next = await executePineScriptInWorker(source, candles, overrides);
      if (sequence !== runSequence.current) return;
      setResult(next); onExecution(next); safeStorage.setItem(STORAGE_KEY, source);
      lastFingerprint.current = fingerprint();
      if (!automatic) { setAppliedCode(source); setAppliedInputs({ ...overrides }); }
      setError("");
    } catch (cause) {
      if (sequence !== runSequence.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message); setResult(null); onExecution(null);
    } finally { if (!automatic && sequence === runSequence.current) setRunning(false); }
  };
  useEffect(() => {
    if (!appliedCode || candles.length < 2) return;
    const nextFingerprint = fingerprint();
    if (nextFingerprint === lastFingerprint.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void runSource(appliedCode, true, appliedInputs); }, 300);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [candles, appliedCode, appliedInputs]);
  const run = async () => { await runSource(code, false, inputValues); };
  const updateInput = (meta: PineInputMeta, raw: string | boolean) => {
    let value: unknown = raw;
    if (typeof raw === "string" && (meta.type === "int" || meta.type === "float" || meta.type === "price")) {
      value = raw === "" ? meta.defval : Number(raw);
    }
    runSequence.current++;
    setRunning(false);
    setInputValues(current => ({ ...current, [meta.id]: value }));
  };
  const renderInput = (meta: PineInputMeta) => {
    const value = inputValues[meta.id] ?? meta.defval;
    const title = meta.title || meta.name;
    const common = "w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary";
    if (meta.type === "bool") return <label key={meta.id} className="flex items-center gap-2 py-1"><input type="checkbox" checked={Boolean(value)} onChange={e=>updateInput(meta,e.target.checked)} /><span>{title}</span></label>;
    if (Array.isArray(meta.options) && meta.options.length) return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><select className={common} value={String(value)} onChange={e=>updateInput(meta,e.target.value)}>{meta.options.map((option,index)=><option key={index} value={String(option)}>{String(option)}</option>)}</select></label>;
    if (meta.type === "int" || meta.type === "float" || meta.type === "price") return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><input className={common} type="number" value={String(value)} min={meta.minval} max={meta.maxval} step={meta.step ?? (meta.type === "int" ? 1 : "any")} onChange={e=>updateInput(meta,e.target.value)} /></label>;
    return <label key={meta.id} className="grid grid-cols-[minmax(0,1fr)_minmax(100px,1fr)] items-center gap-2 py-1"><span className="truncate" title={meta.tooltip}>{title}</span><input className={common} type="text" value={inputValue(value)} onChange={e=>updateInput(meta,e.target.value)} /></label>;
  };
  const groups = [...new Set(inputMeta.map(meta => meta.group || ""))];
  return <div className="flex h-full min-h-0 flex-col gap-2 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-semibold text-sm">Pine Script Editor</div><p className="text-muted-foreground mt-0.5">Dán mã Pine v5/v6. Tự nhận diện indicator() hoặc strategy(); tự tính lại khi nến thay đổi.</p></div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => { setCode(pineFeatureTest); setError(""); }} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 font-medium hover:bg-secondary"><FileCode2 className="h-3.5 w-3.5" />Nạp mã mẫu</button>
        <button type="button" onClick={run} disabled={running || candles.length < 2} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50">{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{running ? "Đang chạy..." : "Thêm vào biểu đồ / Chạy"}</button>
      </div></div>
    <textarea value={code} onChange={event => { runSequence.current++; setRunning(false); setCode(event.target.value); }} spellCheck={false} aria-label="Pine Script source" className="min-h-[150px] flex-1 resize-y rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5 outline-none focus:border-primary" />
    {inputMeta.length > 0 && <details className="max-h-[190px] shrink-0 overflow-y-auto rounded-md border border-border p-2" open>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold"><Settings2 className="h-3.5 w-3.5" />Tham số chỉ báo / chiến lược ({inputMeta.length})</summary>
      <div className="mt-2 space-y-2">{groups.map(group=><section key={group}><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group || "Thông số"}</div>{inputMeta.filter(meta=>(meta.group||"")===group).map(renderInput)}</section>)}</div>
    </details>}
    {error && <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{error}</span></div>}
    {result && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2"><span className="inline-flex items-center gap-1 font-medium text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />{result.kind === "strategy" ? "Strategy" : "Indicator"}: {result.title}</span><span className="text-muted-foreground">Pine v{result.version}</span><span className="text-muted-foreground">{result.plots.length} plot</span>{result.kind === "strategy" && <span className="text-muted-foreground">{result.summary.totalTrades} giao dịch · {result.summary.totalPoints >= 0 ? "+" : ""}{result.summary.totalPoints.toFixed(2)} điểm</span>}</div>}
    {result?.warnings.map((warning,index)=><p key={index} className="text-amber-600">{warning}</p>)}
    {!result && !error && <p className="text-muted-foreground">Dữ liệu nến hiện có: {candles.length.toLocaleString("vi-VN")} bars.</p>}
  </div>;
}
