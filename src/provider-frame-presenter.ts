export interface ProviderFrameCell { text: string; fg: string; bg: string; attrs: number; wide: boolean }
export interface ProviderFrame { cols: number; rows: number; cursor: [number, number]; alt_active: boolean; lines: ProviderFrameCell[][] }

export interface ProviderFramePresenter {
  root: HTMLElement; screen: HTMLElement; input: HTMLTextAreaElement;
  render(frame: ProviderFrame): void; read(lines?: number): string;
  size(): { cols: number; rows: number };
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  focus(): boolean; dispose(): void;
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
  Object.assign(screen.style, { margin: "0", width: "100%", height: "100%", overflow: "auto", whiteSpace: "pre" });
  const input = document.createElement("textarea");
  input.dataset.node = "terminal-input";
  input.setAttribute("aria-label", "Terminal input");
  input.autocapitalize = "off"; input.autocomplete = "off"; input.spellcheck = false;
  Object.assign(input.style, { position: "absolute", width: "1px", height: "1px", opacity: "0" });
  input.addEventListener("input", () => { if (input.value) send(input.value); input.value = ""; });
  input.addEventListener("keydown", (event) => {
    const sequences: Record<string, string> = { Enter: "\r", Backspace: "\x7f", Tab: "\t", ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D" };
    const sequence = sequences[event.key];
    if (sequence) { event.preventDefault(); send(sequence); }
  });
  const recovery = document.createElement("span");
  recovery.dataset.node = "terminal-restore-status"; recovery.hidden = true;
  container.replaceChildren(screen, input, recovery);
  let text = "";
  let size = { cols: 0, rows: 0 };
  const textListeners = new Set<(text: string) => void>();
  return {
    root: container, screen, input,
    render(frame) {
      size = { cols: frame.cols, rows: frame.rows };
      text = frame.lines.map((line) => line.map((cell) => cell.text).join("").replace(/ +$/, "")).join("\n");
      screen.replaceChildren();
      frame.lines.forEach((line, row) => {
        let column = 0;
        for (const cell of line) {
          const span = document.createElement("span"); span.textContent = cell.text;
          span.dataset.fg = cell.fg; span.dataset.bg = cell.bg; span.dataset.attrs = String(cell.attrs);
          if (cell.fg.startsWith("#")) span.style.color = cell.fg;
          if (cell.bg.startsWith("#")) span.style.backgroundColor = cell.bg;
          if (cell.attrs & 1) span.style.fontWeight = "700";
          if (cell.attrs & 4) span.style.fontStyle = "italic";
          if (cell.attrs & 8) span.style.textDecoration = "underline";
          if (row === frame.cursor[0] && column === frame.cursor[1]) {
            span.dataset.cursor = "true"; span.style.outline = "1px solid currentColor";
          }
          screen.append(span);
          column += cell.wide ? 2 : 1;
        }
        if (row + 1 < frame.lines.length) screen.append(document.createTextNode("\n"));
      });
      screen.dataset.cursorRow = String(frame.cursor[0]);
      screen.dataset.cursorColumn = String(frame.cursor[1]);
      screen.dataset.altActive = String(frame.alt_active);
      for (const listener of textListeners) listener(text);
    },
    read(lines) { return lines && lines > 0 ? text.split("\n").slice(-lines).join("\n") : text; },
    size: () => ({ ...size }),
    waitForText(contains, timeoutMs) {
      if (text.includes(contains)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          textListeners.delete(onText);
          reject(new Error(`terminal text wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onText = (next: string) => {
          if (!next.includes(contains)) return;
          clearTimeout(timer);
          textListeners.delete(onText);
          resolve(next);
        };
        textListeners.add(onText);
      });
    },
    focus() { input.focus({ preventScroll: true }); return document.activeElement === input; },
    dispose() { container.replaceChildren(); },
  };
}
