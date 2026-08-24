import {
  TERMINAL_ANSI_PALETTE,
  TERMINAL_THEME_CONTRACT,
} from "@soksak/soksak-contract-plugin-terminal";
import { bindTerminalThemeSurface } from "./terminal-theme";

export interface ProviderFrameCell { text: string; fg: string; bg: string; attrs: number; wide: boolean }
export interface ProviderFrame {
  cols: number;
  rows: number;
  cursor: [number, number];
  cursor_visible: boolean;
  alt_active: boolean;
  lines: ProviderFrameCell[][];
}

export interface ProviderFramePresenter {
  root: HTMLElement; screen: HTMLElement; input: HTMLTextAreaElement;
  render(frame: ProviderFrame): void; read(lines?: number): string;
  size(): { cols: number; rows: number };
  measure(): { cols: number; rows: number };
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  focus(): boolean; dispose(): void;
}

type RenderRun = { text: string; fg: string; bg: string; attrs: number; cursor: boolean };

function indexedColor(value: string, bold = false): string {
  if (value === "default") return "";
  if (value.startsWith("#")) return value;
  if (!value.startsWith("palette:")) throw new Error(`invalid terminal color ${value}`);
  let index = Number(value.slice("palette:".length));
  if (!Number.isInteger(index) || index < 0 || index >= TERMINAL_ANSI_PALETTE.length) {
    throw new Error(`invalid terminal palette index ${value}`);
  }
  if (bold && index < 8) index += 8;
  return TERMINAL_ANSI_PALETTE[index];
}

function renderRuns(frame: ProviderFrame, row: number): RenderRun[] {
  const cells = frame.lines[row] ?? [];
  const runs: RenderRun[] = [];
  let column = 0;
  const append = (cell: ProviderFrameCell, cursor: boolean) => {
    const inverse = (cell.attrs & 16) !== 0;
    const fg = inverse ? cell.bg : cell.fg;
    const bg = inverse ? cell.fg : cell.bg;
    const previous = runs.at(-1);
    if (previous && !cursor && !previous.cursor
        && previous.fg === fg && previous.bg === bg && previous.attrs === cell.attrs) {
      previous.text += cell.text;
    } else {
      runs.push({ text: cell.text, fg, bg, attrs: cell.attrs, cursor });
    }
  };
  for (const cell of cells) {
    append(cell, frame.cursor_visible && row === frame.cursor[0] && column === frame.cursor[1]);
    column += cell.wide ? 2 : 1;
  }
  if (frame.cursor_visible && row === frame.cursor[0] && frame.cursor[1] >= column) {
    if (frame.cursor[1] > column) {
      append({ text: " ".repeat(frame.cursor[1] - column), fg: "default", bg: "default", attrs: 0, wide: false }, false);
    }
    append({ text: " ", fg: "default", bg: "default", attrs: 0, wide: false }, true);
  }
  return runs;
}

function applyRun(span: HTMLSpanElement, run: RenderRun): void {
  span.textContent = run.text;
  span.dataset.fg = run.fg;
  span.dataset.bg = run.bg;
  span.dataset.attrs = String(run.attrs);
  if (run.cursor) span.dataset.cursor = "true";
  else delete span.dataset.cursor;
  const bold = (run.attrs & 1) !== 0;
  span.style.color = indexedColor(run.fg, bold) || "var(--fg)";
  span.style.backgroundColor = indexedColor(run.bg) || "var(--card)";
  span.style.fontWeight = run.attrs & 1 ? "700" : "";
  span.style.fontStyle = run.attrs & 4 ? "italic" : "";
  span.style.textDecoration = [run.attrs & 8 ? "underline" : "", run.attrs & 32 ? "line-through" : ""]
    .filter(Boolean).join(" ");
  if (run.attrs & 64) span.style.color = span.style.backgroundColor;
}

function reconcileRows(screen: HTMLElement, frame: ProviderFrame): void {
  const document = screen.ownerDocument;
  while (screen.children.length < frame.rows) {
    const row = document.createElement("div");
    row.dataset.terminalRow = String(screen.children.length);
    screen.append(row);
  }
  while (screen.children.length > frame.rows) screen.lastElementChild?.remove();
  for (let rowIndex = 0; rowIndex < frame.rows; rowIndex += 1) {
    const row = screen.children[rowIndex] as HTMLElement;
    row.dataset.terminalRow = String(rowIndex);
    const runs = renderRuns(frame, rowIndex);
    while (row.children.length < runs.length) row.append(document.createElement("span"));
    while (row.children.length > runs.length) row.lastElementChild?.remove();
    runs.forEach((run, index) => applyRun(row.children[index] as HTMLSpanElement, run));
  }
}

