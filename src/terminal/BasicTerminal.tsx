import { TerminalProvider } from "./context.tsx";
import { BasicChartPage } from "../pages/BasicChartPage.tsx";

/** Minimal chart-only composition: no order, position, or lower trading panels. */
export function BasicTerminal() {
  return (
    <TerminalProvider>
      <BasicChartPage />
    </TerminalProvider>
  );
}
