import {
  TERMINAL_ANSI_PALETTE,
  TERMINAL_THEME_CONTRACT,
} from "@soksak/soksak-contract-plugin-terminal";
import { terminalNodeId } from "./terminal-presentation-status";
import { bindTerminalThemeSurface } from "./terminal-theme";

export interface ProviderFrameCell { text: string; fg: string; bg: string; attrs: number; wide: boolean }
export interface ProviderFrameRun { text: string; fg: string; bg: string; attrs: number; wide?: boolean; link?: string | null }
export interface ProviderFrameRow { row: number; runs: ProviderFrameRun[] }
interface ProviderFrameHead {
  cols: number;
  rows: number;
  cursor: [number, number];
  cursor_visible: boolean;
  alt_active: boolean;
}
export interface ProviderFrameV1 extends ProviderFrameHead { lines: ProviderFrameCell[][] }
// v2: rows of runs. full replaces every row; otherwise only the listed rows change.
export interface ProviderFrameV2 extends ProviderFrameHead {
  v: 2;
  full: boolean;
  lines: ProviderFrameRow[];
  offset?: number;
  historySize?: number;
}
export type ProviderFrame = ProviderFrameV1 | ProviderFrameV2;

export interface ProviderFramePresenterOptions {
  nodeSuffix?: string | null;
  hostPixels?: () => { width: number; height: number };
  // The rendered box of the probe span. Injected where no layout engine runs.
  probe?: (span: HTMLElement) => { width: number; height: number };
}

export interface ProviderFramePresenter {
  root: HTMLElement; screen: HTMLElement; input: HTMLTextAreaElement;
  render(frame: ProviderFrame): void; read(lines?: number): string;
  size(): { cols: number; rows: number };
  measure(): { cols: number; rows: number };
  metrics(): { cellWidth: number; cellHeight: number } | null;
  selection(): string;
  compose(updates: string[], data: string): number;
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  focus(): boolean; dispose(): void;
}

type RenderRun = ProviderFrameRun & { cursor: boolean };
const PROBE_GLYPHS = 32;
const BLANK: ProviderFrameRun = { text: "", fg: "default", bg: "default", attrs: 0 };

function isRunFrame(frame: ProviderFrame): frame is ProviderFrameV2 {
  return (frame as ProviderFrameV2).v === 2;
}

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

function runsOfCells(cells: ProviderFrameCell[]): ProviderFrameRun[] {
  const runs: ProviderFrameRun[] = [];
  for (const cell of cells) {
    const previous = runs.at(-1);
    if (previous && previous.fg === cell.fg && previous.bg === cell.bg
        && previous.attrs === cell.attrs && Boolean(previous.wide) === cell.wide) {
      previous.text += cell.text;
    } else {
      runs.push({ text: cell.text, fg: cell.fg, bg: cell.bg, attrs: cell.attrs, wide: cell.wide });
    }
  }
  return runs;
}

function withCursor(runs: ProviderFrameRun[], column: number | null): RenderRun[] {
  const out: RenderRun[] = [];
  let at = 0;
  for (const run of runs) {
    const glyphs = Array.from(run.text);
    const per = run.wide ? 2 : 1;
    const span = glyphs.length * per;
    if (column !== null && column >= at && column < at + span) {
      const index = Math.floor((column - at) / per);
      const before = glyphs.slice(0, index).join("");
      const after = glyphs.slice(index + 1).join("");
      if (before) out.push({ ...run, text: before, cursor: false });
      out.push({ ...run, text: glyphs[index], cursor: true });
      if (after) out.push({ ...run, text: after, cursor: false });
    } else {
      out.push({ ...run, cursor: false });
    }
    at += span;
  }
  if (column !== null && column >= at) {
    if (column > at) out.push({ ...BLANK, text: " ".repeat(column - at), cursor: false });
    out.push({ ...BLANK, text: " ", cursor: true });
  }
  return out;
}

function rowText(runs: ProviderFrameRun[]): string {
  return runs.map((run) => run.text).join("").replace(/ +$/, "");
}

