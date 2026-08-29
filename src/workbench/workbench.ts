import { parsePaneKey } from "@soksak/soksak-contract-plugin-terminal";
import { observeTerminalLayout, type TerminalLayoutEvents } from "../terminal-layout-observer";
import { terminalNodeId } from "../terminal-presentation-status";
import { matchKey, type WorkbenchAction } from "./keymap";
import { parseRestoreState } from "./restore-state";
import {
  applyGutterDelta, computeSplitLayoutPx, equalizeSplitTree, neighborOf, resolveGutter,
  type GutterLayout, type GutterSide, type LayoutRect, type PaneDirection, type PaneLayout, type SplitBoxLayout,
} from "./split-layout";
import {
  deserializeSplitTree, insertBeside, leavesOf, removeLeaf, serializeSplitTree,
  type SerializedSplitTree, type SplitTree,
} from "./split-tree";

export interface WorkbenchPane {
  readonly key: string;
  readonly engineId: string;
  title: string | null;
  readonly root: HTMLElement;
  readonly presenter: {
    focus(): boolean;
    size(): { cols: number; rows: number };
    metrics?(): { cellWidth: number; cellHeight: number } | null;
  };
  requestResize(): void;
  // A pane the layout hides is not painted for; it is told when that changes.
  setIntrinsicVisible?(visible: boolean): void;
  sendInput(text: string): void;
  onInput(listener: (text: string) => void): { dispose(): void };
  scroll(request: { offset?: number; lines?: number; edge?: "top" | "bottom" }): Promise<unknown>;
  cwd(): string | null;
}

export interface WorkbenchPaneSet {
  openPane(request: {
    key?: string; engineId?: string; root: HTMLElement; cwd?: string | null; title?: string | null;
    hostPixels?(): { width: number; height: number };
  }): WorkbenchPane;
  closePane(key: string): Promise<boolean>;
  focusPane(key: string): boolean;
  focused(): WorkbenchPane | undefined;
  get(key: string): WorkbenchPane | undefined;
  list(): WorkbenchPane[];
  nextKey(): string;
  setTitle(key: string, title: string | null): boolean;
  bindLayout(layout: () => Record<string, unknown>): void;
  persist(): void;
}

export interface WorkbenchOptions {
  viewId: string;
  // context.restore.state and context.restore.cwd of the mount.
  restore?: unknown;
  restoreCwd?: string | null;
  // "single": one bare pane keyed by the view id, no splitting.
  layout?: "single" | "workbench";
  events?: TerminalLayoutEvents;
  gutterPx?: number;
  resizeStepPx?: number;
  createResizeObserver?: (callback: ResizeObserverCallback) => Pick<ResizeObserver, "observe" | "disconnect">;
}

export interface WorkbenchLayoutState {
  tree: SerializedSplitTree;
  focused: string | null;
  maximized: string | null;
  broadcast: boolean;
}

export interface Workbench {
  root: HTMLElement;
  list(): WorkbenchPane[];
  focused(): WorkbenchPane | undefined;
  focus(key: string, toInput?: boolean): boolean;
  focusDirection(dir: PaneDirection): string | null;
  focusCycle(delta: 1 | -1): string | null;
  split(direction: "right" | "down", request?: { engineId?: string; cwd?: string | null }): WorkbenchPane | null;
  close(key?: string): { closed: boolean; focused: string | null };
  closeIntent(): "handled" | "pass";
  resize(key: string, side: GutterSide, px: number): boolean;
  resizeCells(key: string, side: GutterSide, cells: number): boolean;
  equalize(): boolean;
  maximize(key: string | null): string | null;
  toggleMaximize(): string | null;
  maximized(): string | null;
  broadcast(on: boolean): boolean;
  isBroadcast(): boolean;
  setTitle(key: string, title: string | null): boolean;
  layout(): void;
  restoreState(): WorkbenchLayoutState;
  dispose(): void;
}

interface MountedPane {
  wrapper: HTMLElement;
  pane: WorkbenchPane;
  dispose(): void;
}

