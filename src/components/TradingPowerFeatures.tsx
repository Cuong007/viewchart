/**
 * Supplementary market-info panels.
 *
 * This module used to carry six more components (price alerts, a sentiment
 * gauge, multi-symbol comparison, trade signals, a risk overlay and a P&L
 * heatmap). None were mounted, and the sentiment gauge and "STRONG BUY" trade
 * signals derived their output from a hash of the symbol name rather than from
 * market data — fabricated analysis waiting for someone to wire it up. They
 * were removed rather than left as a trap; build them against real data if the
 * panels are wanted back.
 */


import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Newspaper } from "lucide-react";
import { TradingViewTimeline } from "./TradingViewWidgets.tsx";

export function NewsFeed({
  symbol,
  theme = "dark",
}: {
  symbol: string;
  theme?: "dark" | "light";
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Newspaper className="h-4 w-4 text-accent" />
          Market News
          <span className="ml-auto text-[9px] font-medium uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500">
            Live feed
          </span>
        </CardTitle>
        <p className="text-[10px] text-muted-foreground">
          Headlines and market stories for {symbol}, provided by TradingView.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <TradingViewTimeline symbol={symbol} theme={theme} height={520} />
      </CardContent>
    </Card>
  );
}
