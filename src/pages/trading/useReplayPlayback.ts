import { useEffect, useRef } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";

const SERVER_SYNC_MS = 2000;
type TickBar = { t: number; o: number; h: number; l: number; c: number; v: number };
type MutableRef<T> = { current: T };

function syncCursorToServer(now: number, lastSyncRef: MutableRef<number>, accountId: string, sessionDate: string | null, cursorMs: number) {
  if (now - lastSyncRef.current < SERVER_SYNC_MS || !sessionDate) return;
  lastSyncRef.current = now;
  api.replayPatchSession(accountId, { sessionDate, cursorTimestamp: cursorMs }).catch(() => null);
}

function finishReplay(accountId: string, sessionDate: string | null, endMs: number) {
  useTradingStore.setState({ replayCursorTimestamp: endMs });
  if (sessionDate) api.replayStop(accountId, sessionDate).catch(() => null);
  useTradingStore.getState().onReplayStateChanged("stopped");
}

/**
 * TradingView-style bar replay: the cursor advances to the NEXT historical
 * candle timestamp on each playback beat. Speed controls the delay between
 * bars (1x = one candle/second), not elapsed market-time seconds.
 */
export function useReplayPlayback(accountId: string) {
  const isReplaying = useTradingStore((s) => s.isReplaying);
  const replayPaused = useTradingStore((s) => s.replayPaused);
  const replaySpeed = useTradingStore((s) => s.replaySpeed);
  const replayCursorTimestamp = useTradingStore((s) => s.replayCursorTimestamp);
  const replaySessionDate = useTradingStore((s) => s.replaySessionDate);
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const { data: sessionData } = useReplaySession(isReplaying ? accountId : null, replaySessionDate, selectedSymbol);

  const speedRef = useRef(replaySpeed);
  const sessionDateRef = useRef(replaySessionDate);
  const tickBufferRef = useRef<TickBar[]>([]);
  const nextTickIdxRef = useRef(0);
  const localCursorMsRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const elapsedRef = useRef(0);
  const lastServerSyncRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const isActiveRef = useRef(false);

  useEffect(() => { speedRef.current = replaySpeed; }, [replaySpeed]);
  useEffect(() => { sessionDateRef.current = replaySessionDate; }, [replaySessionDate]);

  useEffect(() => {
    if (isReplaying) {
      localCursorMsRef.current = null;
      nextTickIdxRef.current = 0;
      elapsedRef.current = 0;
      lastFrameTimeRef.current = null;
    }
  }, [isReplaying]);

  useEffect(() => {
    if (!sessionData?.tickBuffer) return;
    tickBufferRef.current = sessionData.tickBuffer;
    if (localCursorMsRef.current == null && replayCursorTimestamp != null) {
      localCursorMsRef.current = replayCursorTimestamp;
      let idx = 0;
      while (idx < sessionData.tickBuffer.length && sessionData.tickBuffer[idx]!.t <= replayCursorTimestamp) idx++;
      nextTickIdxRef.current = idx;
    }
  }, [sessionData, replayCursorTimestamp]);

  useEffect(() => {
    if (replayCursorTimestamp == null) return;
    const local = localCursorMsRef.current;
    if (local == null || Math.abs(replayCursorTimestamp - local) > 1000) {
      localCursorMsRef.current = replayCursorTimestamp;
      const buf = tickBufferRef.current;
      let idx = 0;
      while (idx < buf.length && buf[idx]!.t <= replayCursorTimestamp) idx++;
      nextTickIdxRef.current = idx;
      elapsedRef.current = 0;
    }
  }, [replayCursorTimestamp]);

  useEffect(() => {
    if (!isReplaying || replayPaused) {
      isActiveRef.current = false;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      lastFrameTimeRef.current = null;
      elapsedRef.current = 0;
      return;
    }

    isActiveRef.current = true;
    lastFrameTimeRef.current = null;

    const step = (now: number): boolean => {
      if (lastFrameTimeRef.current == null) {
        lastFrameTimeRef.current = now;
        return true;
      }
      const delta = Math.min(now - lastFrameTimeRef.current, 250);
      lastFrameTimeRef.current = now;
      elapsedRef.current += delta;

      const buf = tickBufferRef.current;
      if (buf.length === 0) return true;
      const interval = 1000 / Math.max(0.1, speedRef.current);
      if (elapsedRef.current >= interval) {
        // Keep at most one step per frame: every visible update is a real bar.
        elapsedRef.current %= interval;
        const next = buf[nextTickIdxRef.current];
        if (!next) {
          isActiveRef.current = false;
          finishReplay(accountId, sessionDateRef.current, buf[buf.length - 1]!.t);
          return false;
        }
        localCursorMsRef.current = next.t;
        nextTickIdxRef.current += 1;
        useTradingStore.setState({ replayCursorTimestamp: next.t });
        syncCursorToServer(now, lastServerSyncRef, accountId, sessionDateRef.current, next.t);
        if (nextTickIdxRef.current >= buf.length) {
          isActiveRef.current = false;
          finishReplay(accountId, sessionDateRef.current, next.t);
          return false;
        }
      }
      return true;
    };

    const frame = (now: number) => {
      if (isActiveRef.current && step(now)) rafIdRef.current = requestAnimationFrame(frame);
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
