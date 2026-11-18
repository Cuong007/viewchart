import mqtt, { type MqttClient } from "mqtt";
import type { CandleRequest, ConnectionState, MarketDataSource, MarketEvent, OpenChartsAdapter, Quote } from "../../src/adapter/types.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";
import { createBinanceMarketData } from "../binance-adapter/binance-adapter.ts";

const URL = "wss://datafeed-krx.dnse.com.vn/wss";
const TOPIC = "quotes/krx/mdds/v2/ohlc/derivative/1/VN30F1M";
const SYMBOL = "VN30F1M";
const FRAMES: Record<string, number> = { "1m":60,"5m":300,"15m":900,"30m":1800,"1h":3600,"4h":14400,"1d":86400,"1w":604800 };

function varint(bytes: Uint8Array, state: { p: number }): number {
  let n = 0, shift = 0;
  while (state.p < bytes.length) {
    const b = bytes[state.p++]!;
    n += (b & 127) * 2 ** shift;
    if (!(b & 128)) return n;
    shift += 7;
    if (shift > 49) throw new Error("Protobuf varint overflow");
  }
  throw new Error("Protobuf varint truncated");
}
function fields(bytes: Uint8Array): Array<{id:number;wire:number;value:number|Uint8Array}> {
  const out: Array<{id:number;wire:number;value:number|Uint8Array}> = [];
  const s = {p:0}; const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (s.p < bytes.length) {
    const tag = varint(bytes,s), id = Math.floor(tag/8), wire = tag & 7;
    if (!id) break;
    if (wire === 0) out.push({id,wire,value:varint(bytes,s)});
    else if (wire === 2) { const len=varint(bytes,s); if(s.p+len>bytes.length) throw new Error("Protobuf length overflow"); out.push({id,wire,value:bytes.subarray(s.p,s.p+len)}); s.p+=len; }
    else if (wire === 5) { if(s.p+4>bytes.length) throw new Error("Protobuf float truncated"); out.push({id,wire,value:view.getFloat32(s.p,true)}); s.p+=4; }
    else if (wire === 1) { if(s.p+8>bytes.length) throw new Error("Protobuf double truncated"); out.push({id,wire,value:view.getFloat64(s.p,true)}); s.p+=8; }
    else throw new Error("Unsupported protobuf wire type "+wire);
  }
  return out;
}
export function decodeDnseOhlc(input: ArrayBuffer | Uint8Array): Candle | null {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const payload = fields(data).find(f=>f.id===2 && f.wire===2)?.value;
  if (!(payload instanceof Uint8Array)) return null;
  const f=fields(payload), get=(id:number)=>f.find(x=>x.id===id)?.value;
  const num=(id:number)=>{const v=get(id);return typeof v==="number"?v:Number.NaN;};
  const sym=get(7);
  if (!(sym instanceof Uint8Array) || new TextDecoder().decode(sym)!==SYMBOL) return null;
  const time=num(1), open=num(2), high=num(3), low=num(4), close=num(5), vol=get(6);
  if (!Number.isFinite(time)||![open,high,low,close].every(Number.isFinite)) return null;
  return {time:Math.floor(time),open,high,low,close,volume:typeof vol==="number"?vol:0,timestamp:Math.floor(time)*1000};
}
function symbolInfo(): Symbol { return {id:SYMBOL,name:SYMBOL,displayName:"VN30F1M · HĐTL VN30",category:"Phái sinh Việt Nam",contractSize:1,tickSize:0.1,tickValue:0.1,marginPercent:100,maxLeverage:1,commission:0,swapLong:0,swapShort:0,tradingHoursStart:null,tradingHoursEnd:null,isActive:true}; }
function aggregate(rows:Candle[],seconds:number):Candle[] {
  const map=new Map<number,Candle>();
  for(const c of rows){const t=Math.floor(c.time/seconds)*seconds, old=map.get(t);map.set(t,old?{...old,high:Math.max(old.high,c.high),low:Math.min(old.low,c.low),close:c.close,volume:old.volume+c.volume}:{...c,time:t});}
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
export function createDnseMarketData(): MarketDataSource {
  const crypto=createBinanceMarketData(), handlers=new Set<(e:MarketEvent)=>void>(), listeners=new Set<(s:ConnectionState)=>void>(), history:Candle[]=[];
  let client:MqttClient|null=null, state:ConnectionState="disconnected", closed=false;
  const setState=(s:ConnectionState)=>{state=s;for(const fn of [...listeners])fn(s);};
  const emit=(e:MarketEvent)=>{for(const fn of [...handlers])fn(e);};
  const ingest=(c:Candle)=>{
    const i=history.findIndex(x=>x.time===c.time);if(i>=0)history[i]=c;else history.push(c);
    history.sort((a,b)=>a.time-b.time);if(history.length>20000)history.splice(0,history.length-20000);
    emit({type:"tick",symbol:SYMBOL,bid:c.close,ask:c.close,timestamp:c.time*1000});
    for(const [tf,seconds] of Object.entries(FRAMES)){const bar=aggregate(history,seconds).find(x=>x.time===Math.floor(c.time/seconds)*seconds);if(bar)emit({type:"candle",symbol:SYMBOL,timeframe:tf,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume,timestamp:bar.time*1000});}
  };
  return {
    getSymbols:async()=>[...await crypto.getSymbols(),symbolInfo()],
    getCandles:async(req:CandleRequest)=>{
      if(req.symbol!==SYMBOL)return crypto.getCandles(req);
      const seconds=FRAMES[req.timeframe];if(!seconds)return [];
      let rows=aggregate(history,seconds);
      if(req.fromMs!=null)rows=rows.filter(x=>x.time*1000>=req.fromMs!);
      if(req.toMs!=null)rows=rows.filter(x=>x.time*1000<req.toMs!);
      return req.limit==null?rows:rows.slice(-Math.max(1,req.limit));
    },
    getQuote:async(name:string):Promise<Quote|null>=>{
      if(name!==SYMBOL)return crypto.getQuote?.(name)??null;
      const c=history[history.length-1];return c?{symbol:SYMBOL,bid:c.close,ask:c.close,timestamp:c.time*1000}:null;
    },
    subscribe:(fn)=>{handlers.add(fn);const unsub=crypto.subscribe(fn);return()=>{handlers.delete(fn);unsub();};},
    connect:()=>{
      closed=false;crypto.connect?.();if(client)return;setState("connecting");
      client=mqtt.connect(URL,{username:"entrade",password:"entrade",clientId:"opencharts_vn30_"+Math.random().toString(16).slice(2,12),protocolVersion:5,clean:true,keepalive:30,reconnectPeriod:5000,connectTimeout:15000});
      client.on("connect",()=>client?.subscribe(TOPIC,{qos:0},err=>setState(err?"reconnecting":"connected")));
      client.on("message",(topic,payload)=>{if(topic!==TOPIC)return;try{const c=decodeDnseOhlc(new Uint8Array(payload.buffer,payload.byteOffset,payload.byteLength));if(c)ingest(c);}catch(e){console.warn("[dnse] protobuf decode failed",e);}});
      client.on("reconnect",()=>setState("reconnecting"));client.on("close",()=>setState(closed?"disconnected":"reconnecting"));client.on("error",e=>{console.warn("[dnse] MQTT",e);setState("reconnecting");});
    },
    disconnect:()=>{closed=true;crypto.disconnect?.();client?.end(true);client=null;setState("disconnected");},
    getConnectionState:()=>state,
    onConnectionChange:(fn)=>{listeners.add(fn);fn(state);return()=>listeners.delete(fn);},
  };
}
export async function createDnsePaperAdapter():Promise<OpenChartsAdapter>{
  const [{createDemoAdapter},engine]=await Promise.all([import("../../src/adapter/demo.ts"),import("../../src/services/demo/engine.ts")]);
  const marketData=createDnseMarketData(),paper=createDemoAdapter();
  marketData.subscribe(e=>{if(e.type==="tick")engine.mark(e.symbol,(e.bid+e.ask)/2);});
  return {name:"dnse-vn30-and-binance-paper",marketData,trading:paper.trading,storage:paper.storage};
}
