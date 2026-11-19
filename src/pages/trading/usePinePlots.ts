import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, CandlestickData, Time } from "lightweight-charts";
import type { Candle } from "../../services/schemas.ts";
import type { PineExecutionResult } from "../../lib/pine-script-runtime.ts";

type AnyRecord = Record<string, any>;
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function colorOr(value: unknown, fallback: string): string { return typeof value === "string" && value !== "na" ? value : fallback; }

export function usePinePlots(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  chartData: CandlestickData<Time>[],
  candles: Candle[],
  execution: PineExecutionResult | null,
): void {
  const seriesRef = useRef<Array<ISeriesApi<"Line" | "Area" | "Histogram">>>([]);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    if (chart) for (const series of seriesRef.current) { try { chart.removeSeries(series); } catch { /* chart disposed */ } }
    seriesRef.current = [];
    if (!chart || !candleSeries || !container || !execution || chartData.length === 0) return;

    // Pine plot() outputs are native Lightweight Charts series. Drawing objects
    // and shape plots use a separate non-interactive canvas so they never steal
    // mouse/touch input from the chart.
    for (const plot of execution.plots) {
      const style = plot.type.replace(/^style_/, "");
      if (style === "shape" || style === "char" || style === "background" || style === "barcolor" || style === "bar" || style === "candle") continue;
      const data = plot.data.filter(point => finite(point.time) && finite(point.value)).map(point => ({
        time: point.time as Time, value: point.value, ...(point.color ? { color: point.color } : {}),
      }));
      if (!data.length) continue;
      const common = {
        title: plot.title, priceScaleId: "right", lastValueVisible: true, priceLineVisible: false,
        visible: true,
      };
      if (style === "area" || style === "areabr") {
        const series = chart.addAreaSeries({ ...common, lineColor: plot.color || "#2962ff", topColor: plot.color || "#2962ff", bottomColor: "rgba(41,98,255,0.03)" });
        series.setData(data); seriesRef.current.push(series);
      } else if (style === "histogram" || style === "columns") {
        const series = chart.addHistogramSeries({ ...common, color: plot.color || "#2962ff", base: finite(plot.options.histbase) ? plot.options.histbase : 0 });
        series.setData(data); seriesRef.current.push(series);
      } else {
        const width = Math.max(1, Math.min(4, Number(plot.options.linewidth) || 2));
        const series = chart.addLineSeries({ ...common, color: plot.color || "#2962ff", lineWidth: width as 1 | 2 | 3 | 4, lineStyle: style === "stepline" ? 0 : 0, crosshairMarkerVisible: false });
        series.setData(data); seriesRef.current.push(series);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.dataset.pineOverlay = "true";
    Object.assign(canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "8" });
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const timeScale = chart.timeScale();
    const candleByTime = new Map<number, Candle>();
    candles.forEach(c => candleByTime.set(Number(c.time), c));
    const indexByTime = new Map<number, number>();
    chartData.forEach((bar, index) => indexByTime.set(Number(bar.time), index));
    const plotWidth = () => Math.min(container.clientWidth, timeScale.width());

    const xAt = (time: number): number | null => {
      const x = timeScale.timeToCoordinate(time as Time);
      return x === null ? null : x;
    };
    const drawingX = (value: number, xloc: string): number | null => {
      if (xloc.toLowerCase().includes("time")) {
        const seconds = value > 1e12 ? Math.floor(value / 1000) : value;
        return xAt(seconds);
      }
      const bar = candles[Math.round(value)];
      return bar ? xAt(Number(bar.time)) : null;
    };
    const priceY = (value: number): number | null => {
      const y = candleSeries.priceToCoordinate(value);
      return y === null ? null : y;
    };
    const latestObjects = (key: string): AnyRecord[] => {
      const entries = execution.rawPlots[key]?.data;
      if (!Array.isArray(entries) || entries.length === 0) return [];
      const value = entries[entries.length - 1]?.value;
      return Array.isArray(value) ? value.filter((item: AnyRecord) => item && !item._deleted) : [];
    };

    const drawShape = (x: number, y: number, shape: string, color: string, text: string, textColor: string, size: number) => {
      if (!ctx) return;
      ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      const s = Math.max(3, Math.min(11, size));
      const normalized = shape.toLowerCase();
      ctx.beginPath();
      if (normalized.includes("arrow") || normalized.includes("triangle")) {
        const up = normalized.includes("up") || normalized.includes("triangleup");
        ctx.moveTo(x, y + (up ? -s : s)); ctx.lineTo(x - s, y + (up ? s : -s)); ctx.lineTo(x + s, y + (up ? s : -s)); ctx.closePath(); ctx.fill();
      } else if (normalized.includes("diamond")) {
        ctx.moveTo(x, y-s); ctx.lineTo(x+s, y); ctx.lineTo(x,y+s); ctx.lineTo(x-s,y); ctx.closePath(); ctx.fill();
      } else if (normalized.includes("cross") || normalized.includes("xcross")) {
        ctx.moveTo(x-s,y-s);ctx.lineTo(x+s,y+s);ctx.moveTo(x+s,y-s);ctx.lineTo(x-s,y+s);ctx.stroke();
      } else if (normalized.includes("square")) { ctx.fillRect(x-s,y-s,s*2,s*2); }
      else { ctx.arc(x,y,s,0,Math.PI*2); ctx.fill(); }
      if (text) {
        ctx.font = "11px Arial"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillStyle = textColor; ctx.fillText(text, x, y - s - 3);
      }
      ctx.restore();
    };

    const draw = () => {
      if (!ctx) return;
      const width = container.clientWidth, height = container.clientHeight;
      if (!width || !height) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) {
        canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
      }
      ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,width,height);
      const rightEdge = plotWidth();

      // plotshape(), plotchar(), plotarrow()
      for (const plot of execution.plots) {
        const style = plot.type.replace(/^style_/, "");
        if (!["shape","char"].includes(style)) continue;
        for (const point of plot.data) {
          const raw = execution.rawPlots[plot.id]?.data?.find((p: AnyRecord) => Number(p.time) === (point.time > 1e12 ? point.time*1000 : point.time));
          const options = raw?.options ?? {};
          if (style === "shape" && !point.value) continue;
          const x = xAt(point.time); if (x === null) continue;
          const bar = candleByTime.get(point.time);
          let y: number | null = null;
          const location = String(options.location ?? "BelowBar").toLowerCase();
          if (location.includes("above")) y = bar ? priceY(bar.high) : null;
          else if (location.includes("below")) y = bar ? priceY(bar.low) : null;
          else if (location === "top") y = 16;
          else if (location === "bottom") y = height - 16;
          else y = priceY(point.value);
          if (y === null) continue;
          const shape = String(options.shape ?? (style === "char" ? "char" : "circle"));
          const text = String(options.text ?? options.char ?? "");
          const markerSize = String(options.size ?? "normal");
          const size = markerSize === "tiny" ? 3 : markerSize === "small" ? 4 : markerSize === "large" ? 7 : markerSize === "huge" ? 9 : 5;
          drawShape(x, y, shape, colorOr(options.color, plot.color || "#2962ff"), text, colorOr(options.textcolor, "#ffffff"), size);
        }
      }

      // line.new(), box.new(), label.new()
      for (const line of latestObjects("__lines__")) {
        const x1 = drawingX(Number(line.x1), String(line.xloc ?? "bi"));
        const x2 = drawingX(Number(line.x2), String(line.xloc ?? "bi"));
        const y1 = priceY(Number(line.y1)), y2 = priceY(Number(line.y2));
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
        ctx.save(); ctx.strokeStyle = colorOr(line.color, "#2962ff"); ctx.lineWidth = Math.max(1, Number(line.width)||1);
        if (String(line.style).includes("dashed")) ctx.setLineDash([7,4]); else if (String(line.style).includes("dotted")) ctx.setLineDash([2,3]);
        const extend = String(line.extend ?? "none");
        const dx=x2-x1, dy=y2-y1;
        let ax=x1, ay=y1, bx=x2, by=y2;
        if (Math.abs(dx)>0.001 && (extend.includes("right") || extend.includes("left") || extend.includes("both"))) {
          const slope=dy/dx;
          if (extend.includes("left") || extend.includes("both")) { ay=y1+(0-x1)*slope; ax=0; }
          if (extend.includes("right") || extend.includes("both")) { by=y1+(rightEdge-x1)*slope; bx=rightEdge; }
        }
        ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.restore();
      }
      for (const box of latestObjects("__boxes__")) {
        const x1=drawingX(Number(box.left),String(box.xloc??"bi")), x2=drawingX(Number(box.right),String(box.xloc??"bi"));
        const y1=priceY(Number(box.top)), y2=priceY(Number(box.bottom));
        if(x1===null||x2===null||y1===null||y2===null) continue;
        const left=Math.min(x1,x2), top=Math.min(y1,y2), w=Math.abs(x2-x1), h=Math.abs(y2-y1);
        ctx.save();ctx.fillStyle=colorOr(box.bgcolor,"rgba(41,98,255,0.12)");ctx.strokeStyle=colorOr(box.border_color,"#2962ff");
        ctx.lineWidth=Math.max(0,Number(box.border_width)||1);ctx.fillRect(left,top,w,h);if(ctx.lineWidth)ctx.strokeRect(left,top,w,h);
        if(box.text){ctx.fillStyle=colorOr(box.text_color,"#fff");ctx.font="12px Arial";ctx.fillText(String(box.text),left+5,top+15);}
        ctx.restore();
      }
      for (const label of latestObjects("__labels__")) {
        const x=drawingX(Number(label.x),String(label.xloc??"bi"));
        if(x===null) continue;
        const yloc=String(label.yloc??"price").toLowerCase();
        const y=yloc.includes("above") ? priceY(candleByTime.get(Number(candles[Math.round(Number(label.x))]?.time))?.high ?? Number(label.y)) :
          yloc.includes("below") ? priceY(candleByTime.get(Number(candles[Math.round(Number(label.x))]?.time))?.low ?? Number(label.y)) : priceY(Number(label.y));
        if(y===null) continue;
        const text=String(label.text??""); const color=colorOr(label.color,"#2962ff");
        ctx.save();ctx.font="12px Arial";const tw=ctx.measureText(text).width;
        ctx.fillStyle=color;ctx.fillRect(x-tw/2-5,y-17,tw+10,22);
        ctx.fillStyle=colorOr(label.textcolor,"#fff");ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(text,x,y-6);ctx.restore();
      }

      // Strategy execution marks, independent of the app's own chart markers.
      if(execution.kind==="strategy") for(const trade of execution.trades){
        const entryX=xAt(Math.floor(trade.entryTime/1000));
        const entryBar=candleByTime.get(Math.floor(trade.entryTime/1000));
        const entryY=entryBar ? priceY(trade.side==="LONG"?entryBar.low:entryBar.high) : null;
        if(entryX!==null&&entryY!==null) drawShape(entryX,entryY,trade.side==="LONG"?"arrow_up":"arrow_down",trade.side==="LONG"?"#16a34a":"#dc2626",trade.side+" "+trade.quantity,"#ffffff",6);
        if(!trade.isOpen){
          const exitX=xAt(Math.floor(trade.exitTime/1000));
          const exitBar=candleByTime.get(Math.floor(trade.exitTime/1000));
          const exitY=exitBar?priceY(trade.side==="LONG"?exitBar.high:exitBar.low):null;
          if(exitX!==null&&exitY!==null) drawShape(exitX,exitY,"circle",trade.pnlPoints>=0?"#16a34a":"#dc2626",(trade.pnlPoints>=0?"+":"")+trade.pnlPoints.toFixed(1),"#ffffff",4);
        }
      }
    };

    const scheduleDraw = () => requestAnimationFrame(draw);
    const onRange = () => scheduleDraw();
    const onPointer = () => scheduleDraw();
    const observer = new ResizeObserver(scheduleDraw);
    observer.observe(container);
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    container.addEventListener("wheel",onPointer,{passive:true});
    container.addEventListener("pointermove",onPointer,{passive:true});
    container.addEventListener("touchmove",onPointer,{passive:true});
    draw();

    return () => {
      observer.disconnect();
      timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
      container.removeEventListener("wheel",onPointer);
      container.removeEventListener("pointermove",onPointer);
      container.removeEventListener("touchmove",onPointer);
      canvas.remove();
      const currentChart=chartRef.current;
      if(currentChart) for(const series of seriesRef.current){try{currentChart.removeSeries(series);}catch{/* chart disposed */}}
      seriesRef.current=[];
    };
  }, [chartData, candles, execution, chartRef, candleSeriesRef, containerRef]);
}
