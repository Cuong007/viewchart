import type { Candle } from "../services/schemas.ts";
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
const REQUEST_TIMEOUT_MS = 60_000;
type PendingTask = { resolve: (value: any) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<number, PendingTask>();

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./pine-script.worker.ts", import.meta.url), { type: "module", name: "pine-script-runtime" });
  instance.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const task = pending.get(response.id);
    if (!task) return;
    clearTimeout(task.timer);
    pending.delete(response.id);
    if (response.ok) task.resolve(response.value);
    else task.reject(new Error(response.error));
  };
  const failAll = (message: string) => {
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); }
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
    const timer = setTimeout(() => {
      const instance = worker;
      if (instance) {
        for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("PineTS chạy quá 60 giây và đã bị dừng. Hãy giảm số nến hoặc đơn giản hóa mã chiến lược rồi thử lại.")); }
        pending.clear();
        instance.terminate();
        worker = null;
      } else {
        pending.delete(id);
        reject(new Error("PineTS chạy quá 60 giây. Hãy giảm số nến hoặc đơn giản hóa mã chiến lược rồi thử lại."));
      }
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      getWorker().postMessage({ ...payload, id } as WorkerRequest);
    } catch (error) {
      clearTimeout(timer);
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
