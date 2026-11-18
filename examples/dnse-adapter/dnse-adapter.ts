import mqtt, { type MqttClient } from "mqtt";
import type { CandleRequest, ConnectionState, MarketDataSource, MarketEvent, OpenChartsAdapter, Quote, Unsubscribe } from "../../src/adapter/types.ts";
import type { Candle, Symbol } from "../../src/services/schemas.ts";
import { createBinanceMarketData } from "../binance-adapter/binance-adapter.ts";

const DNSE_URL = "wss://datafeed-krx.dnse.com.vn/wss";
const DNSE_TOPIC = "quotes/krx/mdds/v2/ohlc/derivative/1/VN30F1M";
const DNSE_SYMBOL = "VN30F1M";
const TIMEFRAMES: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
};

type ProtoField = { id: number; wire: number; value: number | Uint8Array };

function readVarint(data: Uint8Array, state: { offset: number }): number {
  let value = 0;
  let shift = 0;
  while (state.offset < data.length) {
    const byte = data[state.offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
    if (shift > 49) throw new Error("DNSE protobuf varint overflow");
  }
  throw new Error("DNSE protobuf varint truncated");
}

function decodeFields(data: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  const state = { offset: 0 };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  while (state.offset < data.length) {
    const tag = readVarint(data, state);
    const id = Math.floor(tag / 8);
    const wire = tag & 7;
    if (!id) break;
    if (wire === 0) {
      fields.push({ id, wire, value: readVarint(data, state) });
    } else if (wire === 2) {
      const length = readVarint(data, state);
      if (state.offset + length > data.length) throw new Error("DNSE protobuf payload truncated");
      fields.push({ id, wire, value: data.subarray(state.offset, state.offset + length) });
      state.offset += length;
    } else if (wire === 5) {
      if (state.offset + 4 > data.length) throw new Error("DNSE protobuf float truncated");
      fields.push({ id, wire, value: view.getFloat32(state.offset, true) });
      state.offset += 4;
    } else if (wire === 1) {
      if (state.offset + 8 > data.length) throw new Error("DNSE protobuf double truncated");
      fields.push({ id, wire, value: view.getFloat64(state.offset, true) });
      state.offset += 8;
    } else {
      throw new Error("DNSE protobuf wire type unsupported: " + wire);
    }
  }
  return fields;
}

/** Decodes the DNSE envelope and derivative OHLC protobuf message. */
export function decodeDnseOhlc(input: ArrayBuffer | Uint8Array): Candle | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const envelope = decodeFields(bytes);
  const payload = envelope.find((field) => field.id === 2 && field.wire === 2)?.value;
  if (!(payload instanceof Uint8Array)) return null;
  const fields = decodeFields(payload);
  const value = (id: number): number | Uint8Array | undefined => fields.find((field) => field.id === id)?.value;
  const rawTime = value(1);
  const time = typeof rawTime === "number" ? rawTime : Number.NaN;
  const numberField = (id: number) => {
    const raw = value(id);
    return typeof raw === "number" ? raw : Number.NaN;
  };
  const rawSymbol = value(7);
  const symbol = rawSymbol instanceof Uint8Array ? new TextDecoder().decode(rawSymbol) : "";
  const open = numberField(2);
  const high = numberField(3);
  const low = numberField(4);
  const close = numberField(5);
  const volumeRaw = value(6);
  const volume = typeof volumeRaw === "number" ? volumeRaw : 0;
  if (symbol !== DNSE_SYMBOL || !Number.isFinite(time) || ![open, high, low, close].every(Number.isFinite)) return null;
  return { time: Math.floor(time), open, high, low, close, volume, timestamp: Math.floor(time) * 1000 };
}

function vn30Symbol(): Symbol {
  return {
    id: DNSE_SYMBOL, name: DNSE_SYMBOL, displayName: "VN30F1M · HĐTL VN30",
    category: "Phái sinh Việt Nam", contractSize: 1, tickSize: 0.1, tickValue: 0.1,
    marginPercent: 100, maxLeverage: 1, commission: 0, swapLong: 0, swapShort: 0,
    tradingHoursStart: null, tradingHoursEnd: null, isActive: true,
  };
}

