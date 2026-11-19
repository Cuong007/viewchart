import { useEffect, useRef } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";
import { TF_INTERVAL_MS, type Timeframe } from "./constants.ts";

/** How often to push replayCursorTimestamp to the Zustand store (ms). */
const STORE_SYNC_MS = 100;

/** How often to PATCH the server with the current cursor position (ms). */
const SERVER_SYNC_MS = 2000;

type TickBar = { t: number; o: number; h: number; l: number; c: number; v: number };

type MutableRef<T> = { current: T };

/** Throttled store write (drives scrubber + HUD timestamp). */
function syncCursorToStore(now: number, lastSyncRef: MutableRef<number>, cursorMs: number): void {
  if (now - lastSyncRef.current < STORE_SYNC_MS) return;
  useTradingStore.setState({ replayCursorTimestamp: cursorMs });
  lastSyncRef.current = now;
}

/** Throttled server PATCH so the cursor survives a reload. */
function syncCursorToServer(
  now: number,
  lastSyncRef: MutableRef<number>,
  accountId: string,
  sessionDate: string | null,
  cursorMs: number,
): void {
  if (now - lastSyncRef.current < SERVER_SYNC_MS || !sessionDate) return;
  lastSyncRef.current = now;
  api
    .replayPatchSession(accountId, { sessionDate, cursorTimestamp: cursorMs })
    .catch(() => null);
}


