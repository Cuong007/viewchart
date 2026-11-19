/// <reference lib="webworker" />
import { executePineScript, getPineInputs } from "./pine-script-runtime.ts";
import type { Candle } from "../services/schemas.ts";

type Request =
  | { id: number; type: "inputs"; code: string }
  | { id: number; type: "execute"; code: string; candles: Candle[]; overrides: Record<string, unknown> };

const scope = self as DedicatedWorkerGlobalScope;
scope.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const value = request.type === "inputs"
      ? getPineInputs(request.code)
      : await executePineScript(request.code, request.candles, request.overrides);
    scope.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