function aggregate(rows: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const candle of rows) {
    const bucketTime = Math.floor(candle.time / seconds) * seconds;
    const current = buckets.get(bucketTime);
    if (!current) buckets.set(bucketTime, { ...candle, time: bucketTime });
    else buckets.set(bucketTime, {
      ...current, high: Math.max(current.high, candle.high), low: Math.min(current.low, candle.low),
      close: candle.close, volume: current.volume + candle.volume,
    });
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

export interface DnseOptions {
  username?: string;
  password?: string;
  clientId?: string;
  mqttConnect?: typeof mqtt.connect;
}

export function createDnseMarketData(options: DnseOptions = {}): MarketDataSource {
  const binance = createBinanceMarketData();
  const handlers = new Set<(event: MarketEvent) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  const history: Candle[] = [];
  let client: MqttClient | null = null;
  let state: ConnectionState = "disconnected";
  let manuallyClosed = false;

  const setState = (next: ConnectionState) => {
    if (state === next) return;
    state = next;
    for (const listener of [...stateListeners]) listener(next);
  };
  const emit = (event: MarketEvent) => {
    for (const handler of [...handlers]) handler(event);
  };
  const ingest = (candle: Candle) => {
    const index = history.findIndex((item) => item.time === candle.time);
    if (index >= 0) history[index] = candle;
    else history.push(candle);
    history.sort((a, b) => a.time - b.time);
    // Keep a bounded in-memory session cache; DNSE script exposes live OHLC only,
    // not a documented historical-candles endpoint.
    if (history.length > 20_000) history.splice(0, history.length - 20_000);
    const timestamp = candle.time * 1000;
    emit({ type: "tick", symbol: DNSE_SYMBOL, bid: candle.close, ask: candle.close, timestamp });
    for (const [timeframe, seconds] of Object.entries(TIMEFRAMES)) {
      const bar = aggregate([candle], seconds)[0]!;
      const full = aggregate(history, seconds).find((item) => item.time === bar.time) ?? bar;
      emit({
        type: "candle", symbol: DNSE_SYMBOL, timeframe,
        open: full.open, high: full.high, low: full.low, close: full.close,
        volume: full.volume, timestamp: full.time * 1000,
      });
    }
  };

  return {
    getSymbols: async () => [...await binance.getSymbols(), vn30Symbol()],
    getCandles: async (request: CandleRequest): Promise<Candle[]> => {
      if (request.symbol !== DNSE_SYMBOL) return binance.getCandles(request);
      const seconds = TIMEFRAMES[request.timeframe];
      if (!seconds) return [];
      let rows = aggregate(history, seconds);
      if (request.fromMs != null) rows = rows.filter((c) => c.time * 1000 >= request.fromMs!);
      if (request.toMs != null) rows = rows.filter((c) => c.time * 1000 < request.toMs!);
      if (request.limit != null) rows = rows.slice(-Math.max(1, request.limit));
      return rows;
    },
    getQuote: async (symbol: string): Promise<Quote | null> => {
      if (symbol !== DNSE_SYMBOL) return binance.getQuote?.(symbol) ?? null;
      const latest = history[history.length - 1];
      return latest ? { symbol, bid: latest.close, ask: latest.close, timestamp: latest.time * 1000 } : null;
    },
    subscribe: (handler) => {
      handlers.add(handler);
      const unsubscribeBinance = binance.subscribe(handler);
      return () => { handlers.delete(handler); unsubscribeBinance(); };
    },
    connect: () => {
      manuallyClosed = false;
      setState("connecting");
      binance.connect?.();
      if (client) return;
      const connect = options.mqttConnect ?? mqtt.connect;
      client = connect(DNSE_URL, {
        username: options.username ?? "entrade",
        password: options.password ?? "entrade",
        clientId: options.clientId ?? ("opencharts_vn30_" + Math.random().toString(16).slice(2, 12)),
        protocolVersion: 5, clean: true, keepalive: 30, reconnectPeriod: 5000, connectTimeout: 15000,
        // MQTT.js chooses its browser WebSocket transport for this wss URL.
      });
      client.on("connect", () => {
        client?.subscribe(DNSE_TOPIC, { qos: 0 }, (error) => {
          if (error) setState("reconnecting");
          else setState("connected");
        });
      });
      client.on("message", (topic, payload) => {
        if (topic !== DNSE_TOPIC) return;
        try {
          const candle = decodeDnseOhlc(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
          if (candle) ingest(candle);
        } catch (error) {
          console.warn("[dnse] invalid OHLC protobuf frame", error);
        }
      });
      client.on("reconnect", () => setState("reconnecting"));
      client.on("close", () => setState(manuallyClosed ? "disconnected" : "reconnecting"));
      client.on("error", (error) => {
        console.warn("[dnse] MQTT connection error", error);
        setState("reconnecting");
      });
    },
    disconnect: () => {
      manuallyClosed = true;
      binance.disconnect?.();
      client?.end(true);
      client = null;
      setState("disconnected");
    },
    getConnectionState: () => state,
    onConnectionChange: (listener) => {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
  };
}

export async function createDnsePaperAdapter(): Promise<OpenChartsAdapter> {
  const [{ createDemoAdapter }, engine] = await Promise.all([
    import("../../src/adapter/demo.ts"),
    import("../../src/services/demo/engine.ts"),
  ]);
  const marketData = createDnseMarketData();
  const paper = createDemoAdapter();
  marketData.subscribe((event) => {
    if (event.type === "tick") engine.mark(event.symbol, (event.bid + event.ask) / 2);
  });
  return { name: "dnse-vn30-and-binance-paper", marketData, trading: paper.trading, storage: paper.storage };
}
