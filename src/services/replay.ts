import { getAdapter } from "../adapter/registry.ts";
import { uid } from "../lib/uid.ts";
import { publish } from "./demo/bus.ts";

/**
 * Session replay.
 *
 * The replay UI drives its own clock (useReplayPlayback runs a rAF loop over
 * the tick buffer); this module supplies the buffer and owns the transport
 * state, broadcasting `ReplayStateChanged` so the store and HUD stay in sync.
 *
 * The buffer comes from the installed adapter's `getCandles`, so replay works
 * against any backend rather than needing one of its own. A "session" is the
 * 1-minute history for the charted symbol on the requested date.
 */

export type ReplaySessionPayload = {
  replaySession: {
    id: string;
    status: string;
    speed: number;
    cursorTimestamp: string | null;
    sessionDate: string;
  };
  tickBuffer: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }>;
  tradeEvents: Array<{
    id: string;
    type: "entry" | "exit" | "violation";
    timestamp: string;
    symbolName: string | null;
    side: string | null;
    price: number | null;
    pnl: number | null;
    ruleCode?: string;
  }>;
  meta: { primarySymbol: string | null; sessionDate: string; tickCount: number };
};

type SessionState = {
  id: string;
  status: "IDLE" | "PLAYING" | "PAUSED" | "STOPPED";
  speed: number;
  cursorTimestamp: number | null;
  sessionDate: string;
};

let session: SessionState | null = null;

/** Symbol to play back when the caller does not name one. */
const DEFAULT_SYMBOL = "BTCUSD";

/** One year of 1m bars is 525,600; retain a little headroom for leap years. */
const SESSION_BAR_LIMIT = 600_000;
/** Binance silently caps every kline request at 1,000 rows; stay below that. */
const CHUNK_BAR_LIMIT = 900;
/** Cache completed historical chunks across 15s replay-session refreshes. */
const completedChunkCache = new Map<string, Promise<Awaited<ReturnType<ReturnType<typeof getAdapter>["marketData"]["getCandles"]>>>>();

/**
 * Bars revealed before playback begins. Starting exactly at the first bar
 * leaves the chart auto-fitting a single candle across the whole pane, which
 * looks broken for the first few seconds.
 */
const WARMUP_BARS = 30;

function emit(action: string, opts: { speed?: number; cursorTimestamp?: number } = {}): void {
  publish("market-data", { eventType: "ReplayStateChanged", action, ...opts });
}

function dayBounds(sessionDate: string): { startMs: number; endMs: number } {
  const startMs = new Date(`${sessionDate}T00:00:00`).getTime();
  return { startMs, endMs: Date.now() + 60_000 };
}

function localDateKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export async function getSession(
  sessionDate: string,
  symbol: string = DEFAULT_SYMBOL,
  accountId?: string,
): Promise<ReplaySessionPayload> {
  const adapter = getAdapter();
  const { startMs, endMs } = dayBounds(sessionDate);

  // A wide fromMs→now request is not reliable across market-data providers:
  // some silently cap it to the latest trading session (often ending at
  // 16:39). Fetch each calendar day independently so later sessions cannot be
  // omitted by a provider's implicit range/page limit.
  const historyAvailable = startMs >= Date.now() - 365 * 24 * 60 * 60 * 1000;
  const dayRanges: Array<{ day: string; fromMs: number; toMs: number }> = [];
  if (historyAvailable) {
    const cursor = new Date(startMs);
    while (cursor.getTime() < endMs) {
      const from = cursor.getTime();
      const next = new Date(cursor);
      next.setDate(next.getDate() + 1);
      const to = Math.min(next.getTime(), endMs);
      dayRanges.push({ day: localDateKey(from), fromMs: from, toMs: to });
      cursor.setTime(next.getTime());
    }
  }

  // Split every calendar day into <=900-minute windows. The Binance adapter
  // (and several other feeds) hard-caps a single request at 1,000 candles,
  // regardless of the requested limit. A full-day 1m request therefore used
  // to return only 00:00..16:39; 5m aggregation then ended at 16:35.
  const requestRanges: Array<{ day: string; fromMs: number; toMs: number }> = [];
  const chunkMs = CHUNK_BAR_LIMIT * 60_000;
  for (const day of dayRanges) {
    for (let fromMs = day.fromMs; fromMs < day.toMs; fromMs += chunkMs) {
      requestRanges.push({
        day: day.day,
        fromMs,
        toMs: Math.min(fromMs + chunkMs, day.toMs),
      });
    }
  }

  const dayBars: Awaited<ReturnType<typeof adapter.marketData.getCandles>> = [];
  // Bounded concurrency; cache each completed chunk, but refresh the currently
  // forming chunk so the replay picks up newly completed candles every poll.
  for (let offset = 0; offset < requestRanges.length; offset += 8) {
    const batch = requestRanges.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async (range) => {
      const cacheKey = `${symbol}:1m:${range.day}:${range.fromMs}`;
      const isComplete = range.toMs <= Date.now() - 60_000;
      if (isComplete) {
        let pending = completedChunkCache.get(cacheKey);
        if (!pending) {
          pending = adapter.marketData.getCandles({
            symbol,
            timeframe: "1m",
            limit: CHUNK_BAR_LIMIT,
            fromMs: range.fromMs,
            toMs: range.toMs,
          });
          completedChunkCache.set(cacheKey, pending);
          pending.catch(() => completedChunkCache.delete(cacheKey));
        }
        return pending;
      }
      return adapter.marketData.getCandles({
        symbol,
        timeframe: "1m",
        limit: CHUNK_BAR_LIMIT,
        fromMs: range.fromMs,
        toMs: range.toMs,
      });
    }));
    for (const result of results) dayBars.push(...result);
  }

  const uniqueBars = new Map<number, (typeof dayBars)[number]>();
  for (const candle of dayBars) {
    const ms = candle.time * 1000;
    if (ms >= startMs && ms < endMs) uniqueBars.set(ms, candle);
  }
  const bars = [...uniqueBars.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-SESSION_BAR_LIMIT);

  const tickBuffer = bars.map((c) => ({
    t: c.time * 1000,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    v: c.volume ?? 0,
  }));

  // Trades closed inside the replayed window become markers on the chart.
  let tradeEvents: ReplaySessionPayload["tradeEvents"] = [];
  if (adapter.trading && accountId) {
    try {
      const closed = await adapter.trading.getClosedPositions(accountId);
      tradeEvents = closed.data
        .filter((p) => {
          if (!p.closedAt) return false;
          const closedMs = Date.parse(p.closedAt);
          return Number.isFinite(closedMs) && closedMs >= startMs && closedMs < endMs;
        })
        .map((p) => ({
          id: p.id,
          type: "exit" as const,
          timestamp: p.closedAt as string,
          symbolName: p.symbolName,
          side: p.side,
          price: p.exitPrice,
          pnl: p.realizedPnl,
        }));
    } catch {
      // Markers are a nicety — a gateway that cannot list closed trades still
      // gets a working replay.
    }
  }

  return {
    replaySession: {
      id: session?.id ?? uid(),
      status: session?.status ?? "IDLE",
      speed: session?.speed ?? 1,
      cursorTimestamp:
        session?.cursorTimestamp != null ? new Date(session.cursorTimestamp).toISOString() : null,
      sessionDate,
    },
    tickBuffer,
    tradeEvents,
    meta: {
      primarySymbol: tickBuffer.length > 0 ? symbol : null,
      sessionDate,
      tickCount: tickBuffer.length,
    },
  };
}

export async function start(
  sessionDate: string,
  speed = 1,
  symbol: string = DEFAULT_SYMBOL,
  accountId?: string,
): Promise<{ speed: number; seed: null }> {
  const payload = await getSession(sessionDate, symbol, accountId);
  const buffer = payload.tickBuffer;
  const first =
    buffer.length > 0 ? (buffer[Math.min(WARMUP_BARS, Math.max(0, buffer.length - 2))]?.t ?? null) : null;

  session = { id: uid(), status: "PLAYING", speed, cursorTimestamp: first, sessionDate };
  emit("started", { speed, ...(first != null ? { cursorTimestamp: first } : {}) });
  return { speed, seed: null };
}

export function pause(): void {
  if (!session) return;
  session.status = "PAUSED";
  emit("paused");
}

export function resume(): void {
  if (!session) return;
  session.status = "PLAYING";
  emit("resumed");
}

export function stop(): void {
  if (session) session.status = "STOPPED";
  session = null;
  emit("stopped");
}

export function setSpeed(speed: number): { speed: number } {
  if (session) session.speed = speed;
  emit("speed", { speed });
  return { speed };
}

export function seek(timestamp: string | number): { cursorTimestamp: string } {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (session && Number.isFinite(ms)) session.cursorTimestamp = ms;
  emit("seek", { cursorTimestamp: ms });
  return { cursorTimestamp: new Date(ms).toISOString() };
}

/** Cursor persistence — in-memory only; a reload starts the session fresh. */
export function patchSession(patch: { sessionDate?: string; cursorTimestamp?: number }): void {
  if (!session) return;
  if (patch.cursorTimestamp != null) session.cursorTimestamp = patch.cursorTimestamp;
  if (patch.sessionDate) session.sessionDate = patch.sessionDate;
}

/** Test seam. */
export function __resetReplay(): void {
  session = null;
}