function applyRun(span: HTMLSpanElement, run: RenderRun): void {
  const inverse = (run.attrs & 16) !== 0;
  const fg = inverse ? run.bg : run.fg;
  const bg = inverse ? run.fg : run.bg;
  span.textContent = run.text;
  span.dataset.fg = fg;
  span.dataset.bg = bg;
  span.dataset.attrs = String(run.attrs);
  if (run.cursor) span.dataset.cursor = "true";
  else delete span.dataset.cursor;
  if (run.wide) span.dataset.wide = "true";
  else delete span.dataset.wide;
  if (run.link) span.dataset.link = run.link;
  else delete span.dataset.link;
  const bold = (run.attrs & 1) !== 0;
  span.style.color = indexedColor(fg, bold) || "var(--fg)";
  span.style.backgroundColor = indexedColor(bg) || "var(--card)";
  span.style.fontWeight = bold ? "700" : "";
  span.style.fontStyle = run.attrs & 4 ? "italic" : "";
  span.style.textDecoration = [
    run.attrs & 8 || run.link ? "underline" : "",
    run.attrs & 32 ? "line-through" : "",
  ].filter(Boolean).join(" ");
  if (run.attrs & 64) span.style.color = span.style.backgroundColor;
}

function reconcileRow(row: HTMLElement, runs: RenderRun[]): void {
  const document = row.ownerDocument;
  while (row.children.length < runs.length) row.append(document.createElement("span"));
  while (row.children.length > runs.length) row.lastElementChild?.remove();
  runs.forEach((run, index) => applyRun(row.children[index] as HTMLSpanElement, run));
}

