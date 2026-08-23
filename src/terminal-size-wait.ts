export interface TerminalSizeCondition {
  cols?: number;
  colsLessThan?: number;
  colsGreaterThan?: number;
  rows?: number;
}

export function waitForTerminalSize(
  root: HTMLElement,
  condition: TerminalSizeCondition,
  timeoutMs: number,
  current: () => { cols: number; rows: number },
): Promise<{ cols: number; rows: number }> {
  const matches = (size: { cols: number; rows: number }) =>
    (condition.cols === undefined || size.cols === condition.cols)
    && (condition.colsLessThan === undefined || size.cols < condition.colsLessThan)
    && (condition.colsGreaterThan === undefined || size.cols > condition.colsGreaterThan)
    && (condition.rows === undefined || size.rows === condition.rows);
  const initial = current();
  if (matches(initial)) return Promise.resolve(initial);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      root.removeEventListener("soksak:terminal-size", onSize);
      reject(new Error("terminal size wait timed out after " + timeoutMs + "ms"));
    }, timeoutMs);
    const onSize = (event: Event) => {
      const detail = (event as CustomEvent).detail as { cols?: unknown; rows?: unknown };
      if (typeof detail?.cols !== "number" || typeof detail?.rows !== "number") return;
      const size = { cols: detail.cols, rows: detail.rows };
      if (!matches(size)) return;
      clearTimeout(timer);
      root.removeEventListener("soksak:terminal-size", onSize);
      resolve(size);
    };
    root.addEventListener("soksak:terminal-size", onSize);
  });
}
