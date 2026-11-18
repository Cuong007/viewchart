import { useState } from "react";
import { CalendarDays, Pause, Play, Square } from "lucide-react";
import { cn, toLocalDateString } from "../../lib/utils.ts";
import { useTradingStore } from "../../services/store.tsx";
import { api } from "../../services/api.ts";
import { safeSession } from "../../lib/safe-storage.ts";

const SPEED_OPTIONS = [0.5, 1, 2, 5, 10] as const;
type Speed = (typeof SPEED_OPTIONS)[number];

function formatReplayTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

export function ReplayHUD({ accountId }: { accountId: string }) {
  const { isReplaying, replayPaused, replaySpeed, replayCursorTimestamp, setReplaySessionDate } = useTradingStore();
  const storageKey = `replay_session_date_${accountId}`;
  const [sessionDate, setSessionDate] = useState<string>(() => safeSession.getItem(storageKey) ?? toLocalDateString());

  const handleDateChange = (date: string) => {
    setSessionDate(date);
    safeSession.setItem(storageKey, date);
  };
  const handleStart = () => {
    setReplaySessionDate(sessionDate);
    api.replayStart(accountId, sessionDate, replaySpeed).catch(() => null);
  };
  const handlePause = () => api.replayPause(accountId, sessionDate).catch(() => null);
  const handleResume = () => api.replayResume(accountId, sessionDate).catch(() => null);
  const handleStop = () => api.replayStop(accountId, sessionDate).catch(() => null);
  const handleSpeed = (speed: Speed) => {
    if (isReplaying) api.replaySetSpeed(accountId, sessionDate, speed).catch(() => null);
  };

  return (
    <div className="flex h-8 max-w-full items-center gap-1 rounded-md border border-[#2a2e39] bg-[#131722] px-1.5 text-[#d1d4dc] shadow-sm shrink-0">
      <span className="hidden sm:inline px-1 text-[10px] font-semibold uppercase tracking-wider text-[#787b86]">Bar Replay</span>
      {!isReplaying ? (
        <label className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[#d1d4dc] hover:bg-[#2a2e39]" title="Choose replay date">
          <CalendarDays className="h-3.5 w-3.5 text-[#9598a1]" />
          <input type="date" value={sessionDate} onChange={(e) => handleDateChange(e.target.value)} max={toLocalDateString()}
            className="w-[7.1rem] bg-transparent text-[11px] text-[#d1d4dc] outline-none [color-scheme:dark]" />
        </label>
      ) : (
        <span className="min-w-[4.3rem] px-1 text-center font-mono text-[11px] tabular-nums text-[#f0b90b]">
          {replayCursorTimestamp != null ? formatReplayTime(replayCursorTimestamp) : "--:--:--"}
        </span>
      )}
      <span className="mx-0.5 h-4 w-px bg-[#2a2e39]" />
      {!isReplaying ? (
        <button onClick={handleStart} title="Start bar replay" aria-label="Start bar replay" className="flex h-6 w-7 items-center justify-center rounded text-[#2962ff] hover:bg-[#2962ff]/15">
          <Play className="h-4 w-4 fill-current" />
        </button>
      ) : replayPaused ? (
        <button onClick={handleResume} title="Resume replay" aria-label="Resume replay" className="flex h-6 w-7 items-center justify-center rounded text-[#2962ff] hover:bg-[#2962ff]/15">
          <Play className="h-4 w-4 fill-current" />
        </button>
      ) : (
        <button onClick={handlePause} title="Pause replay" aria-label="Pause replay" className="flex h-6 w-7 items-center justify-center rounded hover:bg-[#2a2e39]">
          <Pause className="h-4 w-4 fill-current" />
        </button>
      )}
      {isReplaying && <button onClick={handleStop} title="Stop replay" aria-label="Stop replay" className="flex h-6 w-7 items-center justify-center rounded text-[#f23645] hover:bg-[#f23645]/15"><Square className="h-3.5 w-3.5 fill-current" /></button>}
      <span className="mx-0.5 h-4 w-px bg-[#2a2e39]" />
      <div className="flex items-center gap-0.5">
        {SPEED_OPTIONS.map((speed) => (
          <button key={speed} onClick={() => handleSpeed(speed)} disabled={!isReplaying}
            className={cn("rounded px-1.5 py-1 text-[10px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-35",
              replaySpeed === speed ? "bg-[#2962ff] text-white" : "text-[#9598a1] hover:bg-[#2a2e39] hover:text-[#d1d4dc]")}>
            {speed}×
          </button>
        ))}
      </div>
    </div>
  );
}
