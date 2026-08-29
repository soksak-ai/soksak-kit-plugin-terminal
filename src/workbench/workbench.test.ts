// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createWorkbench, type WorkbenchPane, type WorkbenchPaneSet } from "./workbench";

interface FakePane extends WorkbenchPane {
  typed(text: string): void;
  hostPixels?(): { width: number; height: number };
}

function fakePane(key: string, request: Parameters<WorkbenchPaneSet["openPane"]>[0]): FakePane {
  const listeners = new Set<(text: string) => void>();
  return {
    key, engineId: request.engineId ?? "vt100", title: request.title ?? null, root: request.root,
    presenter: { focus: vi.fn(() => true), size: () => ({ cols: 80, rows: 24 }), metrics: () => ({ cellWidth: 8, cellHeight: 16 }) },
    requestResize: vi.fn(), sendInput: vi.fn(),
    onInput: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    scroll: vi.fn(async () => ({})),
    cwd: () => request.cwd ?? null,
    typed: (text) => { for (const listener of listeners) listener(text); },
    hostPixels: request.hostPixels,
  };
}

function fakePaneSet(viewId = "tab-a") {
  let next = 1;
  let focusedKey: string | null = null;
  const panes = new Map<string, FakePane>();
  const persisted: Array<Record<string, unknown>> = [];
  let layout: () => Record<string, unknown> = () => ({});
  const set: WorkbenchPaneSet & { openPane: ReturnType<typeof vi.fn>; closePane: ReturnType<typeof vi.fn> } = {
    openPane: vi.fn((request: Parameters<WorkbenchPaneSet["openPane"]>[0]) => {
      const key = request.key ?? `${viewId}.${next}`;
      next = Math.max(next, Number(key.split(".").pop()) + 1);
      const pane = fakePane(key, request);
      panes.set(key, pane);
      focusedKey ??= key;
      set.persist();
      return pane;
    }),
    closePane: vi.fn(async (key: string) => {
      panes.delete(key);
      if (focusedKey === key) focusedKey = panes.keys().next().value ?? null;
      return true;
    }),
    focusPane: (key) => { if (!panes.has(key)) return false; focusedKey = key; return true; },
    focused: () => (focusedKey === null ? undefined : panes.get(focusedKey)),
    get: (key) => panes.get(key),
    list: () => [...panes.values()],
    nextKey: () => `${viewId}.${next}`,
    setTitle: (key, title) => { const pane = panes.get(key); if (!pane) return false; pane.title = title; return true; },
    bindLayout: (getter) => { layout = getter; },
    persist: () => { persisted.push({ version: 1, ...layout(), next }); },
  };
  return { set, panes, persisted };
}

function fixture(restore?: unknown) {
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 800 });
  Object.defineProperty(root, "clientHeight", { value: 400 });
  document.body.append(root);
  const { set, panes, persisted } = fakePaneSet();
  const workbench = createWorkbench(root, set, {
    viewId: "tab-a", restore, createResizeObserver: () => ({ observe() {}, disconnect() {} }),
  });
  const node = (id: string) => root.querySelector<HTMLElement>(`[data-node="${id}"]`);
  const width = (id: string) => parseFloat(node(id)!.style.width);
  const pointer = (id: string, type: string, x: number, y = 100) =>
    node(id)!.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
  return { root, set, panes, persisted, workbench, node, width, pointer };
}

