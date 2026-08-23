import type {
  TerminalRecoveryObservation, TerminalRenderedObservation, TerminalResizeStatus,
  TerminalSize, TerminalSourceObservation,
} from "@soksak/soksak-contract-plugin-terminal";

interface ResizeStatusInput {
  pane: string;
  session: number;
  hostPixels: { width: number; height: number };
  requested: TerminalSize | null;
  rendered: TerminalSize | null;
  renderedOutputSequence: number | null;
  operation: string;
  diagnostics: { pty: Record<string, unknown>; recovery: Record<string, unknown> };
}

export function terminalResizeStatus(input: ResizeStatusInput): TerminalResizeStatus {
  return {
    hostPixels: input.hostPixels,
    requested: input.requested,
    pty: findPty(input.diagnostics.pty, (session) =>
      session.session === input.session && session.paneId === input.pane),
    recovery: findRecovery(input.diagnostics.recovery, (session) => session.pane === input.pane),
    rendered: rendered(input.rendered, input.renderedOutputSequence),
    operation: input.operation,
  };
}

function findSession(
  status: Record<string, unknown>,
  matches: (session: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  const sessions = Array.isArray(status.sessions) ? status.sessions : [];
  return sessions.find((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && matches(value as Record<string, unknown>)) ?? null;
}

function coordinates(found: Record<string, unknown> | null): TerminalSourceObservation | null {
  if (!found) return null;
  const cols = Number(found.cols);
  const rows = Number(found.rows);
  const eventSequence = Number(found.eventSequence);
  const outputSequence = Number(found.outputSequence);
  return Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0
    && Number.isSafeInteger(eventSequence) && eventSequence >= 0
    && Number.isSafeInteger(outputSequence) && outputSequence >= 0
    ? { cols, rows, eventSequence, outputSequence } : null;
}

function findPty(
  status: Record<string, unknown>, matches: (session: Record<string, unknown>) => boolean,
): TerminalSourceObservation | null {
  const found = findSession(status, matches);
  return coordinates(found ? { ...found, outputSequence: found.written } : null);
}

function findRecovery(
  status: Record<string, unknown>, matches: (session: Record<string, unknown>) => boolean,
): TerminalRecoveryObservation | null {
  const found = findSession(status, matches);
  const source = coordinates(found);
  const gaps = Number(found?.gaps);
  return source && Number.isSafeInteger(gaps) && gaps >= 0 ? { ...source, gaps } : null;
}

function rendered(size: TerminalSize | null, outputSequence: number | null): TerminalRenderedObservation | null {
  return size && Number.isSafeInteger(outputSequence) && Number(outputSequence) >= 0
    ? { ...size, outputSequence: Number(outputSequence) } : null;
}
