// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createProviderFramePresenter, type ProviderFrameRun, type ProviderFrame } from "./provider-frame-presenter";

const run = (text: string, extra: Partial<ProviderFrameRun> = {}): ProviderFrameRun =>
  ({ text, fg: "default", bg: "default", attrs: 0, ...extra });
const runFrame = (rows: Array<[number, ProviderFrameRun[]]>, extra: Partial<ProviderFrame> = {}): ProviderFrame => ({
  full: true, cols: 4, rows: 2, cursor: [0, 0], cursorVisible: false, altActive: false,
  lines: rows.map(([y, runs]) => ({ y, wrapped: false, runs })), ...extra,
});

describe("provider frame presenter", () => {
  it("publishes operable nodes, accessible text, cursor state, and input", () => {
    const root = document.createElement("div"); document.body.append(root);
    const send = vi.fn(); const presenter = createProviderFramePresenter(root, send);
    presenter.render({ cols: 4, rows: 2, cursor: [1, 0], cursorVisible: true, altActive: true, full: true, lines: [
      { y: 0, wrapped: false, runs: [{ text: "A", fg: "default", bg: "default", attrs: 0, n: 1 }] },
      { y: 1, wrapped: false, runs: [{ text: "가", fg: "#ffffff", bg: "default", attrs: 1, n: 2, wide: true }] },
    ] });
    expect(presenter.read()).toBe("A\n가"); expect(presenter.screen.getAttribute("role")).toBe("log");
    expect(presenter.screen.dataset.cursorRow).toBe("1"); expect(presenter.focus()).toBe(true);
    expect(presenter.size()).toEqual({ cols: 4, rows: 2 });
    expect(presenter.screen.querySelector('[data-cursor="true"]')?.textContent).toBe("가");
    // The restore-status notice is the plugin's, not the presenter's.
    expect(root.querySelector('[data-node="terminal-restore-status"]')).toBeNull();
    presenter.input.value = "x"; presenter.input.dispatchEvent(new Event("input")); expect(send).toHaveBeenCalledWith("x");
  });

  it("transfers a stationary screen click to the terminal input owner without blocking selection", () => {
    const root = document.createElement("div"); document.body.append(root);
    const presenter = createProviderFramePresenter(root, vi.fn());
    presenter.render({ cols: 1, rows: 1, cursor: [0, 0], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [] }] });
    const down = new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 4, clientY: 4 });
    const up = new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 4, clientY: 4 });
    expect(presenter.screen.dispatchEvent(down)).toBe(true);
    expect(presenter.screen.dispatchEvent(up)).toBe(true);
    expect(document.activeElement).toBe(presenter.input);
    expect(presenter.input.dataset.focused).toBe("true");
    expect(presenter.screen.dataset.cursorActive).toBe("true");
    presenter.input.blur();
    const cursor = presenter.screen.querySelector<HTMLElement>('[data-cursor="true"]')!;
    expect(presenter.screen.dataset.cursorActive).toBe("false");
    expect(cursor.style.backgroundColor).toBe("var(--card)");
    expect(cursor.style.outline).toContain("var(--soksak-terminal-cursor)");
  });

  it("does not focus the input after a moved pointer selection", () => {
    const root = document.createElement("div"); document.body.append(root);
    const presenter = createProviderFramePresenter(root, vi.fn());
    presenter.render({ cols: 5, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, full: true,
      lines: [{ y: 0, wrapped: false, runs: [{ text: "hello", fg: "default", bg: "default", attrs: 0 }] }] });
    presenter.input.blur();
    const down = new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 });
    const up = new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 20, clientY: 0 });
    presenter.screen.dispatchEvent(down);
    const textNode = presenter.screen.querySelector("div")?.firstChild;
    if (!textNode) throw new Error("missing rendered selection text");
    const range = document.createRange(); range.selectNodeContents(textNode);
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    presenter.screen.dispatchEvent(up);
    expect(document.activeElement).not.toBe(presenter.input);
    expect(presenter.selection()).toBe("hello");
    selection.removeAllRanges();
  });

  it("uses the canonical palette for indexed colors and host tokens for defaults", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    presenter.render({ cols: 3, rows: 1, cursor: [0, 2], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "D", fg: "default", bg: "default", attrs: 0, wide: false },
      { text: "R", fg: "palette:1", bg: "palette:0", attrs: 0, wide: false },
      { text: "W", fg: "palette:15", bg: "default", attrs: 0, wide: false }] }] });
    const spans = Array.from(presenter.screen.querySelectorAll("span"));
    expect(spans[0].style.color).toBe("var(--fg)");
    expect(spans[0].style.backgroundColor).toBe("var(--card)");
    expect(spans[1].style.color).toBe("rgb(204, 0, 0)");
    expect(spans[1].style.backgroundColor).toBe("rgb(46, 52, 54)");
    expect(spans[2].style.color).toBe("rgb(238, 238, 236)");
  });

  it("publishes the cursor and selection roles on the public screen node", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    expect(presenter.screen.style.color).toBe("var(--fg)");
    expect(presenter.screen.style.backgroundColor).toBe("var(--card)");
    expect(presenter.screen.style.getPropertyValue("--soksak-terminal-cursor")).toBe("var(--acc)");
    expect(presenter.screen.style.getPropertyValue("--soksak-terminal-cursor-accent")).toBe("var(--card)");
    expect(presenter.screen.style.getPropertyValue("--soksak-terminal-selection-background")).toBe("var(--fg3)");
    expect(presenter.screen.style.getPropertyValue("--soksak-terminal-ansi-0")).toBe("#2e3436");
    expect(presenter.screen.style.getPropertyValue("--soksak-terminal-ansi-255")).toBe("#eeeeee");
  });

  it("maps bold base foreground colors to the canonical bright palette", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    presenter.render({ cols: 2, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "R", fg: "palette:1", bg: "palette:2", attrs: 0, wide: false },
      { text: "B", fg: "palette:1", bg: "palette:2", attrs: 1, wide: false }] }] });
    const spans = Array.from(presenter.screen.querySelectorAll<HTMLElement>("span"));
    expect(spans[0].style.color).toBe("rgb(204, 0, 0)");
    expect(spans[1].style.color).toBe("rgb(239, 41, 41)");
    expect(spans[1].style.backgroundColor).toBe("rgb(78, 154, 6)");
  });

  it("preserves row and run nodes when the next frame updates their content", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    const first = { cols: 2, rows: 1, cursor: [0, 1] as [number, number], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "A", fg: "default", bg: "default", attrs: 0, wide: false },
      { text: "B", fg: "default", bg: "default", attrs: 0, wide: false }] }] };
    presenter.render(first);
    const row = presenter.screen.firstElementChild;
    const run = row?.firstElementChild;
    presenter.render({ ...first, full: true, lines: [{ y: 0, wrapped: false, runs: [first.lines[0].runs[0], { ...first.lines[0].runs[1], text: "C" }] }] });
    expect(presenter.screen.firstElementChild).toBe(row);
    expect(presenter.screen.firstElementChild?.firstElementChild).toBe(run);
    expect(presenter.read()).toBe("AC");
  });

  it("waits for rendered text without sampling", async () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    const found = presenter.waitForText("ready", 100);
    presenter.render({ cols: 5, rows: 1, cursor: [0, 0], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "ready", fg: "default", bg: "default", attrs: 0, wide: false }] }] });
    await expect(found).resolves.toContain("ready");
  });

  it("measures the requested grid from the probed cell box, independently of the last frame", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "clientWidth", { value: 432 });
    Object.defineProperty(root, "clientHeight", { value: 384 });
    const presenter = createProviderFramePresenter(root, vi.fn(), { probe: () => ({ width: 8 * 32, height: 16 }) });
    presenter.render({ cols: 91, rows: 29, cursor: [0, 0], cursorVisible: true, altActive: false, full: true, lines: [] });
    expect(presenter.size()).toEqual({ cols: 91, rows: 29 });
    expect(presenter.metrics()).toEqual({ cellWidth: 8, cellHeight: 16 });
    expect(presenter.measure()).toEqual({ cols: 54, rows: 24 });
    // No layout engine: the probe box is empty and the grid is unknown rather than invented.
    const unmeasured = createProviderFramePresenter(document.createElement("div"), vi.fn());
    expect(unmeasured.metrics()).toBeNull();
    expect(unmeasured.measure()).toEqual({ cols: 0, rows: 0 });
  });

  it("renders run frames with wide glyphs, links and the cursor split out of a run", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    presenter.render(runFrame([
      [0, [run("ab", { fg: "palette:1" }), run("가", { wide: true }), run("c", { link: "https://example.test" })]],
      [1, [run("x")]],
    ], { cols: 6, cursor: [0, 1], cursorVisible: true }));
    expect(presenter.read()).toBe("ab가c\nx");
    const spans = Array.from(presenter.screen.children[0].querySelectorAll<HTMLElement>("span"));
    expect(spans.map((span) => span.textContent)).toEqual(["a", "b", "가", "c"]);
    expect(spans[1].dataset.cursor).toBe("true");
    expect(spans[1].style.color).toBe("rgb(204, 0, 0)");
    expect(spans[2].dataset.wide).toBe("true");
    expect(spans[3].dataset.link).toBe("https://example.test");
    expect(spans[3].style.textDecoration).toContain("underline");
    presenter.render(runFrame([[0, [run("ab"), run("가", { wide: true }), run("c")]], [1, [run("x")]]], { cols: 6, cursor: [0, 2], cursorVisible: true }));
    expect(presenter.screen.querySelector('[data-cursor="true"]')?.textContent).toBe("가");
  });

  it("replaces only the listed rows of a delta frame and keeps the other row nodes", () => {
    const presenter = createProviderFramePresenter(document.createElement("div"), vi.fn());
    presenter.render(runFrame([[0, [run("ab")]], [1, [run("cd")]]], { cursor: [1, 0] }));
    const first = presenter.screen.children[0] as HTMLElement;
    const firstSpan = first.firstElementChild as HTMLElement;
    firstSpan.textContent = "zz";
    presenter.render(runFrame([[1, [run("xy")]]], { full: false, cursor: [1, 0] }));
    expect(presenter.read()).toBe("ab\nxy");
    expect(presenter.screen.children[0]).toBe(first);
    expect(first.firstElementChild).toBe(firstSpan);
    expect(firstSpan.textContent).toBe("zz");
    expect(presenter.screen.children[1].textContent).toBe("xy");
    presenter.render(runFrame([[0, [run("ab")]], [1, [run("cd")]]], { full: true, cursor: [1, 0] }));
    expect(firstSpan.textContent).toBe("ab");
    presenter.render(runFrame([[2, [run("new")]]], { full: false, rows: 3, cursor: [2, 0] }));
    expect(presenter.read()).toBe("ab\ncd\nnew");
    expect(presenter.screen.children).toHaveLength(3);
  });

  it("suffixes every public node with the pane index and reports selection and composition", () => {
    const root = document.createElement("div"); document.body.append(root);
    const send = vi.fn();
    const presenter = createProviderFramePresenter(root, send, { nodeSuffix: "3" });
    expect(root.dataset.node).toBe("terminal-root/3");
    expect(presenter.screen.dataset.node).toBe("terminal-screen/3");
    expect(presenter.input.dataset.node).toBe("terminal-input/3");
    presenter.render(runFrame([[0, [run("hello")]]], { rows: 1, cols: 5 }));
    const range = document.createRange();
    range.selectNodeContents(presenter.screen.children[0]);
    const selected = document.getSelection()!;
    selected.removeAllRanges(); selected.addRange(range);
    expect(presenter.selection()).toBe("hello");
    selected.removeAllRanges();
    expect(presenter.selection()).toBe("");
    const seen: string[] = [];
    presenter.input.addEventListener("compositionupdate", (event) => seen.push((event as CompositionEvent).data));
    expect(presenter.compose(["ㅎ", "하", "한"], "한")).toBe(6);
    expect(seen).toEqual(["ㅎ", "하", "한"]);
    expect(send).toHaveBeenCalledWith("한");
  });
});

