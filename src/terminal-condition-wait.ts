import type {
  TerminalPluginPhase, TerminalPluginPublicStatus,
} from "@soksak/soksak-contract-plugin-terminal";
import type { TerminalStatusController } from "./terminal-status-publication";

export interface TerminalConditionWaitOptions {
  status: TerminalStatusController;
  phase: TerminalPluginPhase;
  contains?: string;
  timeoutMs: number;
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  size?: { cols?: number; colsLessThan?: number; colsGreaterThan?: number; rows?: number };
  waitForSize?(condition: { cols?: number; colsLessThan?: number; colsGreaterThan?: number; rows?: number }, timeoutMs: number): Promise<{ cols: number; rows: number }>;
  presentation?: {
    focusedInput?: boolean;
    cursorVisible?: boolean;
    cursorActive?: boolean;
    acceptedInputSequenceGreaterThan?: number;
    ptyWriteSequenceGreaterThan?: number;
  };
  theme?: { themeMode?: "light" | "dark"; effectiveBackground?: string };
  viewport?: {
    historySize?: number;
    minHistorySize?: number;
    offset?: number;
    followMode?: "follow" | "pinned";
  };
  readViewport?(): { historySize: number; offset: number; followMode: "follow" | "pinned" };
}

export async function waitForTerminalConditions(
  options: TerminalConditionWaitOptions,
): Promise<TerminalPluginPublicStatus & { text?: string }> {
  const deadline = performance.now() + options.timeoutMs;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const text = options.contains
    ? await options.waitForText(options.contains, remaining())
    : undefined;
  const hasSizeCondition = options.size
    && (options.size.cols !== undefined || options.size.colsLessThan !== undefined || options.size.colsGreaterThan !== undefined || options.size.rows !== undefined);
  const size = hasSizeCondition && options.size && options.waitForSize
    ? await options.waitForSize(options.size, remaining())
    : undefined;
  if (options.viewport && !options.readViewport) {
    throw new Error("terminal viewport wait requires a viewport state reader");
  }
  let matchedViewport: ReturnType<NonNullable<TerminalConditionWaitOptions["readViewport"]>> | undefined;
  const status = await options.status.wait([options.phase, "blocked"], remaining(), (next) => {
    if (next.phase === "blocked") return true;
    const presentationMatches = !options.presentation || ((options.presentation.focusedInput === undefined
      || next.presentation.focusedInput === options.presentation.focusedInput)
      && (options.presentation.cursorVisible === undefined
        || next.presentation.cursorVisible === options.presentation.cursorVisible)
      && (options.presentation.cursorActive === undefined
        || next.presentation.cursorActive === options.presentation.cursorActive)
      && (options.presentation.acceptedInputSequenceGreaterThan === undefined
        || next.presentation.acceptedInputSequence
          > options.presentation.acceptedInputSequenceGreaterThan)
      && (options.presentation.ptyWriteSequenceGreaterThan === undefined
        || next.presentation.ptyWriteSequence
          > options.presentation.ptyWriteSequenceGreaterThan));
    const themeMatches = !options.theme
      || ((options.theme.themeMode === undefined
        || next.presentation.themeMode === options.theme.themeMode)
        && (options.theme.effectiveBackground === undefined
          || next.presentation.effectiveTheme.background === options.theme.effectiveBackground));
    const viewport = options.readViewport?.();
    const viewportMatches = !options.viewport || (viewport !== undefined
      && (options.viewport.historySize === undefined
        || viewport.historySize === options.viewport.historySize)
      && (options.viewport.minHistorySize === undefined
        || viewport.historySize >= options.viewport.minHistorySize)
      && (options.viewport.offset === undefined || viewport.offset === options.viewport.offset)
      && (options.viewport.followMode === undefined
        || viewport.followMode === options.viewport.followMode));
    if (presentationMatches && themeMatches && viewportMatches) matchedViewport = viewport;
    return presentationMatches && themeMatches && viewportMatches;
  });
  const viewport = matchedViewport ?? options.readViewport?.();
  return {
    ...status,
    ...(text === undefined ? {} : { text }),
    ...(size ?? {}),
    ...(viewport ?? {}),
  };
}
