import { paneKey, parsePaneKey, type TerminalPluginPublicStatus } from "@soksak/soksak-contract-plugin-terminal";
import { createPaneSession, type PaneSession, type PaneSessionConfig } from "./pane-session";
import type { TerminalSessionBinding, TerminalSessionHost } from "./terminal-session-binding";

export interface PaneSetHost extends TerminalSessionHost {
  locale?(): string;
  ui: {
    statusBarItem?(item: {
      id: string; paneId: string; label: string; title?: string; side?: "left" | "right";
    }): { dispose(): void };
  };
  terminal?: TerminalSessionHost["terminal"] & {
    registerIo?(pane: string, io: {
      readBuffer(lines?: number): string;
      sendInput(data: string): void;
    }): { dispose(): void };
    getCwd?(pane: string): string | undefined;
    onCwd?(pane: string, callback: (cwd: string) => void): { dispose(): void };
  };
}

export interface PaneSetContext {
  setStatus?: (status: { code: string; message?: string } | null) => void;
  setTitle?: (title: string) => void;
  setRestoreState?: (state: unknown) => void;
}

export interface PaneOpenRequest {
  key?: string;
  engineId?: string;
  root: HTMLElement;
  cwd?: string | null;
  title?: string | null;
  hostPixels?(): { width: number; height: number };
}

export interface PaneSetRestoreState {
  next: number;
  panes: Array<{ key: string; engineId: string; title: string | null; cwd: string | null }>;
}

export interface PaneSetInput {
  viewId: string;
  // The view container: the focused pane's status is mirrored onto it.
  container: HTMLElement;
  context: PaneSetContext;
  config: PaneSessionConfig & { label?: { en: string; ko: string } };
  engineFor(engineId?: string): { engineId: string; binding: TerminalSessionBinding };
  // Shared across pane sets of one plugin: a remount waits for the previous generation's detach.
  stopBarriers?: Map<string, Promise<void>>;
  restore?: { next: number } | null;
  now?: () => number;
}

export interface PaneSet {
  readonly viewId: string;
  openPane(request: PaneOpenRequest): PaneSession;
  closePane(key: string): Promise<boolean>;
  focusPane(key: string): boolean;
  focused(): PaneSession | undefined;
  get(key: string): PaneSession | undefined;
  list(): PaneSession[];
  nextKey(): string;
  setTitle(key: string, title: string | null): boolean;
  bindLayout(layout: () => Record<string, unknown>): void;
  persist(): void;
  restoreState(): PaneSetRestoreState;
  dispose(intent?: "detach" | "close"): Promise<void>;
}

const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

