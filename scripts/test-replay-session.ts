import assert from "node:assert/strict";
import { getReplayDayBounds } from "../src/services/replay.ts";

function localDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const now = new Date(2026, 10, 20, 8, 4, 0, 0).getTime();
const today = localDate(new Date(now));
const todayBounds = getReplayDayBounds(today, now);
assert.equal(todayBounds.startMs, new Date(`${today}T00:00:00`).getTime());
assert.equal(todayBounds.endMs, now + 60_000, "today includes only a short forming-candle margin");

const previousDate = new Date(now);
previousDate.setDate(previousDate.getDate() - 1);
const yesterday = localDate(previousDate);
const yesterdayBounds = getReplayDayBounds(yesterday, now);
const expectedEnd = new Date(`${yesterday}T00:00:00`);
expectedEnd.setDate(expectedEnd.getDate() + 1);
assert.equal(yesterdayBounds.endMs, expectedEnd.getTime(), "past replay must end at next local midnight");
assert.ok(yesterdayBounds.endMs < now, "past replay must not include later sessions");

assert.throws(() => getReplayDayBounds("not-a-date", now), /Invalid replay session date/);
console.log("Replay session date-boundary smoke tests passed.");