/**
 * Drives the client-side replay clock using requestAnimationFrame.
 *
 * - Advances one candle per second at 1x; speed controls candles per second.
 * - Throttles Zustand writes and debounces server cursor persistence.
 * - Detects external seeks by comparing store cursor to local cursor ref.
 * - Never auto-stops at the final market candle; it follows the wall clock.
 */
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

  // ── Stable refs (no re-render on change) ────────────────
  const speedRef = useRef(replaySpeed);
  const timeframeRef = useRef(timeframe);
  const sessionDateRef = useRef(replaySessionDate);
  const playbackBarsRef = useRef<TickBar[]>([]);
  const cursorIndexRef = useRef(0);
  const stepAccumulatorRef = useRef(0);
  const localCursorMsRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const lastStoreSyncRef = useRef(0);
  const lastServerSyncRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const isActiveRef = useRef(false);

  // Keep speed + sessionDate refs current without restarting the loop
  useEffect(() => {
    speedRef.current = replaySpeed;
  }, [replaySpeed]);
  useEffect(() => {
    timeframeRef.current = timeframe;
    stepAccumulatorRef.current = 0;
  }, [timeframe]);
  useEffect(() => {
    sessionDateRef.current = replaySessionDate;
  }, [replaySessionDate]);

  // Reset playback position whenever a replay session (re)starts.
  useEffect(() => {
    if (isReplaying) {
      localCursorMsRef.current = null;
      cursorIndexRef.current = 0;
      stepAccumulatorRef.current = 0;
    }
  }, [isReplaying]);

  // Replay advances on raw 1-minute bars, regardless of the chart timeframe.
  // Keep the current cursor stable while polling appends new bars.
  useEffect(() => {
    const nextBuffer = sessionData?.tickBuffer;
    if (!nextBuffer?.length) return;
    const previousCursor = localCursorMsRef.current ?? useTradingStore.getState().replayCursorTimestamp;
    playbackBarsRef.current = nextBuffer;
    if (previousCursor != null) {
      let idx = 0;
      while (idx < nextBuffer.length && (nextBuffer[idx]?.t ?? Infinity) <= previousCursor) idx++;
      cursorIndexRef.current = Math.max(0, idx - 1);
      // Keep the time cursor even when it is temporarily ahead of the newest
      // downloaded candle. Polling will fill the gap without rewinding playback.
    } else {
      cursorIndexRef.current = Math.min(30, nextBuffer.length - 1);
      localCursorMsRef.current = nextBuffer[cursorIndexRef.current]?.t ?? null;
    }
    stepAccumulatorRef.current = 0;
  }, [sessionData]);

  // Detect external seeks: if the store cursor diverges from our local cursor
  // by more than 1s, accept the new position and recompute the tick index.
  useEffect(() => {
    if (replayCursorTimestamp == null) return;
    const local = localCursorMsRef.current;
    if (local == null || Math.abs(replayCursorTimestamp - local) > 1000) {
      localCursorMsRef.current = replayCursorTimestamp;
      // Recompute tick index after seek
      const buf = playbackBarsRef.current;
      let idx = 0;
      while (idx < buf.length && (buf[idx]?.t ?? Infinity) <= replayCursorTimestamp) idx++;
      cursorIndexRef.current = Math.max(0, idx - 1);
      stepAccumulatorRef.current = 0;
    }
  }, [replayCursorTimestamp]);

  // TradingView-style single-candle stepping while paused.
  useEffect(() => {
    const handleStep = (event: Event) => {
      const direction = (event as CustomEvent<"forward" | "backward">).detail;
      if (!useTradingStore.getState().isReplaying) return;
      const times = playbackTimesRef.current;
      if (!times.length) return;
      const next = Math.max(0, Math.min(times.length - 1, cursorIndexRef.current + (direction === "forward" ? 1 : -1)));
      cursorIndexRef.current = next;
      const timestamp = times[next];
      if (timestamp == null) return;
      localCursorMsRef.current = timestamp;
      stepAccumulatorRef.current = 0;
      useTradingStore.setState({ replayPaused: true, replayCursorTimestamp: timestamp });
      syncCursorToServer(Date.now(), { current: 0 }, accountId, sessionDateRef.current, timestamp);
    };
    window.addEventListener("opencharts-replay-step", handleStep);
    return () => window.removeEventListener("opencharts-replay-step", handleStep);
  }, [accountId]);

  // ── rAF playback loop ────────────────────────────────────
  useEffect(() => {
    if (!isReplaying || replayPaused) {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      lastFrameTimeRef.current = null;
      return;
    }

    isActiveRef.current = true;
    lastFrameTimeRef.current = null;

    // One playback step; returns false when the loop must stop scheduling.
    const step = (now: number): boolean => {
      // Bootstrap frame time on first tick after play/resume
      if (lastFrameTimeRef.current === null) {
        lastFrameTimeRef.current = now;
        return true;
      }

      // Advance one visible chart candle per second at 1x. Source data remains
      // 1m, while the replay clock follows the selected chart timeframe.
      const realDeltaMs = Math.min(now - lastFrameTimeRef.current, 100);
      lastFrameTimeRef.current = now;
      const buf = playbackBarsRef.current;
      if (buf.length === 0) return true;

      if (localCursorMsRef.current == null) {
        cursorIndexRef.current = Math.max(0, cursorIndexRef.current);
        localCursorMsRef.current = buf[cursorIndexRef.current]?.t ?? buf[0]!.t;
      }
      stepAccumulatorRef.current += (realDeltaMs / 1000) * Math.max(0.1, speedRef.current);
      const steps = Math.floor(stepAccumulatorRef.current);
      if (steps > 0) {
        const currentCursor = localCursorMsRef.current ?? buf[0]!.t;
        const intervalMs = TF_INTERVAL_MS[timeframeRef.current] ?? 60_000;
        // Replay may start on any historical date, but its clock is never
        // bounded by that day's final candle. It advances continuously until
        // it catches the real wall clock, then follows "now" without stopping
        // or switching back to realtime mode.
        localCursorMsRef.current = Math.min(
          currentCursor + steps * intervalMs,
          Date.now(),
        );
        stepAccumulatorRef.current -= steps;
      }
      const newCursorMs = Math.min(localCursorMsRef.current ?? buf[0]!.t, Date.now());
      localCursorMsRef.current = newCursorMs;
      // Keep the chart index aligned to the latest bar at or before the clock,
      // while allowing the clock itself to move ahead of a delayed data feed.
      let nextIndex = 0;
      while (nextIndex < buf.length && (buf[nextIndex]?.t ?? Infinity) <= newCursorMs) nextIndex++;
      cursorIndexRef.current = Math.max(0, nextIndex - 1);
      syncCursorToStore(now, lastStoreSyncRef, newCursorMs);
      syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, newCursorMs);

      // Intentionally no end-of-session stop condition. Replay stays active
      // after the historical market close and remains pinned to current time
      // once it catches up, rather than reverting to the live chart.
      return true;
    };

    const frame = (now: number) => {
      if (!isActiveRef.current) return;
      if (step(now)) rafIdRef.current = requestAnimationFrame(frame);
    };

    rafIdRef.current = requestAnimationFrame(frame);

    return () => {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isReplaying, replayPaused, accountId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);
}
