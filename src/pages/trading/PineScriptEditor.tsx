import { useEffect, useRef, useState } from "react";
import { Play, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import type { Candle } from "../../services/schemas.ts";
import { safeStorage } from "../../lib/safe-storage.ts";
import { executePineScript, type PineExecutionResult } from "../../lib/pine-script-runtime.ts";

const STORAGE_KEY = "opencharts_pine_script_source_v1";
const DEFAULT_SOURCE = `//@version=5
indicator("EMA 9 / 21", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
plot(fast, "EMA 9", color=color.green, linewidth=2)
plot(slow, "EMA 21", color=color.red, linewidth=2)
`;
interface PineScriptEditorProps { candles: Candle[]; onExecution: (result: PineExecutionResult | null) => void; }
export function PineScriptEditor({ candles, onExecution }: PineScriptEditorProps) {
  const [code, setCode] = useState(() => safeStorage.getItem(STORAGE_KEY) || DEFAULT_SOURCE);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<PineExecutionResult | null>(null);
  const run = async () => {
    setRunning(true); setError("");
    try {
      const next = await executePineScript(code, candles);
      setResult(next); onExecution(next); safeStorage.setItem(STORAGE_KEY, code);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause)); setResult(null); onExecution(null);
    } finally { setRunning(false); }
  };
  return <div className="flex h-full min-h-0 flex-col gap-2 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-semibold text-sm">Pine Script Editor</div><p className="text-muted-foreground mt-0.5">Dán mã Pine v5/v6. Tự nhận diện indicator() hoặc strategy().</p></div>
      <button type="button" onClick={run} disabled={running || candles.length < 2} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50">{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{running ? "Đang chạy..." : "Thêm vào biểu đồ / Chạy"}</button></div>
    <textarea value={code} onChange={event => setCode(event.target.value)} spellCheck={false} aria-label="Pine Script source" className="min-h-[150px] flex-1 resize-y rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-5 outline-none focus:border-primary" />
    {error && <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{error}</span></div>}
    {result && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2"><span className="inline-flex items-center gap-1 font-medium text-emerald-600"><CheckCircle2 className="h-3.5 w-3.5" />{result.kind === "strategy" ? "Strategy" : "Indicator"}: {result.title}</span><span className="text-muted-foreground">Pine v{result.version}</span><span className="text-muted-foreground">{result.plots.length} plot</span>{result.kind === "strategy" && <span className="text-muted-foreground">{result.summary.totalTrades} giao dịch · {result.summary.totalPoints >= 0 ? "+" : ""}{result.summary.totalPoints.toFixed(2)} điểm</span>}</div>}
    {result?.warnings.map((warning,index)=><p key={index} className="text-amber-600">{warning}</p>)}
    {!result && !error && <p className="text-muted-foreground">Dữ liệu nến hiện có: {candles.length.toLocaleString("vi-VN")} bars.</p>}
  </div>;
}
