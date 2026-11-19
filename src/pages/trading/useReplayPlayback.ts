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
 * End-of-buffer transition: pin the cursor, stop the server session (so it
 * doesn't sit in PLAYING until the TTL reaper catches it) and flip the store.
 */
function localDateString(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function finishReplay(accountId: string, sessionDate: string | null, endMs: number): void {
  useTradingStore.setState({ replayCursorTimestamp: endMs });
  if (sessionDate) {
    api.replayStop(accountId, sessionDate).catch(() => null);
  }
  useTradingStore.getState().onReplayStateChanged("stopped");
}

/**
 * Drives the client-side replay clock using requestAnimationFrame.
 *
 * - Advances one candle per second at 1x; speed controls candles per second.
 * - Throttles Zustand writes and debounces server cursor persistence.
 * - Detects external seeks by comparing store cursor to local cursor ref.
 * - Auto-stops and emits "stopped" when the cursor reaches the end of the buffer.
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
  const tickBufferRef = useRef<TickBar[]>([]);
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

  // Reset playback position whenever a replay session (re)starts. Without this
  // the local cursor/index refs survive a stop, so replaying the same day
  // resumed from the previous end-of-buffer and auto-stopped immediately.
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
    tickBufferRef.current = nextBuffer;
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
        localCursorMsRef.current = currentCursor + steps * intervalMs;
        stepAccumulatorRef.current -= steps;
      }
      const newCursorMs = localCursorMsRef.current ?? buf[0]!.t;
      // Keep the chart index aligned to the latest bar at or before the clock,
      // while allowing the clock itself to move ahead of a delayed data feed.
      let nextIndex = 0;
      while (nextIndex < buf.length && (buf[nextIndex]?.t ?? Infinity) <= newCursorMs) nextIndex++;
      cursorIndexRef.current = Math.max(0, nextIndex - 1);
      syncCursorToStore(now, lastStoreSyncRef, newCursorMs);
      syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, newCursorMs);

      const today = localDateString(Date.now());
      const isCurrentDay = sessionDateRef.current === today;
      const lastBarMs = tickBufferRef.current[tickBufferRef.current.length - 1]?.t ?? buf[buf.length - 1]?.t ?? 0;
      // Historical market-data feeds commonly stop recording at the final
      // session candle (e.g. 16:39). The replay clock must not stop at that
      // candle: preserve a one-hour replay tail so the selected session runs
      // through 17:39. Today's replay remains live and ends at wall-clock now.
      const historicalEndMs = lastBarMs > 0 ? lastBarMs + 60 * 60 * 1000 : 0;
      const targetMs = isCurrentDay ? Date.now() : historicalEndMs;
      if (newCursorMs >= targetMs && targetMs > 0) {
        isActiveRef.current = false;
        finishReplay(accountId, sessionDateRef.current, targetMs);
        return false;
      }
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
