import { readFile } from "node:fs/promises";
import { executePineScript, getPineInputs } from "../src/lib/pine-script-runtime.ts";

const source = await readFile("examples/pine-scripts/opencharts-feature-test.pine", "utf8");
const candles = Array.from({ length: 420 }, (_, index) => {
  const close = 1800 + Math.sin(index / 8) * 28 + Math.sin(index / 2.8) * 7 + index * 0.015;
  const open = close + Math.sin(index * 1.7) * 2;
  return {
    time: 1_700_000_000 + index * 60,
    open,
    high: Math.max(open, close) + 3,
    low: Math.min(open, close) - 3,
    close,
    volume: 100 + (index % 23) * 11,
  };
});

// Overlay metadata must follow PineTS declaration props. EMA/SMA plots from an
// overlay indicator must share the candle price scale; pane indicators must not.
const overlayResult = await executePineScript(`
//@version=5
indicator("EMA SMA overlay test", overlay=true)
plot(ta.ema(close, 9), "EMA")
plot(ta.sma(close, 20), "SMA")
`, candles);
if (overlayResult.plots.length !== 2 || overlayResult.plots.some(plot => !plot.overlay)) {
  throw new Error("Pine overlay=true must be propagated to every EMA/SMA plot");
}
const candleTimes = new Set(candles.map(candle => candle.time));
for (const plot of overlayResult.plots) {
  const times = plot.data.map(point => point.time);
  if (times.some(time => !candleTimes.has(time)) || times.some((time, index) => index > 0 && time <= times[index - 1])) {
    throw new Error(`${plot.title} timestamps must map to chart candles in strictly increasing order`);
  }
  if (times.at(-1) !== candles.at(-1)?.time) {
    throw new Error(`${plot.title} must include the latest candle timestamp`);
  }
}
const paneResult = await executePineScript(`
//@version=5
indicator("Pane oscillator test", overlay=false)
plot(ta.ema(close, 9), "Pane EMA")
`, candles);
if (paneResult.plots.length !== 1 || paneResult.plots[0].overlay) {
  throw new Error("Pine overlay=false must keep plots on an independent pane scale");
}

const inputs = getPineInputs(source);
if (inputs.length < 5) throw new Error(`Expected Pine inputs to be detected; got ${inputs.length}`);

const timeframeInputSource = `
//@version=5
indicator("Timeframe input regression", overlay=true)
tfInput = input.timeframe("D", "Timeframe")
plot(request.security(syminfo.tickerid, tfInput, close), "HTF close")
`;
const timeframeMeta = getPineInputs(timeframeInputSource).find(input => input.varId === "tfInput" || input.title === "Timeframe");
if (!timeframeMeta) throw new Error("Pine timeframe input metadata was not detected");
const staleTimeframeResult = await executePineScript(timeframeInputSource, candles, { [timeframeMeta.id]: true });
if (!staleTimeframeResult.plots.length) throw new Error("A stale boolean timeframe override should fall back to its string default");
const customTimeframeResult = await executePineScript(timeframeInputSource, candles, { [timeframeMeta.id]: "60" });
if (!customTimeframeResult.plots.length) throw new Error("A string timeframe override should execute");

const result = await executePineScript(source, candles);
if (result.kind !== "strategy") throw new Error("Sample must be detected as a strategy");
if (result.plots.length < 3) throw new Error(`Expected visible plots; got ${result.plots.length}`);
if (result.plots.some(plot => plot.title === "RSI ẩn" || plot.title === "Security cùng khung")) {
  throw new Error("display.none plots must not be rendered");
}

const raw = Object.values(result.rawPlots) as Array<{ options?: { style?: string } }>;
const styles = new Set(raw.map(plot => String(plot.options?.style ?? "")));
for (const required of ["fill", "shape", "char", "background", "barcolor", "candle"]) {
  if (!styles.has(required)) throw new Error(`Pine feature not emitted: ${required}`);
}

// PineTS intentionally serializes plotarrow() as style "shape", with the
// direction stored in each point as shape_arrow_up / shape_arrow_down.
const arrowRaw = (result.rawPlots as Record<string, any>)["Hướng biến động"];
const arrowDirections = (arrowRaw?.data ?? []).map((point: any) => point?.options?.shape);
if (!arrowRaw || arrowRaw.options?.style !== "shape" || !arrowDirections.some((shape: unknown) => shape === "shape_arrow_up" || shape === "shape_arrow_down")) {
  throw new Error("plotarrow() must emit directional shape markers");
}
if (result.summary.totalTrades < 1) throw new Error("Strategy sample did not produce any closed trades");

const drawingCount = (key: string) => {
  const data = (result.rawPlots as Record<string, any>)[key]?.data;
  const value = Array.isArray(data) ? data[data.length - 1]?.value : null;
  return Array.isArray(value) ? value.filter((item: any) => item && !item._deleted).length : 0;
};
for (const [key, name] of [["__lines__", "line.new"], ["__boxes__", "box.new"], ["__labels__", "label.new"], ["__tables__", "table.new"]]) {
  if (drawingCount(key) < 1) throw new Error(`Pine drawing not emitted: ${name}`);
}

console.log(
  `Pine sample passed: ${inputs.length} inputs, ${result.plots.length} visible plots, ${result.summary.totalTrades} closed trades, ${result.summary.totalPoints.toFixed(2)} points.`,
);