export function createPaneSet(host: PaneSetHost, input: PaneSetInput): PaneSet {
  const { viewId, container, context } = input;
  const barriers = input.stopBarriers ?? new Map<string, Promise<void>>();
  const panes = new Map<string, PaneSession>();
  const disposables: { dispose(): void }[] = [];
  let next = Math.max(1, input.restore?.next ?? 1);
  let focusedKey: string | null = null;
  let layout: () => Record<string, unknown> = () => ({});
  let cwd: string | undefined = host.terminal?.getCwd?.(viewId);
  let disposed = false;

  const focused = () => (focusedKey === null ? undefined : panes.get(focusedKey));
  const locale = host.locale?.() ?? "en";
  const pluginLabel = locale.startsWith("ko") ? input.config.label?.ko : input.config.label?.en;
  let kindItem: { dispose(): void } | undefined;
  const placeKind = () => {
    kindItem?.dispose();
    kindItem = undefined;
    const engineId = focused()?.engineId;
    if (pluginLabel && engineId) {
      kindItem = host.ui.statusBarItem?.({
        id: `kind:${viewId}`, paneId: viewId, label: `${pluginLabel} · ${engineId}`,
      });
    }
  };
  const mirror = (status: TerminalPluginPublicStatus) => {
    container.dataset.terminalPhase = status.phase;
    container.dataset.terminalRecovery = status.recoveryOutcome;
    container.dataset.terminalFidelity = status.fidelity;
    if (status.failure) container.dataset.terminalFailure = status.failure.code;
    else delete container.dataset.terminalFailure;
    context.setStatus?.(status.failure ? { code: status.failure.code, message: status.failure.message } : null);
  };
  const refreshTitle = () => {
    const title = focused()?.title ?? (cwd ? basename(cwd) : "");
    if (title) context.setTitle?.(title);
  };
  const restoreState = (): PaneSetRestoreState => ({
    next,
    panes: [...panes.values()].map((pane) => ({
      key: pane.key, engineId: pane.engineId, title: pane.title, cwd: pane.cwd(),
    })),
  });
  const persist = () => {
    if (disposed) return;
    context.setRestoreState?.({ version: 1, ...layout(), ...restoreState() });
  };
  const keyFor = (requested?: string): { key: string; suffix: string | null } => {
    if (requested === undefined) {
      const key = paneKey(viewId, next);
      next += 1;
      return { key, suffix: String(next - 1) };
    }
    if (requested === viewId) return { key: requested, suffix: null };
    const parsed = parsePaneKey(requested);
    if (!parsed || parsed.viewId !== viewId) throw new Error(`pane key ${requested} does not belong to view ${viewId}`);
    next = Math.max(next, parsed.k + 1);
    return { key: requested, suffix: String(parsed.k) };
  };
  const focusPane = (key: string): boolean => {
    const pane = panes.get(key);
    if (!pane) return false;
    const changed = focusedKey !== key;
    if (changed) {
      focusedKey = key;
      // The host decoder follows the focused pane: replay its last cwd report so cwd is current.
      const report = pane.lastCwdReport();
      if (report) host.terminal?.observe?.(viewId, report);
    }
    mirror(pane.status.current());
    refreshTitle();
    if (changed) placeKind();
    persist();
    return true;
  };
  const openPane = (request: PaneOpenRequest): PaneSession => {
    if (disposed) throw new Error(`pane set of ${viewId} is disposed`);
    const { key, suffix } = keyFor(request.key);
    if (panes.has(key)) throw new Error(`pane ${key} is already open`);
    const engine = input.engineFor(request.engineId);
    const pane = createPaneSession({
      key, viewId, engineId: engine.engineId, binding: engine.binding, root: request.root,
      config: input.config, nodeSuffix: suffix, cwd: request.cwd ?? null, title: request.title ?? null,
      hostPixels: request.hostPixels, readyToStart: barriers.get(key), now: input.now,
      observe: (bytes) => { if (focusedKey === key) host.terminal?.observe?.(viewId, bytes); },
      publish: (status) => { if (focusedKey === key) mirror(status); },
    });
    panes.set(key, pane);
    if (focusedKey === null) focusPane(key);
    else persist();
    return pane;
  };
  const holdStopBarrier = (key: string, stopping: Promise<void>) => {
    barriers.set(key, stopping);
    void stopping.finally(() => {
      if (barriers.get(key) === stopping) barriers.delete(key);
    });
  };
  // A closed pane is gone: its session ends with it, so no shell is left running for a pane nothing
  // will ever show again. Unmounting is the other case, and that one detaches.
  const closePane = async (key: string): Promise<boolean> => {
    const pane = panes.get(key);
    if (!pane) return false;
    panes.delete(key);
    const stopping = pane.stop("close");
    holdStopBarrier(key, stopping);
    if (focusedKey === key) {
      focusedKey = null;
      const remaining = panes.keys().next().value;
      if (remaining) focusPane(remaining);
      else { placeKind(); persist(); }
    } else {
      persist();
    }
    await stopping;
    return true;
  };

  const io = host.terminal?.registerIo?.(viewId, {
    readBuffer: (lines) => focused()?.presenter.read(lines) ?? "",
    sendInput: (data) => focused()?.sendInput(data),
  });
  if (io) disposables.push(io);
  let cwdItem: { dispose(): void } | undefined;
  const placeCwd = (value?: string) => {
    cwdItem?.dispose();
    cwdItem = host.ui.statusBarItem?.({ id: `cwd:${viewId}`, paneId: viewId, label: value ?? "~", title: value, side: "left" });
  };
  if (host.ui.statusBarItem) {
    placeCwd(cwd);
    disposables.push({ dispose: () => cwdItem?.dispose() });
    disposables.push({ dispose: () => kindItem?.dispose() });
  }
  const watch = host.terminal?.onCwd?.(viewId, (value) => {
    cwd = value;
    if (host.ui.statusBarItem) placeCwd(value);
    refreshTitle();
  });
  if (watch) disposables.push(watch);

  return {
    viewId,
    openPane,
    closePane,
    focusPane,
    focused,
    get: (key) => panes.get(key),
    list: () => [...panes.values()],
    nextKey: () => paneKey(viewId, next),
    setTitle(key, title) {
      const pane = panes.get(key);
      if (!pane) return false;
      pane.title = title;
      refreshTitle();
      persist();
      return true;
    },
    bindLayout(getter) { layout = getter; },
    persist,
    restoreState,
    // Unmounting is not closing: the view may be mounted again, and each pane reattaches to the
    // session it left. A pane that is actually closed goes through closePane, which ends it.
    async dispose(intent = "detach") {
      disposed = true;
      const stops = [...panes.values()].map((pane) => {
        const stopping = pane.stop(intent);
        holdStopBarrier(pane.key, stopping);
        return stopping;
      });
      panes.clear();
      focusedKey = null;
      disposables.splice(0).forEach((item) => item.dispose());
      await Promise.all(stops);
    },
  };
}
