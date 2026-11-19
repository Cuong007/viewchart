import { useEffect, useRef } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";
import { TF_INTERVAL_MS, type Timeframe } from "./constants.ts";

const STORE_SYNC_MS = 100;
const SERVER_SYNC_MS = 2000;
type TickBar = { t: number; o: number; h: number; l: number; c: number; v: number };
type MutableRef<T> = { current: T };

function syncCursorToStore(now: number, lastSyncRef: MutableRef<number>, cursorMs: number): void {
  if (now - lastSyncRef.current < STORE_SYNC_MS) return;
  useTradingStore.setState({ replayCursorTimestamp: cursorMs });
  lastSyncRef.current = now;
}

function syncCursorToServer(
  now: number,
  lastSyncRef: MutableRef<number>,
  accountId: string,
  sessionDate: string | null,
  cursorMs: number,
): void {
  if (now - lastSyncRef.current < SERVER_SYNC_MS || !sessionDate) return;
  lastSyncRef.current = now;
  api.replayPatchSession(accountId, { sessionDate, cursorTimestamp: cursorMs }).catch(() => null);
}

/** Build one replay stop per complete visible chart candle, skipping gaps in market data. */
function buildPlaybackTimes(bars: TickBar[], intervalMs: number): number[] {
  const lastBarByBucket = new Map<number, number>();
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / intervalMs) * intervalMs;
    lastBarByBucket.set(bucket, bar.t);
  }
  return [...lastBarByBucket.values()];
}

