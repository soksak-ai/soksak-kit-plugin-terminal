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
}

export async function waitForTerminalConditions(
  options: TerminalConditionWaitOptions,
): Promise<TerminalPluginPublicStatus & { text?: string }> {
  const deadline = performance.now() + options.timeoutMs;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const text = options.contains
    ? await options.waitForText(options.contains, remaining())
    : undefined;
  const status = await options.status.wait([options.phase, "blocked"], remaining());
  return text === undefined ? status : { ...status, text };
}