interface Drag {
  node: HTMLElement;
  splitId: string;
  index: number;
  dir: "row" | "col";
  spanPx: number;
  startTree: SplitTree<string>;
  startX: number;
  startY: number;
}

const place = (element: HTMLElement, rect: LayoutRect) => {
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
};

export function createWorkbench(root: HTMLElement, paneSet: WorkbenchPaneSet, options: WorkbenchOptions): Workbench {
  const document = root.ownerDocument;
  const gutterPx = options.gutterPx ?? 4;
  const stepPx = options.resizeStepPx ?? 40;
  const single = options.layout === "single";
  if (!root.style.position) root.style.position = "relative";
  root.style.overflow = "hidden";
  const mounted = new Map<string, MountedPane>();
  const gutterNodes = new Map<string, HTMLElement>();
  const rects = new Map<string, LayoutRect>();
  // Sizes the panes were last told about; a drag in progress does not update them.
  const notified = new Map<string, { width: number; height: number }>();
  let currentPanes: PaneLayout[] = [];
  let currentSplits: SplitBoxLayout[] = [];
  let tree: SplitTree<string> = { type: "leaf", value: options.viewId };
  let focusedKey: string | null = null;
  let maximizedKey: string | null = null;
  let broadcastOn = false;
  let disposed = false;
  let drag: Drag | null = null;

  const suffixOf = (key: string): string | null => (key === options.viewId ? null : String(parsePaneKey(key)?.k ?? key));
  const persist = () => paneSet.persist();
  const restoreState = (): WorkbenchLayoutState => ({
    tree: serializeSplitTree(tree), focused: focusedKey, maximized: maximizedKey, broadcast: broadcastOn,
  });
  paneSet.bindLayout(() => ({ ...restoreState() }));
  const focusedPane = () => (focusedKey === null ? undefined : mounted.get(focusedKey)?.pane);
  // The nodes state what the commands answer: how many panes there are, which one has focus, which
  // one is maximized, and whether input reaches them all. The view's own node carries the view's
  // state; each pane's root carries that pane's, under its suffix.
  const publishState = () => {
    root.dataset.node = "terminal-root";
    root.dataset.paneCount = String(mounted.size);
    root.dataset.focusedPane = focusedKey ?? "";
    root.dataset.maximized = maximizedKey ?? "";
    root.dataset.broadcast = String(broadcastOn);
    for (const [key, item] of mounted) item.wrapper.dataset.maximized = String(key === maximizedKey);
  };
  const applyFocusStyle = () => {
    for (const [key, item] of mounted) {
      const focused = key === focusedKey;
      item.wrapper.dataset.focused = String(focused);
      item.wrapper.style.opacity = focused ? "1" : "0.7";
    }
    publishState();
  };

  const createGutter = (id: string): HTMLElement => {
    const node = document.createElement("div");
    node.dataset.node = id;
    Object.assign(node.style, {
      position: "absolute", zIndex: "2", touchAction: "none", background: "var(--fg3)", opacity: "0.4",
    });
    node.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const splitId = node.dataset.splitId ?? "";
      const split = currentSplits.find((item) => item.id === splitId);
      if (!split) return;
      drag = {
        node, splitId, index: Number(node.dataset.index), dir: split.dir, spanPx: split.spanPx,
        startTree: tree, startX: event.clientX, startY: event.clientY,
      };
      if (typeof node.setPointerCapture === "function" && typeof event.pointerId === "number") {
        try { node.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
      }
    });
    node.addEventListener("pointermove", (event) => {
      if (!drag || drag.node !== node) return;
      const delta = drag.dir === "row" ? event.clientX - drag.startX : event.clientY - drag.startY;
      tree = applyGutterDelta(drag.startTree, drag.splitId, drag.index, delta, drag.spanPx);
      layout(false);
    });
    const finish = () => {
      if (!drag || drag.node !== node) return;
      drag = null;
      layout(true);
      persist();
    };
    node.addEventListener("pointerup", finish);
    node.addEventListener("pointercancel", finish);
    node.addEventListener("lostpointercapture", finish);
    node.addEventListener("dblclick", () => { equalize(); });
    return node;
  };
  const reconcileGutters = (gutters: GutterLayout[]) => {
    const seen = new Set<string>();
    for (const gutter of gutters) {
      const id = `${terminalNodeId("gutter", suffixOf(gutter.owner))}/${gutter.side}`;
      seen.add(id);
      let node = gutterNodes.get(id);
      if (!node) {
        node = createGutter(id);
        gutterNodes.set(id, node);
        root.append(node);
      }
      node.dataset.splitId = gutter.splitId;
      node.dataset.index = String(gutter.index);
      node.dataset.side = gutter.side;
      node.style.cursor = gutter.side === "right" ? "col-resize" : "row-resize";
      node.hidden = false;
      place(node, gutter.rect);
    }
    for (const [id, node] of gutterNodes) {
      if (seen.has(id)) continue;
      if (drag?.node === node) { node.hidden = true; continue; }
      node.remove();
      gutterNodes.delete(id);
    }
  };
  const layout = (notify: boolean) => {
    if (disposed) return;
    const area: LayoutRect = { x: 0, y: 0, width: root.clientWidth, height: root.clientHeight };
    let gutters: GutterLayout[] = [];
    if (maximizedKey !== null && mounted.has(maximizedKey)) {
      currentPanes = [{ key: maximizedKey, rect: area }];
      currentSplits = [];
      for (const [key, item] of mounted) {
        item.wrapper.hidden = key !== maximizedKey;
        item.pane.setIntrinsicVisible?.(!item.wrapper.hidden);
      }
      rects.set(maximizedKey, area);
      place(mounted.get(maximizedKey)!.wrapper, area);
    } else {
      const computed = computeSplitLayoutPx(tree, area, gutterPx);
      currentPanes = computed.panes;
      currentSplits = computed.splits;
      gutters = computed.gutters;
      for (const item of mounted.values()) {
        item.wrapper.hidden = false;
        item.pane.setIntrinsicVisible?.(true);
      }
      for (const { key, rect } of computed.panes) {
        const item = mounted.get(key);
        if (!item) continue;
        rects.set(key, rect);
        place(item.wrapper, rect);
      }
    }
    reconcileGutters(gutters);
    publishState();
    if (!notify) return;
    for (const { key, rect } of currentPanes) {
      const item = mounted.get(key);
      if (!item) continue;
      const before = notified.get(key);
      if (before && before.width === rect.width && before.height === rect.height) continue;
      notified.set(key, { width: rect.width, height: rect.height });
      item.pane.requestResize();
    }
  };

  const mountPane = (key: string, request: { engineId?: string; cwd?: string | null; title?: string | null }): WorkbenchPane => {
    const wrapper = document.createElement("div");
    wrapper.dataset.node = terminalNodeId("pane", suffixOf(key));
    wrapper.dataset.pane = key;
    Object.assign(wrapper.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", overflow: "hidden" });
    const paneRoot = document.createElement("div");
    Object.assign(paneRoot.style, { width: "100%", height: "100%" });
    wrapper.append(paneRoot);
    root.append(wrapper);
    const pane = paneSet.openPane({
      key, engineId: request.engineId, root: paneRoot, cwd: request.cwd ?? null, title: request.title ?? null,
      hostPixels: () => {
        const rect = rects.get(key);
        return rect ? { width: rect.width, height: rect.height } : { width: 0, height: 0 };
      },
    });
    const activate = () => { focus(key, false); };
    wrapper.addEventListener("pointerdown", activate, true);
    wrapper.addEventListener("focusin", activate);
    const typed = pane.onInput((text) => {
      if (!broadcastOn || key !== focusedKey) return;
      for (const other of paneSet.list()) if (other.key !== key) other.sendInput(text);
    });
    mounted.set(key, {
      wrapper, pane,
      dispose() {
        typed.dispose();
        wrapper.removeEventListener("pointerdown", activate, true);
        wrapper.removeEventListener("focusin", activate);
        wrapper.remove();
      },
    });
    return pane;
  };
  const unmountPane = (key: string) => {
    const item = mounted.get(key);
    if (!item) return;
    item.dispose();
    mounted.delete(key);
    rects.delete(key);
    notified.delete(key);
    void paneSet.closePane(key);
  };

  const focus = (key: string, toInput: boolean): boolean => {
    const item = mounted.get(key);
    if (!item) return false;
    if (focusedKey !== key) {
      focusedKey = key;
      paneSet.focusPane(key);
      applyFocusStyle();
      if (maximizedKey !== null && maximizedKey !== key) {
        maximizedKey = key;
        layout(true);
      }
      persist();
    }
    if (toInput) item.pane.presenter.focus();
    return true;
  };
  const focusDirection = (dir: PaneDirection): string | null => {
    if (focusedKey === null) return null;
    const next = neighborOf(currentPanes, focusedKey, dir, gutterPx);
    if (!next) return null;
    focus(next, true);
    return next;
  };
  const focusCycle = (delta: 1 | -1): string | null => {
    const order = leavesOf(tree).filter((key) => mounted.has(key));
    if (order.length === 0 || focusedKey === null) return null;
    const index = order.indexOf(focusedKey);
    const next = order[(index + delta + order.length) % order.length];
    focus(next, true);
    return next;
  };
  const split = (direction: "right" | "down", request: { engineId?: string; cwd?: string | null } = {}): WorkbenchPane | null => {
    if (single || focusedKey === null || !mounted.has(focusedKey)) return null;
    const from = focusedKey;
    const origin = mounted.get(from)!.pane;
    const key = paneSet.nextKey();
    tree = insertBeside(tree, (value) => value === from, direction === "right" ? "row" : "col", false, key, `split:${key}`);
    const pane = mountPane(key, { engineId: request.engineId, cwd: request.cwd ?? origin.cwd(), title: null });
    maximizedKey = null;
    layout(true);
    focus(key, true);
    persist();
    return pane;
  };
  const close = (key: string | undefined = focusedKey ?? undefined): { closed: boolean; focused: string | null } => {
    if (!key || !mounted.has(key)) return { closed: false, focused: focusedKey };
    const remaining = removeLeaf(tree, (value) => value === key);
    // The last pane is the view's: the host closes the view instead.
    if (!remaining) return { closed: false, focused: focusedKey };
    const wasFocused = key === focusedKey;
    const next = wasFocused
      ? neighborOf(currentPanes, key, "left", gutterPx) ?? neighborOf(currentPanes, key, "up", gutterPx)
        ?? neighborOf(currentPanes, key, "right", gutterPx) ?? neighborOf(currentPanes, key, "down", gutterPx)
        ?? leavesOf(remaining)[0]
      : focusedKey;
    tree = remaining;
    if (maximizedKey === key) maximizedKey = null;
    unmountPane(key);
    if (wasFocused) focusedKey = null;
    layout(true);
    if (next) focus(next, wasFocused);
    persist();
    return { closed: true, focused: focusedKey };
  };
  const resizeAt = (key: string, side: GutterSide | "left" | "top", px: number): boolean => {
    if (maximizedKey !== null || !mounted.has(key)) return false;
    const found = resolveGutter(tree, key, side);
    if (!found) return false;
    const box = currentSplits.find((item) => item.id === found.splitId);
    if (!box) return false;
    tree = applyGutterDelta(tree, found.splitId, found.index, px, box.spanPx);
    layout(true);
    persist();
    return true;
  };
  const resizeByArrow = (dir: PaneDirection) => {
    if (focusedKey === null) return;
    const horizontal = dir === "left" || dir === "right";
    const primary: GutterSide = horizontal ? "right" : "bottom";
    const fallback = horizontal ? "left" : "top";
    const side = resolveGutter(tree, focusedKey, primary) ? primary : fallback;
    resizeAt(focusedKey, side, dir === "right" || dir === "down" ? stepPx : -stepPx);
  };
  const equalize = (): boolean => {
    tree = equalizeSplitTree(tree);
    layout(true);
    persist();
    return true;
  };
  const maximize = (key: string | null): string | null => {
    if (key !== null && !mounted.has(key)) return maximizedKey;
    maximizedKey = key;
    layout(true);
    persist();
    return maximizedKey;
  };
  const run = (action: WorkbenchAction) => {
    switch (action.type) {
      case "split": split(action.direction); break;
      case "focus.direction": focusDirection(action.dir); break;
      case "focus.cycle": focusCycle(action.delta); break;
      case "resize": resizeByArrow(action.dir); break;
      case "maximize.toggle": maximize(maximizedKey !== null ? null : focusedKey); break;
      case "scroll": void focusedPane()?.scroll({ lines: action.lines }); break;
      case "scroll.edge": void focusedPane()?.scroll({ edge: action.edge }); break;
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const action = matchKey(event, focusedPane()?.presenter.size().rows || 24);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    run(action);
  };

  const ownKey = (key: string) => key === options.viewId || parsePaneKey(key)?.viewId === options.viewId;
  const saved = single ? null : parseRestoreState(options.restore);
  const savedTree = saved ? deserializeSplitTree(saved.tree) : null;
  const savedKeys = savedTree ? leavesOf(savedTree) : [];
  const restorable = saved !== null && savedTree !== null && savedKeys.length > 0
    && savedKeys.every((key) => ownKey(key) && saved.panes.some((pane) => pane.key === key))
    && new Set(savedKeys).size === savedKeys.length;
  if (restorable) {
    tree = savedTree!;
    for (const key of savedKeys) {
      const entry = saved!.panes.find((pane) => pane.key === key)!;
      mountPane(key, { engineId: entry.engineId, cwd: entry.cwd, title: entry.title });
    }
    broadcastOn = saved!.broadcast;
    maximizedKey = saved!.maximized !== null && mounted.has(saved!.maximized) ? saved!.maximized : null;
    focusedKey = savedKeys.includes(saved!.focused) ? saved!.focused : savedKeys[0];
  } else {
    const key = single ? options.viewId : paneSet.nextKey();
    tree = { type: "leaf", value: key };
    mountPane(key, { cwd: options.restoreCwd ?? null });
    focusedKey = key;
  }
  paneSet.focusPane(focusedKey);
  applyFocusStyle();
  layout(true);
  persist();
  const observer = observeTerminalLayout({
    element: root, resized: () => layout(true), events: options.events,
    createResizeObserver: options.createResizeObserver,
  });
  root.addEventListener("keydown", onKeyDown, true);

  return {
    root,
    list: () => leavesOf(tree).flatMap((key) => { const item = mounted.get(key); return item ? [item.pane] : []; }),
    focused: focusedPane,
    focus: (key, toInput = true) => focus(key, toInput),
    focusDirection,
    focusCycle,
    split,
    close,
    closeIntent() {
      if (mounted.size <= 1) return "pass";
      close(focusedKey ?? undefined);
      return "handled";
    },
    resize: (key, side, px) => resizeAt(key, side, px),
    resizeCells(key, side, cells) {
      const cell = mounted.get(key)?.pane.presenter.metrics?.();
      if (!cell) return false;
      return resizeAt(key, side, cells * (side === "right" ? cell.cellWidth : cell.cellHeight));
    },
    equalize,
    maximize,
    toggleMaximize: () => maximize(maximizedKey !== null ? null : focusedKey),
    maximized: () => maximizedKey,
    broadcast(on) {
      broadcastOn = on;
      publishState();
      persist();
      return broadcastOn;
    },
    isBroadcast: () => broadcastOn,
    setTitle: (key, title) => paneSet.setTitle(key, title),
    layout: () => layout(true),
    restoreState,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.dispose();
      root.removeEventListener("keydown", onKeyDown, true);
      for (const item of mounted.values()) item.dispose();
      mounted.clear();
      for (const node of gutterNodes.values()) node.remove();
      gutterNodes.clear();
    },
  };
}
