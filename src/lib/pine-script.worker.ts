/// <reference lib="webworker" />
import { executePineScript, getPineInputs } from "./pine-script-runtime.ts";
import type { Candle } from "../services/schemas.ts";

type Request =
  | { id: number; type: "inputs"; code: string }
  | { id: number; type: "execute"; code: string; candles: Candle[]; overrides: Record<string, unknown> };

const scope = self as DedicatedWorkerGlobalScope;
let queued: Request | null = null;
let running = false;

function rejectSuperseded(request: Request): void {
  scope.postMessage({
    id: request.id,
    ok: false,
    error: "Yêu cầu PineTS đã được thay thế bởi yêu cầu mới hơn.",
  });
}

async function drainQueue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queued) {
      const request = queued;
      queued = null;
      try {
        const value = request.type === "inputs"
          ? getPineInputs(request.code)
          : await executePineScript(request.code, request.candles, request.overrides);
        scope.postMessage({ id: request.id, ok: true, value });
      } catch (error) {
        scope.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
    // A message can arrive between the final loop check and this finally block.
    if (queued) void drainQueue();
  }
}

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  // PineTS runs can be expensive on mobile. Keep one active execution and at
  // most one waiting request; rapid editor changes replace stale queued work
  // instead of building an unbounded backlog or running several contexts at once.
  if (queued) rejectSuperseded(queued);
  queued = request;
  void drainQueue();
};
