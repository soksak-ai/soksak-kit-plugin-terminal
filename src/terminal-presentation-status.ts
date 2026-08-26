import type {
  TerminalPresentationStatus,
  TerminalPresentationTheme,
} from "@soksak/soksak-contract-plugin-terminal";

let nextMountSequence = 0;

// Instance nodes are "<id>/<k>"; a bare pane keeps the bare id.
export function terminalNodeId(node: string, suffix: string | null): string {
  return suffix === null ? node : `${node}/${suffix}`;
}

export function terminalNode(root: ParentNode, node: string, suffix: string | null): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-node="${terminalNodeId(node, suffix)}"]`)
    ?? (suffix === null ? null : root.querySelector<HTMLElement>(`[data-node="${node}"]`));
}

export interface TerminalPresentationStatusController {
  markReady(): void;
  markRendered(durationMs: number): void;
  markFocused(focused: boolean): void;
  markInputAccepted(): void;
  markPtyWrite(): void;
  current(): TerminalPresentationStatus;
}

export function createTerminalPresentationStatus(
  root: HTMLElement,
  delivery: TerminalPresentationStatus["delivery"],
  theme: () => TerminalPresentationTheme,
  now: () => number = Date.now,
  nodeSuffix: string | null = null,
): TerminalPresentationStatusController {
  const mountedAtUnixMs = now();
  const mountSequence = ++nextMountSequence;
  let readySequence: number | null = null;
  let renderSequence = 0;
  let focusSequence = 0;
  let acceptedInputSequence = 0;
  let ptyWriteSequence = 0;
  let firstVisibleFrameAtUnixMs: number | null = null;
  let firstFocusableInputAtUnixMs: number | null = null;
  let lastRenderedAtUnixMs: number | null = null;
  let lastFocusedAtUnixMs: number | null = null;
  let lastInputAtUnixMs: number | null = null;
  let lastPtyWriteAtUnixMs: number | null = null;
  let lastRenderDurationMs: number | null = null;
  let maxRenderDurationMs: number | null = null;
  let lastInputToPtyWriteMs: number | null = null;

  const current = (): TerminalPresentationStatus => {
    const input = terminalNode(root, "terminal-input", nodeSuffix);
    const screen = terminalNode(root, "terminal-screen", nodeSuffix);
    if (input && firstFocusableInputAtUnixMs === null) firstFocusableInputAtUnixMs = now();
    const cursorRow = screen?.dataset.cursorRow;
    const cursorColumn = screen?.dataset.cursorColumn;
    return {
      delivery,
      mountSequence,
      readySequence,
      renderSequence,
      focusSequence,
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
      lastFocusedAtUnixMs,
      lastInputAtUnixMs,
      lastPtyWriteAtUnixMs,
      lastRenderDurationMs,
      maxRenderDurationMs,
      lastInputToPtyWriteMs,
      theme: theme(),
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
    markFocused(focused) {
      if (!focused) return;
      focusSequence += 1;
      lastFocusedAtUnixMs = now();
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
  theme: TerminalPresentationTheme,
): TerminalPresentationStatus {
  return {
    delivery,
    mountSequence: 0,
    readySequence: null,
    renderSequence: 0,
    focusSequence: 0,
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
    lastFocusedAtUnixMs: null,
    lastInputAtUnixMs: null,
    lastPtyWriteAtUnixMs: null,
    lastRenderDurationMs: null,
    maxRenderDurationMs: null,
    lastInputToPtyWriteMs: null,
    theme,
  };
}
