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

const inputs = getPineInputs(source);
if (inputs.length < 5) throw new Error(`Expected Pine inputs to be detected; got ${inputs.length}`);

const result = await executePineScript(source, candles);
if (result.kind !== "strategy") throw new Error("Sample must be detected as a strategy");
if (result.plots.length < 3) throw new Error(`Expected visible plots; got ${result.plots.length}`);
if (result.plots.some(plot => plot.title === "RSI ẩn" || plot.title === "Security cùng khung")) {
  throw new Error("display.none plots must not be rendered");
}

const raw = Object.values(result.rawPlots) as Array<{ options?: { style?: string } }>;
const styles = new Set(raw.map(plot => String(plot.options?.style ?? "")));
console.log("Pine raw styles:", [...styles].sort());
console.log("Pine normalized plots:", result.plots.map(plot => ({ id: plot.id, title: plot.title, type: plot.type, points: plot.data.length })));
for (const required of ["fill", "hline", "shape", "char", "background", "barcolor", "candle"]) {
  if (!styles.has(required)) throw new Error(`Pine feature not emitted: ${required}`);
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
