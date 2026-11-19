import { useEffect, useRef } from "react";
import type { IChartApi, ISeriesApi, CandlestickData, Time } from "lightweight-charts";
import type { Candle } from "../../services/schemas.ts";
import type { PineExecutionResult } from "../../lib/pine-script-runtime.ts";

type AnyRecord = Record<string, any>;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const colorOr = (value: unknown, fallback: string): string => typeof value === "string" && value !== "na" ? value : fallback;

export function usePinePlots(
  chartRef: React.RefObject<IChartApi | null>,
  candleSeriesRef: React.RefObject<ISeriesApi<"Candlestick"> | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  chartData: CandlestickData<Time>[],
  candles: Candle[],
  execution: PineExecutionResult | null,
): void {
  const seriesRef = useRef<Array<ISeriesApi<any>>>([]);
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const container = containerRef.current;
    if (chart) for (const series of seriesRef.current) { try { chart.removeSeries(series); } catch { /* chart disposed */ } }
    seriesRef.current = [];
    if (!chart || !candleSeries || !container || !execution || chartData.length === 0) return;

    const indexByTime = new Map<number,number>();
    chartData.forEach((bar,index)=>indexByTime.set(Number(bar.time),index));
    const rawTime=(time:unknown)=>{const n=Number(time);return n>1e12?Math.floor(n/1000):n;};

    const shiftedTime = (time:number, offset:number):number => {
      const sourceIndex=indexByTime.get(time);
      if(sourceIndex===undefined||!Number.isFinite(offset)||offset===0)return time;
      const shifted=Number(chartData[sourceIndex+Math.trunc(offset)]?.time);
      return Number.isFinite(shifted)?shifted:time;
    };

    for (const plot of execution.plots) {
      const style = plot.type.replace(/^style_/, "");
      if (["shape","char","background","barcolor","bar","candle"].includes(style)) continue;
      const data = plot.data.flatMap(point => {
        if (!finite(point.time) || !finite(point.value)) return [];
        const sourceIndex = indexByTime.get(point.time);
        const targetIndex = sourceIndex === undefined ? undefined : sourceIndex + (Number(point.offset) || 0);
        const targetTime = targetIndex === undefined ? point.time : Number(chartData[targetIndex]?.time);
        if (!Number.isFinite(targetTime)) return [];
        return [{ time: targetTime as Time, value: point.value, ...(point.color ? { color: point.color } : {}) }];
      }).sort((a,b) => Number(a.time) - Number(b.time));
      if (!data.length) continue;
      const common = { title: plot.title, priceScaleId: "right", lastValueVisible: true, priceLineVisible: false };
      if (style === "area" || style === "areabr") {
        const series = chart.addAreaSeries({ ...common, lineColor: plot.color || "#2962ff", topColor: plot.color || "#2962ff", bottomColor: "rgba(41,98,255,0.03)" });
        series.setData(data); seriesRef.current.push(series);
      } else if (style === "histogram" || style === "columns") {
        const series = chart.addHistogramSeries({ ...common, color: plot.color || "#2962ff", base: finite(plot.options.histbase) ? plot.options.histbase : 0 });
        series.setData(data); seriesRef.current.push(series);
      } else {
        const width = Math.max(1, Math.min(4, Number(plot.options.linewidth) || 2));
        const styleName = String(plot.type);
        const lineStyle = styleName === "hline" || styleName === "style_hline"
          ? (String(plot.options.linestyle).includes("dotted") ? 1 : String(plot.options.linestyle).includes("dashed") ? 2 : 0)
          : 0;
        const lineType = styleName.includes("stepline") ? 1 : 0;
        const circles = styleName.includes("circles");
        const series = chart.addLineSeries({
          ...common,
          color: plot.color || "#2962ff",
          lineWidth: width as 1 | 2 | 3 | 4,
          lineStyle,
          lineType,
          crosshairMarkerVisible: false,
          pointMarkersVisible: circles,
          pointMarkersRadius: circles ? Math.max(2, width + 1) : 0,
        });
        series.setData(data); seriesRef.current.push(series);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.dataset.pineOverlay = "true";
    Object.assign(canvas.style, { position:"absolute", inset:"0", width:"100%", height:"100%", pointerEvents:"none", zIndex:"8" });
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const timeScale = chart.timeScale();
    const candleByTime = new Map<number,Candle>();
    candles.forEach(c=>candleByTime.set(Number(c.time),c));
    const xAt = (time:number):number|null => timeScale.timeToCoordinate(time as Time);
    const drawingX = (value:number,xloc:string):number|null => {
      if(xloc.toLowerCase().includes("time")||xloc==="bt") return xAt(value>1e12?Math.floor(value/1000):value);
      const bar=candles[Math.round(value)]; return bar?xAt(Number(bar.time)):null;
    };
    const priceY = (value:number):number|null => candleSeries.priceToCoordinate(value);
    const latestObjects = (key:string):AnyRecord[] => {
      const entries=execution.rawPlots[key]?.data;
      if(!Array.isArray(entries)||!entries.length) return [];
      const value=entries[entries.length-1]?.value;
      return Array.isArray(value)?value.filter((item:AnyRecord)=>item&&!item._deleted):[];
    };
    const drawShape = (x:number,y:number,shape:string,color:string,text:string,textColor:string,size:number) => {
      if(!ctx)return;
      ctx.save();ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=1.5;
      const s=Math.max(3,Math.min(11,size)),name=shape.toLowerCase();ctx.beginPath();
      if(name.includes("arrow")||name.includes("triangle")||name.includes("labelup")||name.includes("labeldown")){
        const up=name.includes("up");ctx.moveTo(x,y+(up?-s:s));ctx.lineTo(x-s,y+(up?s:-s));ctx.lineTo(x+s,y+(up?s:-s));ctx.closePath();ctx.fill();
      }else if(name.includes("diamond")){ctx.moveTo(x,y-s);ctx.lineTo(x+s,y);ctx.lineTo(x,y+s);ctx.lineTo(x-s,y);ctx.closePath();ctx.fill();}
      else if(name.includes("cross")){ctx.moveTo(x-s,y-s);ctx.lineTo(x+s,y+s);ctx.moveTo(x+s,y-s);ctx.lineTo(x-s,y+s);ctx.stroke();}
      else if(name.includes("square"))ctx.fillRect(x-s,y-s,s*2,s*2);
      else{ctx.arc(x,y,s,0,Math.PI*2);ctx.fill();}
      if(text){ctx.font="11px Arial";ctx.textAlign="center";ctx.textBaseline="bottom";ctx.fillStyle=textColor;ctx.fillText(text,x,y-s-3);}
      ctx.restore();
    };
    const draw = () => {
      if(!ctx)return;
      const width=container.clientWidth,height=container.clientHeight;
      if(!width||!height)return;
      const dpr=Math.max(1,window.devicePixelRatio||1);
      if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);
      const rightEdge=Math.min(width,timeScale.width());

      // fill(plot1, plot2): shade the area between two Pine plot/hline series.
      // PineTS stores fill() as its own plot entry and keeps the source plot keys
      // plus the per-bar fill color in options.
      const seriesValues = new Map<string,Map<number,number>>();
      const valueAt = (key:string, time:number):number|null => {
        let values=seriesValues.get(key);
        if(!values){
          values=new Map<number,number>();
          const source=execution.rawPlots[key];
          if(Array.isArray(source?.data))for(const point of source.data){
            const value=Number(point?.value),sourceTime=rawTime(point.time);
            const timeKey=shiftedTime(sourceTime,Number(point?.options?.offset)||0);
            if(Number.isFinite(value)&&Number.isFinite(timeKey))values.set(timeKey,value);
          }
          seriesValues.set(key,values);
        }
        return values.get(time)??null;
      };
      for(const [fillId,fill] of Object.entries(execution.rawPlots) as [string,AnyRecord][]){
        if(fillId.startsWith("__")||fill?.options?.style!=="fill"||!Array.isArray(fill.data))continue;
        const firstKey=String(fill.plot1??fill.options.plot1??"");
        const secondKey=String(fill.plot2??fill.options.plot2??"");
        if(!firstKey||!secondKey)continue;
        const first=execution.rawPlots[firstKey],second=execution.rawPlots[secondKey];
        if(!Array.isArray(first?.data)||!Array.isArray(second?.data))continue;
        const times=[...new Set<number>(first.data.map((p:AnyRecord)=>shiftedTime(rawTime(p.time),Number(p?.options?.offset)||0)).filter((t:number)=>Number.isFinite(t)))].sort((a,b)=>a-b);
        for(let index=0;index<times.length-1;index++){
          const t1=times[index]!,t2=times[index+1]!;
          const a1=valueAt(firstKey,t1),b1=valueAt(secondKey,t1),a2=valueAt(firstKey,t2),b2=valueAt(secondKey,t2);
          if(a1===null||b1===null||a2===null||b2===null)continue;
          const x1=xAt(t1),x2=xAt(t2),ay1=priceY(a1),by1=priceY(b1),ay2=priceY(a2),by2=priceY(b2);
          if(x1===null||x2===null||ay1===null||by1===null||ay2===null||by2===null)continue;
          const fillPoint=fill.data.find((p:AnyRecord)=>rawTime(p.time)===t1);
          const opts=fillPoint?.options??{};
          ctx.save();
          if(fill.options.gradient){
            const top=Number(opts.top_value),bottom=Number(opts.bottom_value);
            const topY=priceY(Number.isFinite(top)?top:Math.max(a1,b1));
            const bottomY=priceY(Number.isFinite(bottom)?bottom:Math.min(a1,b1));
            const gradient=ctx.createLinearGradient(0,topY??Math.min(ay1,by1),0,bottomY??Math.max(ay1,by1));
            gradient.addColorStop(0,colorOr(opts.top_color,"rgba(41,98,255,0.35)"));
            gradient.addColorStop(1,colorOr(opts.bottom_color,"rgba(41,98,255,0.05)"));
            ctx.fillStyle=gradient;
          }else{
            ctx.fillStyle=colorOr(opts.color,colorOr(fill.options.color,"rgba(41,98,255,0.18)"));
          }
          ctx.beginPath();ctx.moveTo(x1,ay1);ctx.lineTo(x2,ay2);ctx.lineTo(x2,by2);ctx.lineTo(x1,by1);ctx.closePath();ctx.fill();
          ctx.restore();
        }
      }
      const nextX=(time:number,x:number)=>{const i=indexByTime.get(time);return i===undefined||i>=chartData.length-1?x+8:(xAt(Number(chartData[i+1]!.time))??x+8);};

      // Pine bar-level visuals: bgcolor(), barcolor(), plotbar(), plotcandle().
      for(const [id,raw] of Object.entries(execution.rawPlots)){
        if(id.startsWith("__")||!Array.isArray(raw?.data))continue;
        const style=String(raw?.options?.style??"");
        if(!["background","barcolor","bar","candle"].includes(style))continue;
        for(const point of raw.data as AnyRecord[]){
          const time=rawTime(point.time),x=xAt(time);if(x===null)continue;
          const x2=nextX(time,x),barWidth=Math.max(2,Math.min(12,Math.abs(x2-x)*0.65)),options=point.options??{};
          if(style==="background"){
            if(point.value){ctx.save();ctx.fillStyle=colorOr(options.color,"rgba(41,98,255,0.12)");ctx.fillRect(x,0,Math.max(1,x2-x),height);ctx.restore();}
            continue;
          }
          const bar=candleByTime.get(time);
          if(style==="barcolor"){
            if(!point.value||!bar)continue;
            const yh=priceY(bar.high),yl=priceY(bar.low),yo=priceY(bar.open),yc=priceY(bar.close);
            if(yh===null||yl===null||yo===null||yc===null)continue;
            const color=colorOr(options.color,"#2962ff");ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;
            ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();ctx.fillRect(x-barWidth/2,Math.min(yo,yc),barWidth,Math.max(1,Math.abs(yc-yo)));ctx.restore();continue;
          }
          if(!Array.isArray(point.value)||point.value.length<4)continue;
          const values=point.value.map(Number),open=values[0]??NaN,high=values[1]??NaN,low=values[2]??NaN,close=values[3]??NaN,yh=priceY(high),yl=priceY(low),yo=priceY(open),yc=priceY(close);
          if(yh===null||yl===null||yo===null||yc===null)continue;
          const color=colorOr(options.color,close>=open?"#26a69a":"#ef5350");
          ctx.save();ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();
          if(style==="bar"){ctx.beginPath();ctx.moveTo(x-barWidth/2,yo);ctx.lineTo(x,yo);ctx.moveTo(x,yc);ctx.lineTo(x+barWidth/2,yc);ctx.stroke();}
          else{ctx.fillRect(x-barWidth/2,Math.min(yo,yc),barWidth,Math.max(1,Math.abs(yc-yo)));ctx.strokeStyle=colorOr(options.bordercolor,color);ctx.strokeRect(x-barWidth/2,Math.min(yo,yc),barWidth,Math.max(1,Math.abs(yc-yo)));}
          ctx.restore();
        }
      }

      // plotshape(), plotchar(), plotarrow().
      for(const plot of execution.plots){
        const style=plot.type.replace(/^style_/,"");if(!["shape","char"].includes(style))continue;
        const rawData=execution.rawPlots[plot.id]?.data??[];
        for(const point of plot.data){
          const raw=rawData.find((p:AnyRecord)=>rawTime(p.time)===point.time),options=raw?.options??{};
          if(style==="shape"&&!point.value)continue;
          const markerTime=shiftedTime(point.time,Number(point.offset)||0);
          const x=xAt(markerTime);if(x===null)continue;
          const bar=candleByTime.get(markerTime);const loc=String(options.location??"BelowBar").toLowerCase();
          let y:number|null=loc.includes("above")?(bar?priceY(bar.high):null):loc.includes("below")?(bar?priceY(bar.low):null):loc==="top"?16:loc==="bottom"?height-16:priceY(point.value);
          if(y===null)continue;
          const sizeName=String(options.size??"normal"),size=sizeName==="tiny"?3:sizeName==="small"?4:sizeName==="large"?7:sizeName==="huge"?9:5;
          drawShape(x,y,String(options.shape??(style==="char"?"char":"circle")),colorOr(options.color,plot.color||"#2962ff"),String(options.text??options.char??""),colorOr(options.textcolor,"#fff"),size);
        }
      }

      // line.new(), box.new(), linefill.new(), polyline.new(), table.new(), label.new().
      for(const line of latestObjects("__lines__")){
        const x1=drawingX(Number(line.x1),String(line.xloc??"bi")),x2=drawingX(Number(line.x2),String(line.xloc??"bi"));
        const y1=priceY(Number(line.y1)),y2=priceY(Number(line.y2));if(x1===null||x2===null||y1===null||y2===null)continue;
        ctx.save();ctx.strokeStyle=colorOr(line.color,"#2962ff");ctx.lineWidth=Math.max(1,Number(line.width)||1);
        if(String(line.style).includes("dashed"))ctx.setLineDash([7,4]);else if(String(line.style).includes("dotted"))ctx.setLineDash([2,3]);
        const ext=String(line.extend??"none"),dx=x2-x1,slope=Math.abs(dx)>0.001?(y2-y1)/dx:0;
        let ax=x1,ay=y1,bx=x2,by=y2;
        if(ext.includes("left")||ext.includes("both")){ay=y1-x1*slope;ax=0;}
        if(ext.includes("right")||ext.includes("both")){by=y1+(rightEdge-x1)*slope;bx=rightEdge;}
        ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.restore();
      }
      for(const box of latestObjects("__boxes__")){
        const x1=drawingX(Number(box.left),String(box.xloc??"bi")),x2=drawingX(Number(box.right),String(box.xloc??"bi"));
        const y1=priceY(Number(box.top)),y2=priceY(Number(box.bottom));if(x1===null||x2===null||y1===null||y2===null)continue;
        const left=Math.min(x1,x2),top=Math.min(y1,y2),w=Math.abs(x2-x1),h=Math.abs(y2-y1);
        ctx.save();ctx.fillStyle=colorOr(box.bgcolor,"rgba(41,98,255,0.12)");ctx.strokeStyle=colorOr(box.border_color,"#2962ff");
        ctx.lineWidth=Math.max(0,Number(box.border_width)||1);ctx.fillRect(left,top,w,h);if(ctx.lineWidth)ctx.strokeRect(left,top,w,h);
        if(box.text){ctx.fillStyle=colorOr(box.text_color,"#fff");ctx.font="12px Arial";ctx.fillText(String(box.text),left+5,top+15);}ctx.restore();
      }
      for(const fill of latestObjects("__linefills__")){
        const a=fill.line1,b=fill.line2;if(!a||!b)continue;
        const ax1=drawingX(Number(a.x1),String(a.xloc??"bi")),ax2=drawingX(Number(a.x2),String(a.xloc??"bi"));
        const bx1=drawingX(Number(b.x1),String(b.xloc??"bi")),bx2=drawingX(Number(b.x2),String(b.xloc??"bi"));
        const ay1=priceY(Number(a.y1)),ay2=priceY(Number(a.y2)),by1=priceY(Number(b.y1)),by2=priceY(Number(b.y2));
        if(ax1===null||ax2===null||bx1===null||bx2===null||ay1===null||ay2===null||by1===null||by2===null)continue;
        ctx.save();ctx.fillStyle=colorOr(fill.color,"rgba(41,98,255,0.18)");ctx.beginPath();ctx.moveTo(ax1,ay1);ctx.lineTo(ax2,ay2);ctx.lineTo(bx2,by2);ctx.lineTo(bx1,by1);ctx.closePath();ctx.fill();ctx.restore();
      }
      for(const poly of latestObjects("__polylines__")){
        const points=Array.isArray(poly.points)?poly.points:[];if(points.length<2)continue;
        ctx.save();ctx.strokeStyle=colorOr(poly.line_color,"#2962ff");ctx.lineWidth=Math.max(1,Number(poly.line_width)||1);ctx.beginPath();
        points.forEach((p:AnyRecord,i:number)=>{const x=drawingX(Number(p.index??p.time),String(poly.xloc??"bi")),y=priceY(Number(p.price));if(x===null||y===null)return;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
        if(poly.closed)ctx.closePath();ctx.stroke();if(poly.closed&&poly.fill_color){ctx.fillStyle=String(poly.fill_color);ctx.fill();}ctx.restore();
      }
      for(const table of latestObjects("__tables__")){
        const rows=Array.isArray(table.cells)?table.cells:[],cols=Math.max(1,Number(table.columns)||1),rowCount=Math.max(1,Number(table.rows)||rows.length||1);
        const cw=90,ch=24,tw=cw*cols,th=ch*rowCount,pos=String(table.position??"top_right").toLowerCase();
        const left=pos.includes("left")?8:pos.includes("center")?(rightEdge-tw)/2:rightEdge-tw-8;
        const top=pos.includes("bottom")?height-th-8:pos.includes("middle")?(height-th)/2:8;
        ctx.save();if(table.bgcolor){ctx.fillStyle=String(table.bgcolor);ctx.fillRect(left,top,tw,th);}
        rows.forEach((row:AnyRecord[],ri:number)=>row?.forEach((cell:AnyRecord,ci:number)=>{
          if(!cell||cell._merged)return;const x=left+ci*cw,y=top+ri*ch;
          if(cell.bgcolor){ctx.fillStyle=String(cell.bgcolor);ctx.fillRect(x,y,cw,ch);}
          if(table.border_width||table.frame_width){ctx.strokeStyle=colorOr(table.border_color,colorOr(table.frame_color,"#777"));ctx.lineWidth=Math.max(1,Number(table.border_width)||Number(table.frame_width)||1);ctx.strokeRect(x,y,cw,ch);}
          ctx.fillStyle=colorOr(cell.text_color,"#fff");ctx.font="12px Arial";ctx.textAlign=cell.text_halign==="left"?"left":cell.text_halign==="right"?"right":"center";ctx.textBaseline="middle";
          const tx=ctx.textAlign==="left"?x+4:ctx.textAlign==="right"?x+cw-4:x+cw/2;ctx.fillText(String(cell.text??""),tx,y+ch/2,cw-8);
        }));ctx.restore();
      }
      for(const label of latestObjects("__labels__")){
        const x=drawingX(Number(label.x),String(label.xloc??"bi"));if(x===null)continue;
        const yloc=String(label.yloc??"price").toLowerCase(),bar=candles[Math.round(Number(label.x))];
        const y=yloc.includes("above")?(bar?priceY(bar.high):priceY(Number(label.y))):yloc.includes("below")?(bar?priceY(bar.low):priceY(Number(label.y))):priceY(Number(label.y));
        if(y===null)continue;const text=String(label.text??"");ctx.save();ctx.font="12px Arial";const tw=ctx.measureText(text).width;
        ctx.fillStyle=colorOr(label.color,"#2962ff");ctx.fillRect(x-tw/2-5,y-17,tw+10,22);
        ctx.fillStyle=colorOr(label.textcolor,"#fff");ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(text,x,y-6);ctx.restore();
      }

      if(execution.kind==="strategy")for(const trade of execution.trades){
        const et=Math.floor(trade.entryTime/1000),ex=Math.floor(trade.exitTime/1000),entryX=xAt(et),entryBar=candleByTime.get(et);
        const entryY=entryBar?priceY(trade.side==="LONG"?entryBar.low:entryBar.high):null;
        if(entryX!==null&&entryY!==null)drawShape(entryX,entryY,trade.side==="LONG"?"arrow_up":"arrow_down",trade.side==="LONG"?"#16a34a":"#dc2626",trade.side+" "+trade.quantity,"#fff",6);
        if(!trade.isOpen){const exitX=xAt(ex),exitBar=candleByTime.get(ex),exitY=exitBar?priceY(trade.side==="LONG"?exitBar.high:exitBar.low):null;if(exitX!==null&&exitY!==null)drawShape(exitX,exitY,"circle",trade.pnlPoints>=0?"#16a34a":"#dc2626",(trade.pnlPoints>=0?"+":"")+trade.pnlPoints.toFixed(1),"#fff",4);}
      }
    };
    const scheduleDraw=()=>requestAnimationFrame(draw),observer=new ResizeObserver(scheduleDraw);
    observer.observe(container);timeScale.subscribeVisibleLogicalRangeChange(scheduleDraw);
    container.addEventListener("wheel",scheduleDraw,{passive:true});container.addEventListener("pointermove",scheduleDraw,{passive:true});container.addEventListener("touchmove",scheduleDraw,{passive:true});
    draw();
    return ()=>{
      observer.disconnect();timeScale.unsubscribeVisibleLogicalRangeChange(scheduleDraw);
      container.removeEventListener("wheel",scheduleDraw);container.removeEventListener("pointermove",scheduleDraw);container.removeEventListener("touchmove",scheduleDraw);
      canvas.remove();const current=chartRef.current;if(current)for(const series of seriesRef.current){try{current.removeSeries(series);}catch{/* disposed */}}seriesRef.current=[];
    };
  },[chartData,candles,execution,chartRef,candleSeriesRef,containerRef]);
}
