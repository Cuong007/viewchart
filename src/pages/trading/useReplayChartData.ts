import { useEffect, useMemo } from "react";
import { api } from "../../services/api.ts";
import { useReplaySession } from "../../services/queries.ts";
import type { Candle } from "../../services/schemas.ts";
import { useTradingStore } from "../../services/store.tsx";
import { clearReplayPrices, setReplayClosePrice } from "../../services/demo/engine.ts";
import { toast } from "../../services/toast.ts";
import { TF_INTERVAL_MS, type Timeframe } from "./constants.ts";

type ReplaySessionData = NonNullable<Awaited<ReturnType<typeof api.replayGetSession>>>;
type ReplayTradeEvents = ReplaySessionData["tradeEvents"];
type TickBar = ReplaySessionData["tickBuffer"][number];

function aggregateToTimeframe(buf: TickBar[], timeframe: Timeframe, cursorMs: number | null): Candle[] {
  const interval = TF_INTERVAL_MS[timeframe] ?? 60_000;
  const grouped = new Map<number, Candle>();
  for (const bar of buf) {
    if (cursorMs != null && bar.t > cursorMs) break;
    const bucket = Math.floor(bar.t / interval) * interval;
    const prev = grouped.get(bucket);
    if (!prev) grouped.set(bucket, { time: bucket, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v });
    else grouped.set(bucket, { ...prev, high: Math.max(prev.high, bar.h), low: Math.min(prev.low, bar.l), close: bar.c, volume: (prev.volume ?? 0) + bar.v });
  }
  return [...grouped.values()];
}

function emptySessionReason(data: ReplaySessionData, sessionDate: string): string {
  return data.meta?.primarySymbol
    ? `No 1m candle history stored for ${data.meta.primarySymbol} on ${sessionDate}`
    : `No trading activity found on ${sessionDate}`;
}

/**
 * Bridges a replay session into chart-ready data.
 *
 * - Focuses the chart on the session's primary symbol when replay starts.
 * - Slices the 1m tick buffer up to the playback cursor, so the chart reveals
 *   bars progressively as `useReplayPlayback` advances the cursor.
 * - Detects empty sessions (no trades / no stored candles for that day) and
 *   stops the replay with an explanatory toast instead of silently idling.
 *
 * While `replayCandles` is non-null the caller must suppress the live feed
 * (tick / liveCandle props) so real-time data can't paint over the playback.
 */
export function useReplayChartData(accountId: string | null, timeframe: Timeframe): {
  replayCandles: Candle[] | null;
  replayTradeEvents: ReplayTradeEvents | undefined;
  replayPrice: number | null;
} {
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const setSelectedSymbol = useTradingStore((s) => s.setSelectedSymbol);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);

  const { data } = useReplaySession(
    isReplaying ? accountId : null,
    replaySessionDate,
    selectedSymbol,
  );

  // Focus the chart on the replayed symbol once the session loads.
  const replaySymbol = isReplaying ? (data?.meta?.primarySymbol ?? null) : null;
  useEffect(() => {
    if (replaySymbol) setSelectedSymbol(replaySymbol);
  }, [replaySymbol, setSelectedSymbol]);

  // Empty session — no positions that day, or no 1m history stored. Stop and
  // tell the trader why; the old behavior was an idle loop with a frozen HUD.
  useEffect(() => {
    if (!isReplaying || !data || !replaySessionDate || !accountId) return;
    if (data.tickBuffer.length > 0) return;
    toast.warning("Replay unavailable", emptySessionReason(data, replaySessionDate));
    api.replayStop(accountId, replaySessionDate).catch(() => null);
    useTradingStore.getState().onReplayStateChanged("stopped");
  }, [isReplaying, data, replaySessionDate, accountId]);

  // Resolve the exact 1m close at the playback cursor. Do not derive position
  // marks from the chart timeframe: a 5m/15m chart can lag the active 1m bar.
  const replayPrice = useMemo<number | null>(() => {
    if (!isReplaying || !data || data.tickBuffer.length === 0 || replayCursorTimestamp == null) return null;
    let current: TickBar | null = null;
    for (const bar of data.tickBuffer) {
      if (bar.t > replayCursorTimestamp) break;
      current = bar;
    }
    return current?.c ?? null;
  }, [isReplaying, data, replayCursorTimestamp]);

  // Feed the replay cursor price into the paper-trading engine as well as the chart.
  // This keeps market fills, floating P&L and SL/TP evaluation on historical time.
  const replayCandles = useMemo<Candle[] | null>(() => {
    if (!isReplaying || !data || data.tickBuffer.length === 0) return null;
    return aggregateToTimeframe(data.tickBuffer, timeframe, replayCursorTimestamp);
  }, [isReplaying, data, replayCursorTimestamp, timeframe]);

  useEffect(() => {
    if (!isReplaying || replayPrice == null) return;
    setReplayClosePrice(selectedSymbol, replayPrice);
  }, [isReplaying, replayPrice, selectedSymbol]);

  // Release replay price ownership when playback stops.
  useEffect(() => {
    if (!isReplaying) clearReplayPrices();
    return () => {
      if (!isReplaying) clearReplayPrices();
    };
  }, [isReplaying]);

  return {
    replayCandles,
    replayTradeEvents: isReplaying ? data?.tradeEvents : undefined,
    replayPrice,
  };
}
