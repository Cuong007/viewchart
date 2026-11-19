import { PineTS } from "pinets";
import type { Candle } from "../services/schemas.ts";

export type PineProgramKind = "indicator" | "strategy";
export interface PinePlotPoint { time: number; value: number; color?: string; }
export interface PinePlot { id: string; title: string; type: string; color?: string; overlay: boolean; options: Record<string, any>; data: PinePlotPoint[]; }
export interface PineTrade {
  id: string; side: "LONG" | "SHORT"; quantity: number; entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number; pnlPoints: number; isOpen: boolean;
}
export interface PineExecutionResult {
  kind: PineProgramKind; title: string; version: number; plots: PinePlot[]; rawPlots: Record<string, any>; trades: PineTrade[];
  summary: { totalTrades: number; winningTrades: number; losingTrades: number; winRate: number; totalPoints: number; averagePoints: number; };
  warnings: string[];
}
export function detectPineProgram(code: string): { kind: PineProgramKind; version: number; title: string } {
  const versionMatch = code.match(/^\s*\/\/@version\s*=\s*(\d+)/m);
  const declaration = code.match(/\b(indicator|strategy)\s*\(\s*(?:"([^"]*)"|'([^']*)')?/);
  if (!versionMatch) throw new Error("Không tìm thấy khai báo phiên bản Pine. Ví dụ: //@version=5");
  if (!declaration) throw new Error("Không tìm thấy indicator() hoặc strategy() trong mã Pine.");
  return { kind: declaration[1] === "strategy" ? "strategy" : "indicator", version: Number(versionMatch[1]), title: declaration[2] || declaration[3] || (declaration[1] === "strategy" ? "Pine Strategy" : "Pine Indicator") };
}
function candleToPineData(candle: Candle) {
  const openTime = Number(candle.time) * 1000;
  return { openTime, closeTime: openTime, open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume ?? 0) };
}
function normalizePlots(rawPlots: unknown): PinePlot[] {
  if (!rawPlots || typeof rawPlots !== "object") return [];
  return Object.entries(rawPlots as Record<string, any>)
    .filter(([id]) => !id.startsWith("__"))
    .map(([id, raw]) => {
      const values = Array.isArray(raw?.data) ? raw.data : [];
      const data: PinePlotPoint[] = values.flatMap((point: any) => {
        const time = Number(point?.time ?? point?.timestamp);
        const value = Number(point?.value);
        if (!Number.isFinite(time) || !Number.isFinite(value)) return [];
        return [{ time: time > 1e12 ? Math.floor(time / 1000) : time, value,
          ...(typeof point?.options?.color === "string" ? { color: point.options.color } : {}) }];
      });
      const options = raw?.options && typeof raw.options === "object" ? raw.options : {};
      return {
        id, title: String(raw?.title ?? options.title ?? id),
        type: String(options.style ?? raw?.type ?? "line"),
        color: typeof options.color === "string" ? options.color : "#2962ff",
        overlay: options.overlay !== false, options, data,
      };
    }).filter(plot => plot.data.length > 0);
}
export async function executePineScript(code: string, candles: Candle[]): Promise<PineExecutionResult> {
  const program = detectPineProgram(code);
  if (program.version !== 5 && program.version !== 6) throw new Error(`Pine Script v${program.version} chưa được hỗ trợ. Hiện hỗ trợ v5/v6 theo khả năng của PineTS.`);
  if (candles.length < 2) throw new Error("Không đủ dữ liệu nến để chạy Pine Script.");
  const source = candles.map(candleToPineData).filter(bar => Number.isFinite(bar.openTime) && Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
  if (!source.length) throw new Error("Dữ liệu OHLCV không hợp lệ.");
  const runtime = new PineTS(source);
  const context = await runtime.run(code);
  const strategyContext = (context as any)?.strategy;
  const closed = program.kind === "strategy" && Array.isArray(strategyContext?.closedtrades) ? strategyContext.closedtrades : [];
  const open = program.kind === "strategy" && Array.isArray(strategyContext?.opentrades) ? strategyContext.opentrades : [];
  const mapTrade = (trade: any, index: number, isOpen: boolean): PineTrade => {
    const quantity = Math.round(Math.abs(Number(trade.size) || 0));
    const side = Number(trade.size) < 0 ? "SHORT" : "LONG";
    const entryPrice = Number(trade.entry_price) || 0;
    const exitPrice = isOpen ? Number(candles[candles.length - 1]?.close) || entryPrice : Number(trade.exit_price) || 0;
    return { id: String(trade.id ?? trade.entry_id ?? index + 1), side, quantity, entryPrice, exitPrice,
      entryTime: Number(trade.entry_time) || 0,
      exitTime: isOpen ? Number(candles[candles.length - 1]?.time) * 1000 : Number(trade.exit_time) || 0,
      pnlPoints: (side === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice) * quantity, isOpen };
  };
  const closedTrades: PineTrade[] = closed.map((trade: any, index: number) => mapTrade(trade, index, false));
  const openTrades: PineTrade[] = open.map((trade: any, index: number) => mapTrade(trade, closed.length + index, true));
  const trades = [...closedTrades, ...openTrades];
  const wins = closedTrades.filter(trade => trade.pnlPoints > 0).length;
  const totalPoints = closedTrades.reduce((sum, trade) => sum + trade.pnlPoints, 0);
  return {
    ...program, plots: normalizePlots((context as any)?.plots), rawPlots: (context as any)?.plots ?? {}, trades,
    summary: { totalTrades: closedTrades.length, winningTrades: wins, losingTrades: closedTrades.filter(trade => trade.pnlPoints < 0).length, winRate: closedTrades.length ? wins / closedTrades.length * 100 : 0, totalPoints, averagePoints: closedTrades.length ? totalPoints / closedTrades.length : 0 },
    warnings: Array.isArray((context as any)?.warnings) ? (context as any).warnings.map((warning: any) => String(warning?.message ?? warning)) : [],
  };
}