export function createProviderFramePresenter(
  container: HTMLElement,
  send: (text: string) => void,
  options: ProviderFramePresenterOptions = {},
): ProviderFramePresenter {
  const suffix = options.nodeSuffix ?? null;
  const document = container.ownerDocument;
  const hostPixels = options.hostPixels ?? (() => ({ width: container.clientWidth, height: container.clientHeight }));
  container.dataset.node = terminalNodeId("terminal-root", suffix);
  // The pane never scrolls: the screen clips to the rows it paints, the remainder below the last
  // row stays inside the screen, and nothing below the screen can pull the pane up.
  Object.assign(container.style, { overflow: "hidden", position: "relative" });
  const screen = document.createElement("pre");
  screen.dataset.node = terminalNodeId("terminal-screen", suffix);
  screen.setAttribute("role", "log");
  screen.setAttribute("aria-live", "polite");
  screen.tabIndex = -1;
  // One fixed row height: rows are counted from it (measure), so rows x line height never exceeds the pane.
  Object.assign(screen.style, {
    margin: "0", width: "100%", height: "100%", overflow: "hidden", whiteSpace: "pre", lineHeight: "16px",
  });
  bindTerminalThemeSurface(screen);
  const input = document.createElement("textarea");
  input.dataset.node = terminalNodeId("terminal-input", suffix);
  input.dataset.focused = "false";
  input.setAttribute("aria-label", "Terminal input");
  input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
  // Anchored at the top-left of the pane: focusing it can never scroll the pane.
  Object.assign(input.style, { position: "absolute", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", margin: "0", padding: "0", border: "0" });
  // The probe shares the screen's element kind and line height, so one glyph box is one cell.
  const probe = document.createElement("pre");
  probe.textContent = "M".repeat(PROBE_GLYPHS);
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute", top: "0", left: "0", margin: "0", display: "inline-block", visibility: "hidden",
    whiteSpace: "pre", lineHeight: screen.style.lineHeight, pointerEvents: "none",
  });
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
  container.replaceChildren(screen, input, probe);
  let rows: ProviderFrameRun[][] = [];
  let text = "";
  let size = { cols: 0, rows: 0 };
  let cursor: [number, number] = [0, 0];
  let cursorVisible = false;
  const textListeners = new Set<(text: string) => void>();
  const updateCursor = () => {
    const focused = document.activeElement === input;
    input.dataset.focused = String(focused);
    screen.dataset.cursorActive = String(cursorVisible && focused);
    const marker = screen.querySelector<HTMLElement>('[data-cursor="true"]');
    if (!marker) return;
    const attrs = Number(marker.dataset.attrs ?? "0");
    marker.style.color = indexedColor(marker.dataset.fg ?? "default", (attrs & 1) !== 0) || "var(--fg)";
    marker.style.backgroundColor = indexedColor(marker.dataset.bg ?? "default") || "var(--card)";
    marker.style.outline = cursorVisible && !focused
      ? `1px solid var(${TERMINAL_THEME_CONTRACT.properties.cursor})` : "";
    if (cursorVisible && focused) {
      marker.style.backgroundColor = `var(${TERMINAL_THEME_CONTRACT.properties.cursor})`;
      marker.style.color = `var(${TERMINAL_THEME_CONTRACT.properties.cursorAccent})`;
    }
  };
  input.addEventListener("focus", updateCursor);
  input.addEventListener("blur", updateCursor);
  screen.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
  });
  const metrics = () => {
    const box = options.probe ? options.probe(probe) : probe.getBoundingClientRect();
    const cellWidth = box.width / PROBE_GLYPHS;
    const cellHeight = box.height;
    return cellWidth > 0 && cellHeight > 0 ? { cellWidth, cellHeight } : null;
  };
  return {
    root: container, screen, input,
    render(frame) {
      const previousCursorRow = cursor[0];
      const dirty = new Set<number>();
      if (isRunFrame(frame)) {
        if (frame.full) {
          rows = Array.from({ length: frame.rows }, () => [] as ProviderFrameRun[]);
          for (let index = 0; index < frame.rows; index += 1) dirty.add(index);
        } else {
          rows = rows.slice(0, frame.rows);
          while (rows.length < frame.rows) { dirty.add(rows.length); rows.push([]); }
        }
        for (const line of frame.lines) {
          if (line.row < 0 || line.row >= frame.rows) continue;
          rows[line.row] = line.runs.map((run) => ({ ...run }));
          dirty.add(line.row);
        }
      } else {
        rows = Array.from({ length: frame.rows }, (_, index) => runsOfCells(frame.lines[index] ?? []));
        for (let index = 0; index < frame.rows; index += 1) dirty.add(index);
      }
      size = { cols: frame.cols, rows: frame.rows };
      cursor = [frame.cursor[0], frame.cursor[1]];
      cursorVisible = frame.cursor_visible;
      dirty.add(previousCursorRow);
      dirty.add(cursor[0]);
      while (screen.children.length < frame.rows) {
        const row = document.createElement("div");
        row.dataset.terminalRow = String(screen.children.length);
        screen.append(row);
      }
      while (screen.children.length > frame.rows) screen.lastElementChild?.remove();
      for (const index of dirty) {
        if (index < 0 || index >= frame.rows) continue;
        const row = screen.children[index] as HTMLElement;
        row.dataset.terminalRow = String(index);
        reconcileRow(row, withCursor(rows[index], cursorVisible && cursor[0] === index ? cursor[1] : null));
      }
      text = rows.map(rowText).join("\n");
      screen.dataset.cursorRow = String(cursor[0]);
      screen.dataset.cursorColumn = String(cursor[1]);
      screen.dataset.cursorVisible = String(frame.cursor_visible);
      screen.dataset.altActive = String(frame.alt_active);
      screen.dataset.renderSequence = String(Number(screen.dataset.renderSequence ?? "0") + 1);
      updateCursor();
      for (const listener of textListeners) listener(text);
    },
    read(lines) { return lines && lines > 0 ? text.split("\n").slice(-lines).join("\n") : text; },
    size: () => ({ ...size }),
    metrics,
    measure() {
      const cell = metrics();
      if (!cell) return { cols: 0, rows: 0 };
      const px = hostPixels();
      return {
        cols: Math.max(1, Math.floor(px.width / cell.cellWidth)),
        rows: Math.max(1, Math.floor(px.height / cell.cellHeight)),
      };
    },
    selection() {
      const selected = document.getSelection();
      if (!selected || selected.rangeCount === 0 || selected.isCollapsed) return "";
      const range = selected.getRangeAt(0);
      return screen.contains(range.commonAncestorContainer) ? selected.toString() : "";
    },
    compose(updates, data) {
      let emitted = 0;
      const fire = (type: string, value: string) => {
        input.dispatchEvent(new CompositionEvent(type, { data: value, bubbles: true }));
        emitted += 1;
      };
      fire("compositionstart", "");
      for (const update of updates) fire("compositionupdate", update);
      fire("compositionend", data);
      if (data) {
        input.value = data;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        emitted += 1;
      }
      return emitted;
    },
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
