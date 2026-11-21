import { useCallback, useState } from "react";
import { useTerminal } from "../terminal/use-terminal.ts";
import { updateChartPreferences } from "../hooks/useChartPreferences.ts";
import { ChartPanel } from "./trading/ChartPanel.tsx";
import { ChartToolbar } from "./trading/ChartToolbar.tsx";

/**
 * Chart-only workspace. Deliberately excludes the trading bottom panel,
 * replay controls, paper-trading UI, journal, news and Pine Script editor.
 */
export function BasicChartPage() {
  const t = useTerminal();
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const setIndicators = useCallback((next: typeof t.activeIndicators) => {
    for (const type of next) if (!t.activeIndicators.includes(type)) t.toggleIndicator(type);
    for (const type of t.activeIndicators) if (!next.includes(type)) t.toggleIndicator(type);
  }, [t.activeIndicators, t.toggleIndicator]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <ChartToolbar
        selectedSymbol={t.selectedSymbol}
        symbols={t.symbols}
        onSymbolChange={t.setSelectedSymbol}
        timeframe={t.timeframe}
        onTimeframeChange={t.setTimeframe}
        activeIndicators={t.activeIndicators}
        onToggleIndicator={t.toggleIndicator}
        showIndicatorMenu={showIndicatorMenu}
        onToggleIndicatorMenu={() => setShowIndicatorMenu((v) => !v)}
        drawingTool={t.drawingTool}
        onDrawingTool={t.setDrawingTool}
        drawings={t.drawings}
        onClearDrawings={t.clearDrawings}
        rightPanel="watchlist"
        onRightPanel={() => undefined}
        showRightPanel={false}
        onToggleRightPanel={() => undefined}
        tick={t.tick}
        symbolInfo={t.symbolInfo}
        isReplaying={false}
        activePlugins={t.activePlugins}
        onTogglePlugin={t.togglePlugin}
        onSetIndicators={setIndicators}
        onSetPlugins={t.setPlugins}
        magnetMode={t.chartPrefs.magnetMode}
        onCycleMagnet={t.cycleMagnetMode}
        stayInDrawingMode={t.chartPrefs.stayInDrawingMode}
        onToggleStayInDrawingMode={() => updateChartPreferences({ stayInDrawingMode: !t.chartPrefs.stayInDrawingMode })}
      />
      <div className="relative flex-1 min-h-0 w-full">
        <ChartPanel
          candles={t.candles ?? []}
          selectedSymbol={t.selectedSymbol}
          timeframe={t.timeframe}
          isDark={t.isDark}
          activeIndicators={t.activeIndicators}
          indicatorParams={t.indicatorParams}
          drawingTool={t.drawingTool}
          drawings={t.drawings}
          onAddDrawing={t.addDrawing}
          onUpdateDrawing={t.updateDrawing}
          onRemoveDrawing={t.removeDrawing}
          onDrawingComplete={() => t.setDrawingTool("none")}
          onDrawingToolSelect={t.setDrawingTool}
          onUndoDrawing={t.undoDrawing}
          onRedoDrawing={t.redoDrawing}
          magnetMode={t.chartPrefs.magnetMode}
          stayInDrawingMode={t.chartPrefs.stayInDrawingMode}
          positions={[]}
          orders={[]}
          tick={t.tick}
          liveCandle={t.liveCandle}
          pipDigits={t.pipDigits}
          symbolInfo={t.symbolInfo}
          activePlugins={t.activePlugins}
          onTogglePlugin={t.togglePlugin}
          onClearDrawings={t.clearDrawings}
          onClearIndicators={t.clearIndicators}
          isReplaying={false}
        />
      </div>
    </div>
  );
}