describe("frame presenter layout", () => {
  it("never scrolls: the pane and the screen clip, rows have one fixed height, and the input is anchored at the top-left", () => {
    const root = document.createElement("div");
    document.body.append(root);
    createProviderFramePresenter(root, () => {});
    // Measured 2026-08-26: a 468px pane painted 29 rows of an unfixed line height and hid a 1px
    // input below the screen; focusing the input scrolled the pane by 6px, so the first row was
    // clipped and a blank band stayed at the bottom.
    expect(root.style.overflow).toBe("hidden");
    expect(root.style.position).toBe("relative");
    const screen = root.querySelector<HTMLElement>('[data-node="terminal-screen"]')!;
    expect(screen.style.overflow).toBe("hidden");
    expect(screen.style.lineHeight).toBe("16px");
    const input = root.querySelector<HTMLElement>('[data-node="terminal-input"]')!;
    expect(input.style.position).toBe("absolute");
    expect(input.style.top).toBe("0px");
    expect(input.style.left).toBe("0px");
  });
});

// The frame a presenter renders is the reply the contract declares: camelCase head keys, a line
// addressed by y, and a run that states the cells it covers.
describe("the contract's frame", () => {
  it("renders the reply as the sidecar sends it", () => {
    const root = document.createElement("div"); document.body.append(root);
    const presenter = createProviderFramePresenter(root, vi.fn());
    presenter.render({
      cols: 4, rows: 2, cursor: [1, 0], cursorVisible: true, altActive: true, full: true,
      historySize: 7, offset: 0,
      lines: [
        { y: 0, wrapped: false, runs: [{ text: "A", fg: "default", bg: "default", attrs: 0, n: 1 }] },
        { y: 1, wrapped: true, runs: [{ text: "가", fg: "#ffffff", bg: "default", attrs: 1, n: 2, wide: true }] },
      ],
    } as never);
    expect(presenter.read()).toBe("A\n가");
    expect(presenter.screen.dataset.cursorVisible).toBe("true");
    expect(presenter.screen.dataset.altActive).toBe("true");
    expect(presenter.screen.querySelector('[data-cursor="true"]')?.textContent).toBe("가");
    expect(presenter.size()).toEqual({ cols: 4, rows: 2 });
  });
});
