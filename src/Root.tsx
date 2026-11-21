import { lazy, Suspense, useEffect, useState } from "react";
import { createDemoAdapter } from "./adapter/demo.ts";
import { OpenChartsProvider } from "./adapter/provider.tsx";
import type { OpenChartsAdapter } from "./adapter/types.ts";
import { chooseAdapter } from "./adapterChoice.ts";
import { BasicTerminal } from "./terminal/BasicTerminal.tsx";
const Terminal = lazy(() => import("./terminal/Terminal.tsx").then((m) => ({ default: m.Terminal })));
import { BasicTerminal } from "./terminal/BasicTerminal.tsx";

/**
 * The hosted app's root.
 *
 * Deliberately what an integrator would write: install an adapter, render the
 * terminal. Everything else — query cache, market-data stream, notifications,
 * error boundary — comes from `<OpenChartsProvider>`.
 *
 * Which backend runs is chosen at build time:
 *  - `VITE_ADAPTER=hyperliquid`, or no `VITE_ADAPTER` with `VITE_HL_BUILDER_ADDRESS`
 *    set: the Hyperliquid broker (live markets, real wallet, real orders).
 *  - `VITE_ADAPTER=binance`: the live-market-data example from examples/binance-adapter.
 *  - `VITE_ADAPTER=demo`, or nothing configured: the bundled demo data.
 *
 * The Hyperliquid and Binance code is loaded lazily, so neither reaches the
 * default (demo) bundle.
 */

const choice = chooseAdapter(import.meta.env);

const HyperliquidApp = lazy(() => import("./hyperliquid/ui/HyperliquidApp.tsx"));

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
      Loading…
    </div>
  );
}

function BinanceOrDemo() {
  const wantsBinance = choice === "binance";
  const wantsDnse = choice === "dnse";
  const [adapter, setAdapter] = useState<OpenChartsAdapter | null>(() =>
    wantsBinance || wantsDnse ? null : createDemoAdapter(),
  );

  useEffect(() => {
    if (!wantsBinance && !wantsDnse) return;
    const loadAdapter = wantsDnse
      ? import("../examples/dnse-adapter/dnse-adapter.ts").then(({ createDnseMarketDataAdapter }) => createDnseMarketDataAdapter())
      : import("../examples/binance-adapter/binance-adapter.ts").then(({ createBinancePaperAdapter }) => createBinancePaperAdapter());
    loadAdapter
      .then(setAdapter)
      .catch((err: unknown) => {
        console.error("[opencharts] failed to load the Binance adapter; using the demo", err);
        setAdapter(createDemoAdapter());
      });
  }, [wantsBinance, wantsDnse]);

  if (!adapter) return null;
  return (
    <OpenChartsProvider adapter={adapter}>
      {import.meta.env.VITE_BASIC_CHART === "1" ? <BasicTerminal /> : {import.meta.env.VITE_BASIC_CHART === "1" ? <BasicTerminal /> : <Terminal /> }}
    </OpenChartsProvider>
  );
}

export function Root() {
  if (choice === "hyperliquid") {
    return (
      <Suspense fallback={<Loading />}>
        <HyperliquidApp />
      </Suspense>
    );
  }
  return <BinanceOrDemo />;
}