export function createProviderFramePresenter(
  container: HTMLElement,
  send: (text: string) => void,
): ProviderFramePresenter {
  container.dataset.node = "terminal-root";
  const screen = document.createElement("pre");
  screen.dataset.node = "terminal-screen";
  screen.setAttribute("role", "log");
  screen.setAttribute("aria-live", "polite");
  screen.tabIndex = -1;
  Object.assign(screen.style, {
    margin: "0", width: "100%", height: "100%", overflow: "auto", whiteSpace: "pre",
  });
  bindTerminalThemeSurface(screen);
  const input = document.createElement("textarea");
  input.dataset.node = "terminal-input";
  input.dataset.focused = "false";
  input.setAttribute("aria-label", "Terminal input");
  input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
  Object.assign(input.style, { position: "absolute", width: "1px", height: "1px", opacity: "0" });
  let acceptedInputSequence = 0;
  const accept = (value: string) => {
    if (!value) return;
    acceptedInputSequence += 1;
    input.dataset.acceptedInputSequence = String(acceptedInputSequence);
    send(value);
  };
  input.addEventListener("input", () => { accept(input.value); input.value = ""; });
  input.addEventListener("keydown", (event) => {
    const sequences: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: "\t", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
    const sequence = sequences[event.key];
    if (sequence) { event.preventDefault(); accept(sequence); }
  });
  const recovery = document.createElement("span");
  recovery.dataset.node = "terminal-restore-status"; recovery.hidden = true;
  container.replaceChildren(screen, input, recovery);
  let text = "";
  let size = { cols: 0, rows: 0 };
  let cursorVisible = false;
  const textListeners = new Set<(text: string) => void>();
  const updateCursor = () => {
    const focused = document.activeElement === input;
    input.dataset.focused = String(focused);
    screen.dataset.cursorActive = String(cursorVisible && focused);
    const cursor = screen.querySelector<HTMLElement>('[data-cursor="true"]');
    if (!cursor) return;
    const attrs = Number(cursor.dataset.attrs ?? "0");
    cursor.style.color = indexedColor(cursor.dataset.fg ?? "default", (attrs & 1) !== 0) || "var(--fg)";
    cursor.style.backgroundColor = indexedColor(cursor.dataset.bg ?? "default") || "var(--card)";
    cursor.style.outline = cursorVisible && !focused
      ? `1px solid var(${TERMINAL_THEME_CONTRACT.properties.cursor})` : "";
    if (cursorVisible && focused) {
      cursor.style.backgroundColor = `var(${TERMINAL_THEME_CONTRACT.properties.cursor})`;
      cursor.style.color = `var(${TERMINAL_THEME_CONTRACT.properties.cursorAccent})`;
    }
  };
  input.addEventListener("focus", updateCursor);
  input.addEventListener("blur", updateCursor);
  screen.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
  });
  return {
    root: container, screen, input,
    render(frame) {
      size = { cols: frame.cols, rows: frame.rows };
      text = frame.lines.map((line) => line.map((cell) => cell.text).join("").replace(/ +$/, "")).join("\n");
      cursorVisible = frame.cursor_visible;
      reconcileRows(screen, frame);
      screen.dataset.cursorRow = String(frame.cursor[0]);
      screen.dataset.cursorColumn = String(frame.cursor[1]);
      screen.dataset.cursorVisible = String(frame.cursor_visible);
      screen.dataset.altActive = String(frame.alt_active);
      screen.dataset.renderSequence = String(Number(screen.dataset.renderSequence ?? "0") + 1);
      updateCursor();
      for (const listener of textListeners) listener(text);
    },
    read(lines) { return lines && lines > 0 ? text.split("\n").slice(-lines).join("\n") : text; },
    size: () => ({ ...size }),
    measure: () => ({
      cols: Math.max(1, Math.floor(container.clientWidth / 8)),
      rows: Math.max(1, Math.floor(container.clientHeight / 16)),
    }),
    waitForText(contains, timeoutMs) {
      if (text.includes(contains)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          textListeners.delete(onText);
          reject(new Error(`terminal text wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onText = (next: string) => {
          if (!next.includes(contains)) return;
          clearTimeout(timer); textListeners.delete(onText); resolve(next);
        };
        textListeners.add(onText);
      });
    },
    focus() { input.focus({ preventScroll: true }); updateCursor(); return document.activeElement === input; },
    dispose() { container.replaceChildren(); },
  };
}
