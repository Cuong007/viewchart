import { describe, expect, it } from "vitest";
import { summarizePineTrades, type PineTrade } from "../lib/pine-script-runtime.ts";

const trade = (id: string, pnlPoints: number, exitTime: number, isOpen = false): PineTrade => ({
  id, side: pnlPoints < 0 ? "SHORT" : "LONG", quantity: 1, entryPrice: 100,
  exitPrice: 100 + pnlPoints, entryTime: exitTime - 60_000, exitTime,
  pnlPoints, isOpen,
});

describe("Pine strategy performance statistics", () => {
  it("calculates drawdown, largest wins/losses and consecutive streaks", () => {
    const summary = summarizePineTrades([
      trade("1", 10, 1), trade("2", 5, 2), trade("3", -8, 3),
      trade("4", -4, 4), trade("5", 12, 5), trade("6", 0, 6),
    ]);
    expect(summary.totalTrades).toBe(6);
    expect(summary.winningTrades).toBe(3);
    expect(summary.losingTrades).toBe(2);
    expect(summary.totalPoints).toBe(15);
    expect(summary.maxDrawdownPoints).toBe(12);
    expect(summary.largestWinningTradePoints).toBe(12);
    expect(summary.largestLosingTradePoints).toBe(-8);
    expect(summary.maxConsecutiveWins).toBe(2);
    expect(summary.maxConsecutiveLosses).toBe(2);
    expect(summary.grossProfitPoints).toBe(27);
    expect(summary.grossLossPoints).toBe(12);
    expect(summary.profitFactor).toBe(2.25);
    expect(summary.openTrades).toBe(0);
  });

  it("excludes open trades from realized statistics but counts them separately", () => {
    const summary = summarizePineTrades([trade("closed", 4, 1), trade("open", 50, 2, true)]);
    expect(summary.totalTrades).toBe(1);
    expect(summary.totalPoints).toBe(4);
    expect(summary.openTrades).toBe(1);
  });

  it("returns a finite zero profit factor when there are no wins or losses", () => {
    expect(summarizePineTrades([]).profitFactor).toBe(0);
  });
});
