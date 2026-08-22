import type { TerminalResizeStatus, TerminalSequencedSize, TerminalSize } from "@soksak/soksak-contract-plugin-terminal";

interface ResizeStatusInput {
  pane: string;
  session: number;
  hostPixels: { width: number; height: number };
  requested: TerminalSize | null;
  rendered: TerminalSize | null;
  operation: string;
  diagnostics: { pty: Record<string, unknown>; provider: Record<string, unknown> };
}

export function terminalResizeStatus(input: ResizeStatusInput): TerminalResizeStatus {
  return {
    hostPixels: input.hostPixels,
    requested: input.requested,
    pty: findSize(input.diagnostics.pty, (session) =>
      session.session === input.session && session.paneId === input.pane),
    recovery: findSize(input.diagnostics.provider, (session) => session.pane === input.pane),
    rendered: input.rendered,
    operation: input.operation,
  };
}

function findSize(
  status: Record<string, unknown>,
  matches: (session: Record<string, unknown>) => boolean,
): TerminalSequencedSize | null {
  const sessions = Array.isArray(status.sessions) ? status.sessions : [];
  const found = sessions.find((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && matches(value as Record<string, unknown>));
  if (!found) return null;
  const cols = Number(found.cols);
  const rows = Number(found.rows);
  const eventSequence = Number(found.eventSequence);
  return Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0
    && Number.isSafeInteger(eventSequence) && eventSequence >= 0
    ? { cols, rows, eventSequence } : null;
}
