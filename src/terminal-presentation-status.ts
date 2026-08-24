import type { TerminalPresentationStatus } from "@soksak/soksak-contract-plugin-terminal";

let nextMountSequence = 0;

export interface TerminalPresentationStatusController {
  markReady(): void;
  markRendered(durationMs: number): void;
  markInputAccepted(): void;
  markPtyWrite(): void;
  current(): TerminalPresentationStatus;
}

export function createTerminalPresentationStatus(
  root: HTMLElement,
  delivery: TerminalPresentationStatus["delivery"],
  now: () => number = Date.now,
): TerminalPresentationStatusController {
  const mountedAtUnixMs = now();
  const mountSequence = ++nextMountSequence;
  let readySequence: number | null = null;
  let renderSequence = 0;
  let acceptedInputSequence = 0;
  let ptyWriteSequence = 0;
  let firstVisibleFrameAtUnixMs: number | null = null;
  let firstFocusableInputAtUnixMs: number | null = null;
  let lastRenderedAtUnixMs: number | null = null;
  let lastInputAtUnixMs: number | null = null;
  let lastPtyWriteAtUnixMs: number | null = null;
  let lastRenderDurationMs: number | null = null;
  let maxRenderDurationMs: number | null = null;
  let lastInputToPtyWriteMs: number | null = null;

  const current = (): TerminalPresentationStatus => {
    const input = root.querySelector<HTMLElement>('[data-node="terminal-input"]');
    const screen = root.querySelector<HTMLElement>('[data-node="terminal-screen"]');
    if (input && firstFocusableInputAtUnixMs === null) firstFocusableInputAtUnixMs = now();
    const cursorRow = screen?.dataset.cursorRow;
    const cursorColumn = screen?.dataset.cursorColumn;
    return {
      delivery,
      mountSequence,
      readySequence,
      renderSequence,
      acceptedInputSequence,
      ptyWriteSequence,
      focusedInput: input != null && input.ownerDocument.activeElement === input,
      cursorVisible: screen?.dataset.cursorVisible === "true",
      cursorActive: screen?.dataset.cursorActive === "true",
      cursorRow: cursorRow === undefined ? null : Number(cursorRow),
      cursorColumn: cursorColumn === undefined ? null : Number(cursorColumn),
      mountedAtUnixMs,
      firstVisibleFrameAtUnixMs,
      firstFocusableInputAtUnixMs,
      lastRenderedAtUnixMs,
      lastInputAtUnixMs,
      lastPtyWriteAtUnixMs,
      lastRenderDurationMs,
      maxRenderDurationMs,
      lastInputToPtyWriteMs,
    };
  };
  return {
    markReady() { readySequence = readySequence ?? 1; },
    markRendered(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error("terminal render duration must be a finite non-negative number");
      }
      renderSequence += 1;
      lastRenderDurationMs = durationMs;
      maxRenderDurationMs = Math.max(maxRenderDurationMs ?? 0, durationMs);
      lastRenderedAtUnixMs = now();
      firstVisibleFrameAtUnixMs ??= lastRenderedAtUnixMs;
    },
    markInputAccepted() {
      acceptedInputSequence += 1;
      lastInputAtUnixMs = now();
    },
    markPtyWrite() {
      ptyWriteSequence += 1;
      lastPtyWriteAtUnixMs = now();
      lastInputToPtyWriteMs = lastInputAtUnixMs === null
        ? null
        : Math.max(0, lastPtyWriteAtUnixMs - lastInputAtUnixMs);
    },
    current,
  };
}

export function closedTerminalPresentation(
  delivery: TerminalPresentationStatus["delivery"],
): TerminalPresentationStatus {
  return {
    delivery,
    mountSequence: 0,
    readySequence: null,
    renderSequence: 0,
    acceptedInputSequence: 0,
    ptyWriteSequence: 0,
    focusedInput: false,
    cursorVisible: false,
    cursorActive: false,
    cursorRow: null,
    cursorColumn: null,
    mountedAtUnixMs: 0,
    firstVisibleFrameAtUnixMs: null,
    firstFocusableInputAtUnixMs: null,
    lastRenderedAtUnixMs: null,
    lastInputAtUnixMs: null,
    lastPtyWriteAtUnixMs: null,
    lastRenderDurationMs: null,
    maxRenderDurationMs: null,
    lastInputToPtyWriteMs: null,
  };
}
