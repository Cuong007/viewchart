import { useRef, useCallback } from "react";
import { useTradingStore } from "../../services/store.tsx";
import { useReplaySession } from "../../services/queries.ts";
import { api } from "../../services/api.ts";

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ReplayScrubber({ accountId }: { accountId: string }) {
  const { replayCursorTimestamp, replaySessionDate } = useTradingStore();
  const selectedSymbol = useTradingStore((s) => s.selectedSymbol);
  const { data } = useReplaySession(accountId, replaySessionDate, selectedSymbol);
  const barRef = useRef<HTMLDivElement>(null);
  const tickBuffer = data?.tickBuffer ?? [];
  const tradeEvents = data?.tradeEvents ?? [];
  const startMs = tickBuffer[0]?.t ?? null;
  const endMs = tickBuffer[tickBuffer.length - 1]?.t ?? null;
  const rangeMs = startMs != null && endMs != null ? endMs - startMs : 0;
  const thumbPct = replayCursorTimestamp != null && startMs != null && rangeMs > 0
    ? Math.max(0, Math.min(100, ((replayCursorTimestamp - startMs) / rangeMs) * 100)) : 0;

  const seekToX = useCallback((clientX: number) => {
    if (!barRef.current || !replaySessionDate || startMs == null || rangeMs <= 0) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    api.replaySeek(accountId, replaySessionDate, new Date(startMs + pct * rangeMs).toISOString()).catch(() => null);
  }, [accountId, replaySessionDate, startMs, rangeMs]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekToX(e.clientX);
  }, [seekToX]);
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 1) seekToX(e.clientX);
  }, [seekToX]);

  if (!replaySessionDate || tickBuffer.length === 0) return null;
  return (
    <div className="flex min-h-10 items-center gap-2 border-t border-[#2a2e39] bg-[#131722] px-3 py-1.5 text-[#d1d4dc] select-none">
      <span className="shrink-0 text-[10px] font-mono tabular-nums text-[#9598a1]">{startMs != null ? formatTime(startMs) : "--:--"}</span>
      <div ref={barRef} role="slider" aria-label="Replay timeline" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(thumbPct)}
        onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
        className="group relative h-5 flex-1 cursor-crosshair touch-none">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#2a2e39]" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#2962ff]" style={{ width: `${thumbPct}%` }} />
        {startMs != null && rangeMs > 0 && tradeEvents.map((ev) => {
          const ms = new Date(ev.timestamp).getTime();
          const pct = ((ms - startMs) / rangeMs) * 100;
          if (pct < 0 || pct > 100) return null;
          return <span key={ev.id} title={ev.type === "violation" ? ev.ruleCode : `${ev.type} ${ev.symbolName ?? ""}`}
            className={`absolute left-0 top-1/2 z-10 h-1.5 w-1.5 -translate-y-1/2 -translate-x-1/2 rounded-full ${ev.type === "violation" ? "bg-[#f23645]" : ev.type === "exit" ? "bg-[#089981]" : "bg-[#2962ff]"}`}
            style={{ left: `${pct}%` }} />;
        })}
        <span className="absolute top-1/2 z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-[#2962ff] shadow" style={{ left: `${thumbPct}%` }} />
      </div>
      <span className="shrink-0 text-[10px] font-mono tabular-nums text-[#9598a1]">{endMs != null ? formatTime(endMs) : "--:--"}</span>
      <span className="hidden shrink-0 text-[10px] text-[#787b86] sm:inline">DRAG TO SEEK</span>
    </div>
  );
}
