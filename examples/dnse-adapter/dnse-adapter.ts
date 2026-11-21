import mqtt, { type MqttClient } from "mqtt";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import type { CandleRequest, ConnectionState, MarketDataSource, MarketEvent, OpenChartsAdapter, Quote } from "../../src/adapter/types.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";
import { createBinanceMarketData } from "../binance-adapter/binance-adapter.ts";

const URL = "wss://datafeed-krx.dnse.com.vn/wss";
const TOPIC = "quotes/krx/mdds/v2/ohlc/derivative/1/VN30F1M";
const SYMBOL = "VN30F1M";
const FRAMES: Record<string, number> = { "1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400,"1w":604800 };
const RESOLUTIONS: Record<string,string> = { "1m":"1","5m":"5","15m":"15","30m":"30","1h":"1H","4h":"1H","1d":"1D","1w":"1W" };
const HISTORY_URLS = [
  "https://api.dnse.com.vn/chart-api/v2/ohlcs/derivative",
  "https://services.entrade.com.vn/chart-api/v2/ohlcs/derivative",
];

function varint(bytes: Uint8Array, state: { p: number }): number {
  let n = 0, shift = 0;
  while (state.p < bytes.length) { const b = bytes[state.p++]!; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; shift += 7; if (shift > 49) throw new Error("Protobuf varint overflow"); }
  throw new Error("Protobuf varint truncated");
}
function fields(bytes: Uint8Array): Array<{id:number;wire:number;value:number|Uint8Array}> {
  const out: Array<{id:number;wire:number;value:number|Uint8Array}> = [], s = {p:0};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (s.p < bytes.length) {
    const tag=varint(bytes,s), id=Math.floor(tag/8), wire=tag&7; if(!id) break;
    if(wire===0) out.push({id,wire,value:varint(bytes,s)});
    else if(wire===2){const len=varint(bytes,s);if(s.p+len>bytes.length)throw new Error("Protobuf length overflow");out.push({id,wire,value:bytes.subarray(s.p,s.p+len)});s.p+=len;}
    else if(wire===5){if(s.p+4>bytes.length)throw new Error("Protobuf float truncated");out.push({id,wire,value:view.getFloat32(s.p,true)});s.p+=4;}
    else if(wire===1){if(s.p+8>bytes.length)throw new Error("Protobuf double truncated");out.push({id,wire,value:view.getFloat64(s.p,true)});s.p+=8;}
    else throw new Error("Unsupported protobuf wire type "+wire);
  }
  return out;
}
export function decodeDnseOhlc(input:ArrayBuffer|Uint8Array):Candle|null {
  const data=input instanceof Uint8Array?input:new Uint8Array(input), payload=fields(data).find(f=>f.id===2&&f.wire===2)?.value;
  if(!(payload instanceof Uint8Array))return null;
  const f=fields(payload),get=(id:number)=>f.find(x=>x.id===id)?.value,num=(id:number)=>{const v=get(id);return typeof v==="number"?v:Number.NaN;};
  const sym=get(7);if(!(sym instanceof Uint8Array)||new TextDecoder().decode(sym)!==SYMBOL)return null;
  const time=num(1),open=num(2),high=num(3),low=num(4),close=num(5),vol=get(6);
  if(!Number.isFinite(time)||![open,high,low,close].every(Number.isFinite))return null;
  return {time:Math.floor(time),open,high,low,close,volume:typeof vol==="number"?vol:0,timestamp:Math.floor(time)*1000};
}
function symbolInfo():Symbol{return{id:SYMBOL,name:SYMBOL,displayName:"VN30F1M · HĐTL VN30",category:"Phái sinh Việt Nam",contractSize:1,tickSize:0.1,tickValue:0.1,marginPercent:100,maxLeverage:1,commission:0,swapLong:0,swapShort:0,tradingHoursStart:null,tradingHoursEnd:null,isActive:true};}
function aggregate(rows:Candle[],seconds:number):Candle[]{
  const map=new Map<number,Candle>();
  for(const c of rows){const t=Math.floor(c.time/seconds)*seconds,old=map.get(t);map.set(t,old?{...old,high:Math.max(old.high,c.high),low:Math.min(old.low,c.low),close:c.close,volume:old.volume+c.volume}:{...c,time:t,timestamp:t*1000});}
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function parseHistoryPayload(raw:unknown):{candles:Candle[];nextTime:number}{
  if(!raw||typeof raw!=="object")return{candles:[],nextTime:0};
  const outer=raw as Record<string,unknown>;
  const x=(outer.data&&typeof outer.data==="object"?outer.data:outer) as Record<string,unknown>;
  if(Array.isArray(x.candles))return{candles:x.candles as Candle[],nextTime:Number(x.nextTime)||0};
  const ts=Array.isArray(x.t)?x.t:[],os=Array.isArray(x.o)?x.o:[],hs=Array.isArray(x.h)?x.h:[],ls=Array.isArray(x.l)?x.l:[],cs=Array.isArray(x.c)?x.c:[],vs=Array.isArray(x.v)?x.v:[];
  const candles:Candle[]=[];
  for(let i=0;i<ts.length;i++){let time=Number(ts[i]);if(time>1e12)time=Math.floor(time/1000);const open=Number(os[i]),high=Number(hs[i]),low=Number(ls[i]),close=Number(cs[i]),volume=Number(vs[i]??0);if(Number.isFinite(time)&&time>0&&[open,high,low,close].every(Number.isFinite))candles.push({time, timestamp:time*1000,open,high,low,close,volume:Number.isFinite(volume)?volume:0});}
  return{candles,nextTime:Number(x.nextTime)||0};
}
export function createDnseMarketData():MarketDataSource{
  const crypto=createBinanceMarketData(),handlers=new Set<(e:MarketEvent)=>void>(),listeners=new Set<(s:ConnectionState)=>void>();
  const history:Candle[]=(()=>{try{const raw=globalThis.localStorage?.getItem("opencharts_dnse_vn30_history_v1"),v=raw?JSON.parse(raw):[];return Array.isArray(v)?v.filter((x):x is Candle=>x&&Number.isFinite(x.time)&&Number.isFinite(x.close)).slice(-50000):[];}catch{return[];}})();
  const frameCache=new Map<string,Candle[]>();
  let client:MqttClient|null=null,state:ConnectionState="disconnected",closed=false;
  const setState=(s:ConnectionState)=>{state=s;for(const fn of [...listeners])fn(s);};
  const emit=(e:MarketEvent)=>{for(const fn of [...handlers])fn(e);};
  const save=()=>{try{globalThis.localStorage?.setItem("opencharts_dn30_history_cache_v2",JSON.stringify({savedAt:Date.now(),candles:history.slice(-50000)}));}catch{/* cache best effort */}};
  // Migrate the first version's realtime-only cache and the new durable history cache.
  try{const raw=globalThis.localStorage?.getItem("opencharts_dn30_history_cache_v2");if(raw){const x=JSON.parse(raw);if(Array.isArray(x.candles))for(const c of x.candles)if(c&&Number.isFinite(c.time)&&Number.isFinite(c.close)&&!history.some(y=>y.time===c.time))history.push(c);history.sort((a,b)=>a.time-b.time);}}catch{/* ignore corrupt cache */}
  const merge=(rows:Candle[],incoming:Candle[])=>{const map=new Map<number,Candle>();for(const c of rows)map.set(c.time,c);for(const c of incoming)map.set(c.time,c);return[...map.values()].sort((a,b)=>a.time-b.time);};
  const ingest=(c:Candle)=>{
    const i=history.findIndex(x=>x.time===c.time);if(i>=0)history[i]=c;else history.push(c);
    history.sort((a,b)=>a.time-b.time);if(history.length>50000)history.splice(0,history.length-50000);save();frameCache.clear();
    emit({type:"tick",symbol:SYMBOL,bid:c.close,ask:c.close,timestamp:c.time*1000});
    for(const[tf,seconds]of Object.entries(FRAMES)){const bar=aggregate(history,seconds).find(x=>x.time===Math.floor(c.time/seconds)*seconds);if(bar)emit({type:"candle",symbol:SYMBOL,timeframe:tf,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,timestamp:bar.time*1000});}
  };
  const fetchHistory=async(req:CandleRequest):Promise<Candle[]>=>{
    const seconds=FRAMES[req.timeframe],resolution=RESOLUTIONS[req.timeframe];if(!seconds||!resolution)return[];
    const now=Math.floor(Date.now()/1000),toSec=req.toMs!=null?Math.floor(req.toMs/1000):now;
    const wanted=Math.max(1,req.limit??500);
    // Initial chart load asks for recent bars; scroll-back supplies an explicit older [from,to) range.
    const defaultSpan=Math.min(365,Math.max(14,Math.ceil(wanted*seconds/86400*3)));
    let fromSec=req.fromMs!=null?Math.floor(req.fromMs/1000):toSec-defaultSpan*86400;
    if(fromSec>=toSec)fromSec=toSec-seconds*wanted;
    let collected:Candle[]=[],cursor=fromSec,pageTo=toSec;
    for(let page=0;page<100&&cursor<pageTo;page++){
      let pageRows:Candle[]=[];let nextTime=0;let succeeded=false;
      for(const base of HISTORY_URLS){
        try{
          const url=new globalThis.URL(base);url.search=new URLSearchParams({symbol:SYMBOL,resolution,from:String(cursor),to:String(pageTo)}).toString();
          const headers={Accept:"application/json, text/plain, */*","Accept-Language":"vi-VN,vi;q=0.9,en-US;q=0.8","Origin":"https://banggia.dnse.com.vn","Referer":"https://banggia.dnse.com.vn/"};
          let payload:unknown;
          if(Capacitor.isNativePlatform()){
            // Native HTTP avoids Android WebView CORS restrictions on DNSE's legacy chart endpoint.
            const response=await CapacitorHttp.get({url:url.toString(),headers,connectTimeout:15000,readTimeout:15000});
            if(response.status<200||response.status>=300)throw new Error("DNSE history HTTP "+response.status);
            payload=response.data;
          }else{
            const response=await fetch(url.toString(),{method:"GET",headers,signal:AbortSignal.timeout(15000)});
            if(!response.ok)throw new Error("DNSE history HTTP "+response.status);
            payload=await response.json();
          }
          const parsed=parseHistoryPayload(payload);pageRows=parsed.candles.sort((a,b)=>a.time-b.time);nextTime=parsed.nextTime;succeeded=true;break;
        }catch(error){console.warn("[dnse] history endpoint failed",base,error);}
      }
      if(!succeeded||pageRows.length===0)break;
      const normalizedPage=req.timeframe==="4h"?aggregate(pageRows,seconds):pageRows;
      collected=merge(collected,normalizedPage);
      const earliest=pageRows.reduce((min,c)=>Math.min(min,c.time),Number.POSITIVE_INFINITY);
      const next=nextTime>0?Math.min(nextTime,earliest):earliest;
      if(next<=cursor||next>=pageTo||earliest<=0||pageRows.length<2)break;
      pageTo=next;
      if(collected.length>=wanted&&req.fromMs==null)break;
    }
    if(collected.length){const merged=merge(history,collected);history.splice(0,history.length,...merged.slice(-50000));save();}
    const all=merge(frameCache.get(req.timeframe)??[],collected);frameCache.set(req.timeframe,all);
    let result=merge(aggregate(history,seconds),all);
    if(req.fromMs!=null)result=result.filter(c=>c.time*1000>=req.fromMs!);
    if(req.toMs!=null)result=result.filter(c=>c.time*1000<req.toMs!);
    if(req.limit!=null&&req.fromMs==null)result=result.slice(-req.limit);
    return result;
  };
  return{
    getSymbols:async()=>[...await crypto.getSymbols(),symbolInfo()],
    getCandles:async(req:CandleRequest)=>req.symbol!==SYMBOL?crypto.getCandles(req):fetchHistory(req),
    getQuote:async(name:string):Promise<Quote|null>=>{if(name!==SYMBOL)return crypto.getQuote?.(name)??null;const c=history[history.length-1];return c?{symbol:SYMBOL,bid:c.close,ask:c.close,timestamp:c.time*1000}:null;},
    subscribe:(fn)=>{handlers.add(fn);const unsub=crypto.subscribe(fn);return()=>{handlers.delete(fn);unsub();};},
    connect:()=>{closed=false;crypto.connect?.();if(client)return;setState("connecting");client=mqtt.connect(URL,{username:"entrade",password:"entrade",clientId:"opencharts_vn30_"+Math.random().toString(16).slice(2,12),protocolVersion:5,clean:true,keepalive:30,reconnectPeriod:5000,connectTimeout:15000});client.on("connect",()=>client?.subscribe(TOPIC,{qos:0},err=>setState(err?"reconnecting":"connected")));client.on("message",(topic,payload)=>{if(topic!==TOPIC)return;try{const c=decodeDnseOhlc(new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength));if(c)ingest(c);}catch(e){console.warn("[dnse] protobuf decode failed",e);}});client.on("reconnect",()=>setState("reconnecting"));client.on("close",()=>setState(closed?"disconnected":"reconnecting"));client.on("error",e=>{console.warn("[dnse] MQTT",e);setState("reconnecting");});},
    disconnect:()=>{closed=true;crypto.disconnect?.();client?.end(true);client=null;setState("disconnected");},
    getConnectionState:()=>state,
    onConnectionChange:(fn)=>{listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
  };
}
export async function createDnsePaperAdapter():Promise<OpenChartsAdapter>{
  const[{createDemoAdapter},engine]=await Promise.all([import("../../src/adapter/demo.ts"),import("../../src/services/demo/engine.ts")]);
  const marketData=createDnseMarketData(),paper=createDemoAdapter();marketData.subscribe(e=>{if(e.type==="tick")engine.mark(e.symbol,(e.bid+e.ask)/2);});
  return{name:"dnse-vn30-and-binance-paper",marketData,trading:paper.trading,storage:paper.storage};
}


/** Read-only DNSE source: no paper-trading engine or trading gateway is created. */
export async function createDnseMarketDataAdapter(): Promise<OpenChartsAdapter> {
  return { name: "dnse-vn30-market-data", marketData: createDnseMarketData() };
}
