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
  size?: { cols?: number; colsLessThan?: number; rows?: number };
  waitForSize?(condition: { cols?: number; colsLessThan?: number; rows?: number }, timeoutMs: number): Promise<{ cols: number; rows: number }>;
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
    && (options.size.cols !== undefined || options.size.colsLessThan !== undefined || options.size.rows !== undefined);
  const size = hasSizeCondition && options.size && options.waitForSize
    ? await options.waitForSize(options.size, remaining())
    : undefined;
  const status = await options.status.wait([options.phase, "blocked"], remaining());
  return { ...status, ...(text === undefined ? {} : { text }), ...(size ?? {}) };
}