describe("workbench", () => {
  it("remeasures after a zero-sized pre-insertion layout on the first frame", () => {
    let width = 0;
    let height = 0;
    let frame!: FrameRequestCallback;
    const previous = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    };
    try {
      const root = document.createElement("div");
      Object.defineProperty(root, "clientWidth", { get: () => width });
      Object.defineProperty(root, "clientHeight", { get: () => height });
      document.body.append(root);
      const { set, panes } = fakePaneSet("tab-frame");
      createWorkbench(root, set, {
        viewId: "tab-frame", createResizeObserver: () => ({ observe() {}, disconnect() {} }),
      });
      expect(panes.get("tab-frame.1")!.hostPixels!()).toEqual({ width: 0, height: 0 });
      width = 800; height = 400;
      frame(0);
      expect(panes.get("tab-frame.1")!.hostPixels!()).toEqual({ width: 800, height: 400 });
    } finally {
      globalThis.requestAnimationFrame = previous;
    }
  });

  it("uses the displayed bounding box when WebKit reports zero client dimensions", () => {
    const root = document.createElement("div");
    Object.defineProperty(root, "clientWidth", { value: 0 });
    Object.defineProperty(root, "clientHeight", { value: 0 });
    root.getBoundingClientRect = () => ({ width: 800, height: 400 } as DOMRect);
    document.body.append(root);
    const { set, panes } = fakePaneSet("tab-rect");
    createWorkbench(root, set, {
      viewId: "tab-rect", createResizeObserver: () => ({ observe() {}, disconnect() {} }),
    });
    expect(panes.get("tab-rect.1")!.hostPixels!()).toEqual({ width: 800, height: 400 });
  });

  it("splits into a second pane node whose width plus the gutter completes the root", () => {
    const { set, workbench, node, width } = fixture();
    expect(node("pane/1")).not.toBeNull();
    expect(width("pane/1")).toBe(800);
    const opened = workbench.split("right");
    expect(opened?.key).toBe("tab-a.2");
    expect(set.openPane).toHaveBeenCalledTimes(2);
    expect(node("pane/2")).not.toBeNull();
    expect(width("pane/1") + width("pane/2") + width("gutter/1/right")).toBe(800);
    expect(node("gutter/1/right")!.dataset.side).toBe("right");
    expect(workbench.list().map((pane) => pane.key)).toEqual(["tab-a.1", "tab-a.2"]);
    workbench.split("down");
    expect(node("pane/3")).not.toBeNull();
    expect(node("gutter/2/bottom")).not.toBeNull();
    expect(parseFloat(node("pane/2")!.style.height) + parseFloat(node("pane/3")!.style.height) + 4).toBe(400);
  });

  it("moves data-focused with direction and cycle navigation", () => {
    const { workbench, node, set } = fixture();
    workbench.split("right");
    expect(node("pane/2")!.dataset.focused).toBe("true");
    expect(node("pane/1")!.dataset.focused).toBe("false");
    expect(workbench.focusDirection("left")).toBe("tab-a.1");
    expect(node("pane/1")!.dataset.focused).toBe("true");
    expect(node("pane/2")!.dataset.focused).toBe("false");
    expect(set.focused()?.key).toBe("tab-a.1");
    expect(workbench.focusDirection("left")).toBeNull();
    expect(workbench.focusCycle(1)).toBe("tab-a.2");
    expect(workbench.focusCycle(1)).toBe("tab-a.1");
    expect(workbench.focusCycle(-1)).toBe("tab-a.2");
    expect(node("pane/2")!.dataset.focused).toBe("true");
    node("pane/1")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(node("pane/1")!.dataset.focused).toBe("true");
  });

  it("drags a gutter by the pointer delta", () => {
    const { workbench, width, pointer } = fixture();
    workbench.split("right");
    expect([width("pane/1"), width("pane/2")]).toEqual([398, 398]);
    pointer("gutter/1/right", "pointerdown", 400);
    pointer("gutter/1/right", "pointermove", 500);
    expect([width("pane/1"), width("pane/2")]).toEqual([498, 298]);
    pointer("gutter/1/right", "pointermove", 450);
    pointer("gutter/1/right", "pointerup", 450);
    expect([width("pane/1"), width("pane/2")]).toEqual([448, 348]);
    expect(workbench.resize("tab-a.1", "right", -48)).toBe(true);
    expect([width("pane/1"), width("pane/2")]).toEqual([400, 396]);
    expect(workbench.resizeCells("tab-a.2", "right", 1)).toBe(false);
    expect(workbench.resizeCells("tab-a.1", "right", 5)).toBe(true);
    expect(width("pane/1")).toBe(440);
  });

  it("equalizes on a gutter double-click", () => {
    const { workbench, width, node, pointer } = fixture();
    workbench.split("right");
    pointer("gutter/1/right", "pointerdown", 400);
    pointer("gutter/1/right", "pointermove", 600);
    pointer("gutter/1/right", "pointerup", 600);
    expect(width("pane/1")).toBe(598);
    node("gutter/1/right")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect([width("pane/1"), width("pane/2")]).toEqual([398, 398]);
  });

  it("maximizes one pane and hides the others without resizing them", () => {
    const { workbench, node, width, panes } = fixture();
    workbench.split("right");
    const first = panes.get("tab-a.1")!;
    (first.requestResize as ReturnType<typeof vi.fn>).mockClear();
    expect(workbench.maximize("tab-a.2")).toBe("tab-a.2");
    expect(node("pane/1")!.hidden).toBe(true);
    expect(node("pane/2")!.hidden).toBe(false);
    expect(width("pane/2")).toBe(800);
    expect(node("gutter/1/right")).toBeNull();
    expect(first.requestResize).not.toHaveBeenCalled();
    expect(workbench.resize("tab-a.2", "right", 10)).toBe(false);
    expect(workbench.toggleMaximize()).toBeNull();
    expect(node("pane/1")!.hidden).toBe(false);
    expect(width("pane/2")).toBe(398);
    expect(workbench.maximize("missing")).toBeNull();
  });

  it("dims the pane that lost focus", () => {
    const { workbench, node } = fixture();
    expect(node("pane/1")!.style.opacity).toBe("1");
    workbench.split("right");
    expect(node("pane/1")!.style.opacity).toBe("0.7");
    expect(node("pane/2")!.style.opacity).toBe("1");
    workbench.focus("tab-a.1");
    expect(node("pane/1")!.style.opacity).toBe("1");
    expect(node("pane/2")!.style.opacity).toBe("0.7");
  });

  it("passes the close intent with one pane and handles it with two", () => {
    const { workbench, node, set } = fixture();
    expect(workbench.closeIntent()).toBe("pass");
    expect(node("pane/1")).not.toBeNull();
    workbench.split("right");
    expect(workbench.closeIntent()).toBe("handled");
    expect(node("pane/2")).toBeNull();
    expect(set.closePane).toHaveBeenCalledWith("tab-a.2");
    expect(node("pane/1")!.dataset.focused).toBe("true");
    expect(parseFloat(node("pane/1")!.style.width)).toBe(800);
    expect(workbench.close("tab-a.1")).toEqual({ closed: false, focused: "tab-a.1" });
    expect(workbench.closeIntent()).toBe("pass");
  });

  it("restores the saved tree, panes, focus and broadcast", () => {
    const { workbench, node, set, width } = fixture({
      version: 1,
      tree: { t: "s", id: "s1", dir: "row", sizes: [0.25, 0.75], children: [{ t: "l", v: "tab-a.1" }, { t: "l", v: "tab-a.3" }] },
      focused: "tab-a.3", maximized: null, broadcast: true, next: 4,
      panes: [
        { key: "tab-a.1", engineId: "vt100", title: "one", cwd: "/a" },
        { key: "tab-a.3", engineId: "vt220", title: null, cwd: null },
      ],
    });
    expect(set.openPane).toHaveBeenCalledTimes(2);
    expect(set.openPane.mock.calls[0][0]).toMatchObject({ key: "tab-a.1", engineId: "vt100", cwd: "/a", title: "one" });
    expect(set.openPane.mock.calls[1][0]).toMatchObject({ key: "tab-a.3", engineId: "vt220" });
    expect(node("pane/3")!.dataset.focused).toBe("true");
    expect([width("pane/1"), width("pane/3")]).toEqual([199, 597]);
    expect(workbench.isBroadcast()).toBe(true);
    expect(workbench.split("right")?.key).toBe("tab-a.4");
    expect(workbench.restoreState()).toMatchObject({ focused: "tab-a.4", broadcast: true, maximized: null });
    const fresh = fixture({ version: 1, tree: { t: "l", v: "tab-b.1" }, focused: "tab-b.1", maximized: null, broadcast: false, next: 2, panes: [{ key: "tab-b.1", engineId: "vt100" }] });
    expect(fresh.node("pane/1")).not.toBeNull();
    expect(fresh.set.openPane.mock.calls[0][0]).toMatchObject({ key: "tab-a.1" });
  });

  it("broadcasts the focused pane's input to every other pane", () => {
    const { workbench, panes } = fixture();
    workbench.split("right");
    workbench.split("down");
    const [one, two, three] = ["tab-a.1", "tab-a.2", "tab-a.3"].map((key) => panes.get(key)!);
    three.typed("no");
    expect(one.sendInput).not.toHaveBeenCalled();
    expect(workbench.broadcast(true)).toBe(true);
    three.typed("ls");
    expect(one.sendInput).toHaveBeenCalledWith("ls");
    expect(two.sendInput).toHaveBeenCalledWith("ls");
    expect(three.sendInput).not.toHaveBeenCalled();
    one.typed("x");
    expect(two.sendInput).toHaveBeenCalledTimes(1);
    workbench.broadcast(false);
    three.typed("y");
    expect(one.sendInput).toHaveBeenCalledTimes(1);
  });

  it("sends the PTY resize only on pointer up", () => {
    const { workbench, panes, pointer } = fixture();
    workbench.split("right");
    const one = panes.get("tab-a.1")!.requestResize as ReturnType<typeof vi.fn>;
    const two = panes.get("tab-a.2")!.requestResize as ReturnType<typeof vi.fn>;
    one.mockClear(); two.mockClear();
    pointer("gutter/1/right", "pointerdown", 400);
    pointer("gutter/1/right", "pointermove", 450);
    pointer("gutter/1/right", "pointermove", 500);
    expect(one).not.toHaveBeenCalled();
    expect(two).not.toHaveBeenCalled();
    pointer("gutter/1/right", "pointerup", 500);
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    expect(panes.get("tab-a.1")!.hostPixels!()).toEqual({ width: 498, height: 400 });
  });

  // What the commands answer, the nodes state. A caller that drives the view through the exposed
  // DOM reads the same split state the commands report.
  it("states the split state on the root and on every pane node", () => {
    const { root, workbench, node } = fixture();
    expect(root.dataset.node).toBe("terminal-root");
    expect(root.dataset.paneCount).toBe("1");
    expect(root.dataset.focusedPane).toBe("tab-a.1");
    expect(root.dataset.maximized).toBe("");
    expect(root.dataset.broadcast).toBe("false");

    const second = workbench.split("right")!.key;
    expect(root.dataset.paneCount).toBe("2");
    expect(root.dataset.focusedPane).toBe(second);
    expect(node("pane/2")!.dataset.maximized).toBe("false");

    workbench.toggleMaximize();
    expect(root.dataset.maximized).toBe(second);
    expect(node("pane/2")!.dataset.maximized).toBe("true");
    expect(node("pane/1")!.dataset.maximized).toBe("false");

    workbench.broadcast(true);
    expect(root.dataset.broadcast).toBe("true");
  });

  // A pane the layout hides is a pane nothing has to be painted for, and it is told so.
  it("tells a hidden pane it is not shown, and tells it again when it is", () => {
    const { workbench, panes } = fixture();
    workbench.split("right");
    // Splitting moves focus to the new pane, so maximizing hides the one it came from.
    const hidden = panes.get("tab-a.1")!;
    const shown: boolean[] = [];
    (hidden as { setIntrinsicVisible?: (value: boolean) => void }).setIntrinsicVisible = (value: boolean) => { shown.push(value); };
    workbench.toggleMaximize();
    expect(shown.at(-1)).toBe(false);
    workbench.toggleMaximize();
    expect(shown.at(-1)).toBe(true);
  });
});
