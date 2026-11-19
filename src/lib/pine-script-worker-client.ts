import type { Candle } from "../../services/schemas.ts";
import type { PineExecutionResult, PineInputMeta } from "./pine-script-runtime.ts";

type WorkerPayload =
  | { type: "inputs"; code: string }
  | { type: "execute"; code: string; candles: Candle[]; overrides: Record<string, unknown> };
type WorkerRequest = WorkerPayload & { id: number };
type WorkerResponse =
  | { id: number; ok: true; value: PineExecutionResult | PineInputMeta[] }
  | { id: number; ok: false; error: string };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./pine-script.worker.ts", import.meta.url), { type: "module", name: "pine-script-runtime" });
  instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const task = pending.get(response.id);
    if (!task) return;
    pending.delete(response.id);
    if (response.ok) task.resolve(response.value);
    else task.reject(new Error(response.error));
  };
  const failAll = (message: string) => {
    for (const task of pending.values()) task.reject(new Error(message));
    pending.clear();
    instance.terminate();
    if (worker === instance) worker = null;
  };
  instance.onerror = event => failAll(event.message || "PineTS worker gặp lỗi.");
  instance.onmessageerror = () => failAll("Không thể đọc kết quả từ PineTS worker.");
  worker = instance;
  return instance;
}

function request<T>(payload: WorkerPayload): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      getWorker().postMessage({ ...payload, id } as WorkerRequest);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function executePineScriptInWorker(code: string, candles: Candle[], overrides: Record<string, unknown> = {}): Promise<PineExecutionResult> {
  return request<PineExecutionResult>({ type: "execute", code, candles, overrides });
}

export function getPineInputsInWorker(code: string): Promise<PineInputMeta[]> {
  return request<PineInputMeta[]>({ type: "inputs", code });
}
