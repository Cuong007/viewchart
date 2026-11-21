import { useEffect, useState } from "react";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import type { OpenChartsAdapter } from "./adapter/types.ts";
import { BasicTerminal } from "./terminal/BasicTerminal.tsx";

function Loading() {
  return <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">Loading VN30F1M chart…</div>;
}

/** Standalone, read-only chart app. No trading gateway is installed. */
export function Root() {
  const [adapter, setAdapter] = useState<OpenChartsAdapter | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("../examples/dnse-adapter/dnse-adapter.ts")
      .then(({ createDnseMarketDataAdapter }) => createDnseMarketDataAdapter())
      .then((value) => { if (!cancelled) setAdapter(value); })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div role="alert" className="p-4 text-sm text-red-500">Không thể kết nối nguồn dữ liệu DNSE: {error}</div>;
  if (!adapter) return <Loading />;
  return <OpenChartsProvider adapter={adapter}><BasicTerminal /></OpenChartsProvider>;
}
