import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, CandlestickData, Time, SeriesMarker } from "lightweight-charts";
import type { PineExecutionResult } from "../../lib/pine-script-runtime.ts";

export function usePinePlots(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  chartData: CandlestickData<Time>[],
  execution: PineExecutionResult | null,
): void {
  const seriesRef = useRef<Array<ISeriesApi<"Line">>>([]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      for (const series of seriesRef.current) {
        try { chart.removeSeries(series); } catch { /* chart disposed */ }
      }
    }
    seriesRef.current = [];

    const candleSeries = candleSeriesRef.current;
    if (candleSeries) candleSeries.setMarkers([]);

    if (!chart || !candleSeries || !execution || chartData.length === 0) return;

    for (const plot of execution.plots) {
      const data = plot.data
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
        .map((point) => ({ time: point.time as Time, value: point.value }));
      if (!data.length) continue;
      const color = plot.color || "#a78bfa";
      const series = chart.addLineSeries({
        color,
        lineWidth: 2,
        priceScaleId: "right",
        title: plot.title,
        lastValueVisible: true,
        priceLineVisible: false,
      });
      series.setData(data);
      seriesRef.current.push(series);
    }

    if (execution.kind === "strategy") {
      const validTimes = new Set(chartData.map((bar) => Number(bar.time)));
      const markers: SeriesMarker<Time>[] = [];
      for (const trade of execution.trades) {
        const entryTime = Math.floor(trade.entryTime / 1000);
        const exitTime = Math.floor(trade.exitTime / 1000);
        if (validTimes.has(entryTime)) {
          markers.push({
            time: entryTime as Time,
            position: trade.side === "LONG" ? "belowBar" : "aboveBar",
            color: trade.side === "LONG" ? "#16a34a" : "#dc2626",
            shape: trade.side === "LONG" ? "arrowUp" : "arrowDown",
            text: `${trade.side} ${trade.quantity}`,
          });
        }
        if (validTimes.has(exitTime)) {
          markers.push({
            time: exitTime as Time,
            position: trade.side === "LONG" ? "aboveBar" : "belowBar",
            color: trade.pnlPoints >= 0 ? "#16a34a" : "#dc2626",
            shape: "circle",
            text: `Đóng ${trade.pnlPoints >= 0 ? "+" : ""}${trade.pnlPoints.toFixed(1)}đ`,
          });
        }
      }
      candleSeries.setMarkers(markers.sort((a, b) => Number(a.time) - Number(b.time)));
    }

    return () => {
      const currentChart = chartRef.current;
      if (currentChart) {
        for (const series of seriesRef.current) {
          try { currentChart.removeSeries(series); } catch { /* chart disposed */ }
        }
      }
      seriesRef.current = [];
      candleSeriesRef.current?.setMarkers([]);
    };
  }, [chartData, execution]);
}