export function useReplayPlayback(accountId: string, timeframe: Timeframe) {
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const replayPaused = useTradingStore((s) => s.replayPaused);
  const replaySpeed = useTradingStore((s) => s.replaySpeed);
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const { data: sessionData } = useReplaySession(
    isReplaying ? accountId : null,
    replaySessionDate,
    selectedSymbol,
  );

  const speedRef = useRef(replaySpeed);
  const timeframeRef = useRef(timeframe);
  const sessionDateRef = useRef(replaySessionDate);
  const playbackBarsRef = useRef<TickBar[]>([]);
  const playbackTimesRef = useRef<number[]>([]);
  const cursorIndexRef = useRef(0);
  const stepAccumulatorRef = useRef(0);
  const localCursorMsRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const lastStoreSyncRef = useRef(0);
  const lastServerSyncRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const isActiveRef = useRef(false);

  useEffect(() => { speedRef.current = replaySpeed; }, [replaySpeed]);
  useEffect(() => {
    timeframeRef.current = timeframe;
    stepAccumulatorRef.current = 0;
  }, [timeframe]);
  useEffect(() => { sessionDateRef.current = replaySessionDate; }, [replaySessionDate]);

  useEffect(() => {
    if (!isReplaying) {
      localCursorMsRef.current = null;
      cursorIndexRef.current = 0;
      stepAccumulatorRef.current = 0;
      playbackBarsRef.current = [];
      playbackTimesRef.current = [];
      return;
    }
    localCursorMsRef.current = null;
    cursorIndexRef.current = 0;
    stepAccumulatorRef.current = 0;
  }, [isReplaying]);

  // Refresh the available candle sequence without advancing by wall-clock time.
  useEffect(() => {
    const nextBuffer = sessionData?.tickBuffer;
    if (!nextBuffer?.length) return;
    const previousCursor = localCursorMsRef.current ?? useTradingStore.getState().replayCursorTimestamp;
    playbackBarsRef.current = nextBuffer;
    const times = buildPlaybackTimes(nextBuffer, TF_INTERVAL_MS[timeframeRef.current] ?? 60_000);
    playbackTimesRef.current = times;
    if (previousCursor != null) {
      let idx = 0;
      while (idx < times.length && times[idx]! <= previousCursor) idx++;
      cursorIndexRef.current = Math.max(0, idx - 1);
    } else {
      cursorIndexRef.current = Math.min(30, Math.max(0, times.length - 1));
      localCursorMsRef.current = times[cursorIndexRef.current] ?? null;
      if (localCursorMsRef.current != null) {
        useTradingStore.setState({ replayCursorTimestamp: localCursorMsRef.current });
      }
    }
    stepAccumulatorRef.current = 0;
  }, [sessionData, timeframe]);

  // Keep the index aligned after a scrubber seek or a timeframe change.
  useEffect(() => {
    if (replayCursorTimestamp == null) return;
    const times = playbackTimesRef.current;
    if (!times.length) return;
    if (localCursorMsRef.current == null || Math.abs(replayCursorTimestamp - localCursorMsRef.current) > 1000) {
      localCursorMsRef.current = replayCursorTimestamp;
      let idx = 0;
      while (idx < times.length && times[idx]! <= replayCursorTimestamp) idx++;
      cursorIndexRef.current = Math.max(0, idx - 1);
      stepAccumulatorRef.current = 0;
    }
  }, [replayCursorTimestamp]);

  // TradingView-style single-bar stepping. Step buttons work while paused.
  useEffect(() => {
    const onStep = (event: Event) => {
      const direction = (event as CustomEvent<"forward" | "backward">).detail;
      const times = playbackTimesRef.current;
      if (!isReplaying || !times.length || (direction !== "forward" && direction !== "backward")) return;
      const nextIndex = Math.max(0, Math.min(times.length - 1, cursorIndexRef.current + (direction === "forward" ? 1 : -1)));
      cursorIndexRef.current = nextIndex;
      const nextCursor = times[nextIndex]!;
      localCursorMsRef.current = nextCursor;
      stepAccumulatorRef.current = 0;
      useTradingStore.setState({ replayPaused: true, replayCursorTimestamp: nextCursor });
      const now = performance.now();
      syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, nextCursor);
    };
    window.addEventListener("opencharts-replay-step", onStep);
    return () => window.removeEventListener("opencharts-replay-step", onStep);
  }, [accountId, isReplaying]);

  // Play advances through actual available candles; overnight/weekend gaps are skipped.
  useEffect(() => {
    if (!isReplaying || replayPaused) {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      lastFrameTimeRef.current = null;
      return;
    }

    isActiveRef.current = true;
    lastFrameTimeRef.current = null;
    const step = (now: number) => {
      if (lastFrameTimeRef.current == null) {
        lastFrameTimeRef.current = now;
        return;
      }
      const delta = Math.min(now - lastFrameTimeRef.current, 100);
      lastFrameTimeRef.current = now;
      const times = playbackTimesRef.current;
      if (!times.length) return;
      stepAccumulatorRef.current += (delta / 1000) * Math.max(0.1, speedRef.current);
      const steps = Math.floor(stepAccumulatorRef.current);
      if (steps <= 0) return;
      stepAccumulatorRef.current -= steps;
      const nextIndex = Math.min(times.length - 1, cursorIndexRef.current + steps);
      if (nextIndex !== cursorIndexRef.current) {
        cursorIndexRef.current = nextIndex;
        const nextCursor = times[nextIndex]!;
        localCursorMsRef.current = nextCursor;
        syncCursorToStore(now, lastStoreSyncRef, nextCursor);
        syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, nextCursor);
      }
      // At the last available candle, remain paused at that candle rather than
      // waiting for the real clock or silently switching back to live mode.
      if (nextIndex >= times.length - 1) {
        useTradingStore.setState({ replayPaused: true, replayCursorTimestamp: times[nextIndex]! });
        return;
      }
    };

    const frame = (now: number) => {
      if (!isActiveRef.current) return;
      step(now);
      if (isActiveRef.current) rafIdRef.current = requestAnimationFrame(frame);
    };
    rafIdRef.current = requestAnimationFrame(frame);
    return () => {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    };
  }, [isReplaying, replayPaused, accountId]);

  useEffect(() => () => {
    isActiveRef.current = false;
    if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
  }, []);
}
