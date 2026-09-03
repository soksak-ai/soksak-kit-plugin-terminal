import {
  TERMINAL_INLINE_IMAGE_EVENTS,
  TERMINAL_INLINE_IMAGE_PROTOCOLS,
  TERMINAL_PLUGIN_COMMANDS,
  TERMINAL_PLUGIN_COMMAND_SCHEMAS,
  parsePaneKey,
  validateTerminalImageResource,
  validateTerminalInlineImageStatus,
  type TerminalImagePresentResult,
  type TerminalImageResource,
  type TerminalInlineImageProtocol,
  type TerminalInlineImageRefusal,
  type TerminalPaneSummary,
  type TerminalPluginCommand,
  type TerminalPluginPublicStatus,
  type TerminalPluginViewStatus,
} from "@soksak/soksak-contract-plugin-terminal";
import { createPaneSet, type PaneSet, type PaneSetContext, type PaneSetHost } from "./pane-set";
import type {
  PaneSession, TerminalPresenter, TerminalPresenterFactory, TerminalRendererAdapter,
} from "./pane-session";
import { rendererDelivery } from "./pane-session";
import { paneStopBarriers } from "./pane-stop-barriers";
import { createTerminalSessionBinding, type TerminalSessionBinding } from "./terminal-session-binding";
import { closedTerminalPresentation } from "./terminal-presentation-status";
import { waitForTerminalConditions } from "./terminal-condition-wait";
import { waitForTerminalSize } from "./terminal-size-wait";
import { readTerminalThemeStatus } from "./terminal-theme";
import { quoteTerminalDropPath } from "./terminal-drop-path";
import { terminalLoginShell } from "./terminal-environment";
import { terminalResizeStatus } from "./terminal-resize-status";
import type { TerminalLayoutEvents } from "./terminal-layout-observer";
import { parseRestoreState } from "./workbench/restore-state";
import type { PaneDirection } from "./workbench/split-layout";
import { createWorkbench, type Workbench } from "./workbench/workbench";

export interface ViewContext extends PaneSetContext {
  /** Selected workspace root; new panes start here unless restore supplies a cwd. */
  root: string | null;
  viewId?: string | null;
  /** Monotonic owner identity of this mounted Core view container. */
  containerGeneration: number;
  paneId?: string | null;
  restore?: { cwd: string | null; state: unknown } | null;
  // What the host shows of this view: whether it is painted, and how much the
  // focus lighting takes off it. A surface renderer applies dim to its own
  // alpha because the document veil cannot darken a native layer above it.
  presentation?(): { visible: boolean; dim?: number };
  onPresentationChange?(listener: (presentation: { visible: boolean; dim?: number }) => void): () => void;
}

export interface ProviderTerminalPluginHost extends PaneSetHost {
  events?: TerminalLayoutEvents & {
    on(event: "window.gone", callback: (payload: { windowLabel?: string }) => void): { dispose(): void };
    on(event: "paths.dropped", callback: (payload: {
      paneId: string | null;
      grants: Array<{ id: string; kind: "file" | "image" }>;
    }) => void): { dispose(): void };
  };
  ui: {
    registerView(id: string, provider: {
      // What this view needs to come back (SESSION.md S1-5). A terminal is "session": the shell
      // keeps running with nothing drawing it, so an owner holds it and the screen is replayed
      // from the output that owner stored.
      restores: "none" | "view" | "session";
      mount(container: HTMLElement, context: ViewContext): void;
      unmount?(container: HTMLElement): void;
      focus?(container: HTMLElement, context: ViewContext, request: { signal: AbortSignal }): void;
      prepareFocusTransfer?(container: HTMLElement): void;
      closeIntent?(container: HTMLElement): "handled" | "pass";
      closeView?(container: HTMLElement): Promise<void>;
    }): { dispose(): void };
    statusBarItem?(item: {
      id: string; paneId: string; label: string; title?: string; side?: "left" | "right";
    }): { dispose(): void };
  };
  commands: {
    register(name: string, spec: Record<string, unknown>): { dispose(): void } | void;
    execute?(name: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  clipboard?: {
    readText?(): Promise<string>;
    writeText?(text: string): Promise<void>;
  };
  fileGrants?: {
    redeem(id: string): Promise<{
      kind: "file" | "image";
      path: string;
    } | null>;
  };
  resources?: {
    open(resourceId: string): Promise<ReadableStream<Uint8Array> | null>;
    release(resourceId: string): Promise<void>;
  };
  // The plugin's user settings (manifest configuration); the engine selection is read here.
  settings?: { get(key: string): unknown };
}

export interface ProviderTerminalPluginConfig {
  pluginId: string;
  engineId: string;
  ptySidecarId: string;
  terminalSidecarId: string;
  programId: string;
  // Engine selection: the setting key the user chooses an engine with and the sidecar of every
  // engine offered. engineId/terminalSidecarId are the default engine and must be one entry of the
  // table. Every listed sidecar is a runtime dependency the manifest declares.
  engines?: { setting: string; sidecars: Record<string, string> };
  renderer?: TerminalRendererAdapter;
  // Frame presenter factory; the kit's own frame presenter when absent.
  presenter?: TerminalPresenterFactory;
  // "workbench" (default): panes keyed "<view>.<k>" with splitting. "single": one bare pane keyed
  // by the view id, no splitting.
  layout?: "single" | "workbench";
  extensions?: TerminalCommandExtension[];
  label?: { en: string; ko: string };
}

export interface TerminalCommandExtension {
  name: string;
  params: Record<string, unknown>;
  danger?: "inject";
  // view is the terminal view; pane is the one pane inside it the command reached.
  handler(params: Record<string, unknown>, screen: {
    view: string; pane: string; presenter: TerminalPresenter; writable: boolean; send(data: string): void;
  } | undefined): unknown;
}

interface MountedView {
  viewId: string;
  container: HTMLElement;
  set: PaneSet;
  workbench: Workbench;
  stopWatchingPresentation?: (() => void) | null;
}
interface Target { view: MountedView; pane: PaneSession }
type CommandContext = { pane?: string } | undefined;

const viewParam = { type: "string", description: { en: "Terminal view id", ko: "터미널 뷰 ID" } };
const paneParam = { type: "string", description: { en: "Pane key (<view>.<k>)", ko: "판 키 (<view>.<k>)" } };
const scoped = (params: Record<string, unknown> = {}) => ({ view: viewParam, pane: paneParam, ...params });
const DIRECTIONS: readonly PaneDirection[] = ["left", "right", "up", "down"];
const isDirection = (value: unknown): value is PaneDirection => DIRECTIONS.includes(value as PaneDirection);

const paneSummary = (pane: PaneSession): TerminalPaneSummary => {
  const size = pane.presenter.size();
  return {
    pane: pane.key, engineId: pane.engineId, phase: pane.status.current().phase,
    cols: size.cols, rows: size.rows, offset: pane.offset, historySize: pane.historySize, followMode: pane.followMode,
    title: pane.title, cwd: pane.cwd(),
  };
};

export function activateProviderTerminalPlugin(
  host: ProviderTerminalPluginHost,
  subscriptions: { dispose(): void }[],
  config: ProviderTerminalPluginConfig,
): void {
  const views = new Map<string, MountedView>();
  const consumedImageResources = new Set<string>();
  const stopBarriers = paneStopBarriers(config.pluginId, document);
  if (config.engines && config.engines.sidecars[config.engineId] !== config.terminalSidecarId) {
    throw new Error(`engines.sidecars.${config.engineId} must name ${config.terminalSidecarId}, the plugin's own engine sidecar`);
  }
  // The engine of a new pane: the user's setting when it names an offered engine, the plugin's
  // engine otherwise. A pane keeps the engine it was opened with.
  const engineSelection = (): { engineId: string; terminalSidecarId: string } => {
    if (!config.engines) return { engineId: config.engineId, terminalSidecarId: config.terminalSidecarId };
    const chosen = host.settings?.get(config.engines.setting);
    const engineId = typeof chosen === "string" && chosen in config.engines.sidecars ? chosen : config.engineId;
    return { engineId, terminalSidecarId: config.engines.sidecars[engineId] };
  };
  const sidecarOf = (engineId: string): string | undefined => config.engines
    ? config.engines.sidecars[engineId]
    : engineId === config.engineId ? config.terminalSidecarId : undefined;
  const bindings = new Map<string, TerminalSessionBinding>();
  const bindingFor = (terminalSidecarId: string): TerminalSessionBinding => {
    let bound = bindings.get(terminalSidecarId);
    if (!bound) {
      bound = createTerminalSessionBinding(host, {
        ptySidecarId: config.ptySidecarId,
        terminalSidecarId,
        // The pane set feeds the host decoder under the view id, focused pane only.
        observe: null,
        onOperation(operation) {
          for (const view of views.values()) {
            for (const pane of view.set.list()) {
              if (pane.binding === bound) pane.root.dataset.terminalOperation = operation;
            }
          }
        },
      });
      bindings.set(terminalSidecarId, bound);
    }
    return bound;
  };
  const engineFor = (requested?: string): { engineId: string; binding: TerminalSessionBinding } => {
    const selected = engineSelection();
    const engineId = requested && sidecarOf(requested) ? requested : selected.engineId;
    return { engineId, binding: bindingFor(sidecarOf(engineId) ?? selected.terminalSidecarId) };
  };
  const diagnosticsOrEmpty = async (binding: TerminalSessionBinding) => {
    try { return await binding.diagnostics(); }
    catch { return { pty: {}, recovery: {} }; }
  };
  const windowGone = host.events?.on("window.gone", (payload?: { windowLabel?: string }) => {
    const windowLabel = payload?.windowLabel;
    if (typeof windowLabel === "string" && windowLabel !== "") for (const bound of bindings.values()) void bound.closeWindow(windowLabel);
  });
  if (windowGone) subscriptions.push(windowGone);

  const register = (
    name: string,
    params: Record<string, unknown>,
    handler: (params: Record<string, unknown>, context?: { pane?: string }) => unknown,
    danger?: "inject",
  ) => {
    const commandLabel = config.label ?? { en: "Terminal", ko: "터미널" };
    const description = {
      en: `${commandLabel.en} ${name}`,
      ko: `${commandLabel.ko} ${name}`,
    };
    const schema = TERMINAL_PLUGIN_COMMAND_SCHEMAS[name as TerminalPluginCommand];
    const disposable = host.commands.register(name, {
      description, params, returns: "{}", message: () => description, handler,
      ...(schema?.danger === "inject" || danger === "inject" ? { danger: "inject" } : {}),
    });
    if (disposable) subscriptions.push(disposable);
  };

  // view: the named view; else the caller's own view; else the only view.
  const viewFor = (params: Record<string, unknown>, context: CommandContext): MountedView | undefined => {
    if (typeof params.view === "string") return views.get(params.view);
    if (typeof context?.pane === "string") {
      const contextual = views.get(context.pane);
      if (contextual) return contextual;
    }
    if (views.size === 1) return views.values().next().value;
    return undefined;
  };
  // pane wins; a view resolves to its focused pane.
  const target = (params: Record<string, unknown>, context: CommandContext): Target | undefined => {
    if (typeof params.pane === "string") {
      const owner = parsePaneKey(params.pane)?.viewId ?? params.pane;
      const view = views.get(owner);
      const pane = view?.set.get(params.pane);
      return view && pane ? { view, pane } : undefined;
    }
    const view = viewFor(params, context);
    const pane = view?.set.focused();
    return view && pane ? { view, pane } : undefined;
  };
  const viewOf = (container: HTMLElement) => [...views.values()].find((view) => view.container === container);
  const disposeView = async (view: MountedView, intent: "detach" | "close" = "detach") => {
    views.delete(view.viewId);
    view.stopWatchingPresentation?.();
    view.workbench.dispose();
    await view.set.dispose(intent);
  };

  const provider = {
    // The shell outlives this view, and what it printed is not derivable from anything else — so
    // this is the one kind that needs an owner rather than a record on the view.
    restores: "session" as const,
    mount(container: HTMLElement, context: ViewContext) {
      const viewId = context.viewId ?? "";
      if (!viewId) throw new Error("terminal view requires a view id");
      const existing = views.get(viewId);
      if (existing) void disposeView(existing);
      const saved = parseRestoreState(context.restore?.state);
      const set = createPaneSet(host, {
        viewId, container, context,
        config: {
          pluginId: config.pluginId, engineId: config.engineId, renderer: config.renderer,
          presenter: config.presenter, label: config.label,
          containerGeneration: context.containerGeneration,
        },
        engineFor, stopBarriers, restore: saved ? { next: saved.next } : null,
      });
      const workbench = createWorkbench(container, set, {
        viewId, restore: context.restore?.state, restoreCwd: context.restore?.cwd ?? null, initialCwd: context.root,
        layout: config.layout ?? "workbench", events: host.events,
      });
      for (const pane of set.list()) {
        pane.root.dataset.clipboardRead = String(host.clipboard?.readText !== undefined);
        pane.root.dataset.clipboardWrite = String(host.clipboard?.writeText !== undefined);
        const drop = pane.root.querySelector<HTMLElement>('[data-node^="terminal-drop-target"]');
        if (drop) drop.dataset.fileGrantState = host.fileGrants ? "available" : "unavailable";
      }
      const presentEverywhere = (visible: boolean, dim: number) => {
        for (const pane of set.list()) pane.setHostPresentation(visible, dim);
      };
      // A view the host is not showing is a view nothing has to be painted for. Its panes keep their
      // sessions and their output, and they ask for a frame again when the view is shown. The dim
      // rides alongside: focus lighting changes it without changing what is painted.
      const stopWatchingPresentation = context.onPresentationChange?.((presentation) => {
        presentEverywhere(presentation.visible, presentation.dim ?? 0);
      }) ?? null;
      if (context.presentation) {
        const initial = context.presentation();
        presentEverywhere(initial.visible, initial.dim ?? 0);
      }
      views.set(viewId, { viewId, container, set, workbench, stopWatchingPresentation });
    },
    unmount(container: HTMLElement) {
      const view = viewOf(container);
      if (view) void disposeView(view);
    },
    prepareFocusTransfer(container: HTMLElement) {
      viewOf(container)?.set.focused()?.presenter.prepareFocusTransfer?.();
    },
    focus(container: HTMLElement, _context: ViewContext, request: { signal: AbortSignal }) {
      if (request.signal.aborted) return;
      viewOf(container)?.set.focused()?.presenter.focus();
    },
    closeIntent(container: HTMLElement): "handled" | "pass" {
      const view = viewOf(container);
      if (!view) return "pass";
      if (view.set.list().length <= 1) {
        void disposeView(view, "close");
        return "pass";
      }
      return view.workbench.closeIntent();
    },
    async closeView(container: HTMLElement) {
      const view = viewOf(container);
      if (view) await disposeView(view, "close");
    },
  };
  subscriptions.push(host.ui.registerView("content", provider));

  const closedStatus = (): TerminalPluginViewStatus => ({
    pluginId: config.pluginId, engineId: engineSelection().engineId,
    rendererId: config.renderer?.rendererId ?? `${config.engineId}-frame`,
    rendererProfile: config.renderer?.rendererProfile ?? "web",
    phase: "closed", recoveryOutcome: "blocked", fidelity: "unavailable",
    failure: null, hostPixels: { width: 0, height: 0 }, requested: null, pty: null,
    recovery: null, rendered: null, operation: "closed",
    presentation: {
      ...closedTerminalPresentation(
        rendererDelivery(config.renderer),
        readTerminalThemeStatus(document.documentElement),
      ),
      clipboardPermission: {
        read: host.clipboard?.readText !== undefined,
        write: host.clipboard?.writeText !== undefined,
      },
      drop: { fileGrantState: host.fileGrants ? "available" : "unavailable", last: null },
    },
    view: null, pane: null, panes: [],
  });
  const publicStatus = async ({ view, pane }: Target): Promise<TerminalPluginViewStatus> => {
    const rendered = pane.presenter.size();
    const current = pane.status.current();
    const selected = await (pane.presenter.selection?.() ?? "");
    const drop = pane.root.querySelector<HTMLElement>('[data-node^="terminal-drop-target"]');
    let last: TerminalPluginViewStatus["presentation"]["drop"]["last"] = null;
    try {
      const value = drop?.dataset.lastDrop ? JSON.parse(drop.dataset.lastDrop) : null;
      if (value && Number.isSafeInteger(value.accepted) && Number.isSafeInteger(value.refused)
        && value.mode === "path") last = value;
    } catch { /* malformed DOM state is reported as no completed drop */ }
    return {
      ...current,
      ...terminalResizeStatus({
        pane: pane.key, session: pane.session,
        hostPixels: pane.hostPixels(),
        requested: pane.requestedSize, rendered: rendered.cols > 0 && rendered.rows > 0 ? rendered : null,
        renderedOutputSequence: pane.renderedOutputSequence,
        operation: pane.root.dataset.terminalOperation ?? "unknown",
        diagnostics: await diagnosticsOrEmpty(pane.binding),
      }),
      presentation: {
        ...current.presentation,
        bracketedPaste: pane.presenter.modes?.().bracketedPaste === true,
        selection: { active: selected !== "", text: selected },
        clipboardPermission: {
          read: host.clipboard?.readText !== undefined,
          write: host.clipboard?.writeText !== undefined,
        },
        drop: {
          fileGrantState: host.fileGrants ? "available" : "unavailable",
          last,
        },
      },
      view: view.viewId, pane: pane.key, panes: view.set.list().map(paneSummary),
    };
  };
  const statusHandler = async (params: Record<string, unknown>, context: CommandContext) => {
    const found = target(params, context);
    return found ? publicStatus(found) : closedStatus();
  };

  register("status", scoped(), statusHandler);
  register("archive", scoped(), async (params, context) => {
    const found = target(params, context);
    if (!found) return { archived: false };
    const response = await found.pane.binding.recoveryRequest({ op: "archive", pane: found.pane.key });
    return response.ok === true ? { archived: true, ...(response.data as object) } : response;
  });
  register("wait", scoped({
    phase: {
      type: "string", required: true,
      enum: ["initializing", "preparing-recovery", "applying-snapshot", "attaching-live-stream", "live", "archived", "degraded-tail", "blocked", "closed"],
      description: { en: "Terminal phase", ko: "터미널 단계" },
    },
    timeoutMs: { type: "number", default: 10000, description: { en: "Timeout in milliseconds", ko: "제한 시간(밀리초)" } },
    contains: { type: "string", description: { en: "Screen text", ko: "화면 텍스트" } },
    cols: { type: "number", description: { en: "Exact terminal columns", ko: "정확한 터미널 열 수" } },
    colsLessThan: { type: "number", description: { en: "Terminal columns below this value", ko: "이 값보다 작은 터미널 열 수" } },
    colsGreaterThan: { type: "number", description: { en: "Terminal columns above this value", ko: "이 값보다 큰 터미널 열 수" } },
    rows: { type: "number", description: { en: "Exact terminal rows", ko: "정확한 터미널 행 수" } },
    focusedInput: { type: "boolean", description: { en: "Focused input state", ko: "입력 포커스 상태" } },
    cursorVisible: { type: "boolean", description: { en: "Visible cursor state", ko: "커서 표시 상태" } },
    cursorActive: { type: "boolean", description: { en: "Active cursor state", ko: "활성 커서 상태" } },
    acceptedInputSequenceGreaterThan: { type: "number", description: { en: "Input admission sequence strictly above this value", ko: "이 값보다 큰 input admission 순서" } },
    ptyWriteSequenceGreaterThan: { type: "number", description: { en: "PTY write sequence strictly above this value", ko: "이 값보다 큰 PTY write 순서" } },
    themeMode: { type: "string", enum: ["light", "dark"], description: { en: "Presented terminal theme mode", ko: "표시된 터미널 테마 모드" } },
    effectiveBackground: { type: "string", description: { en: "Presented effective background color", ko: "표시된 최종 배경색" } },
    historySize: { type: "number", description: { en: "Exact history size", ko: "정확한 기록 크기" } },
    minHistorySize: { type: "number", description: { en: "Minimum history size", ko: "최소 기록 크기" } },
    offset: { type: "number", description: { en: "Exact viewport offset", ko: "정확한 viewport 위치" } },
    followMode: { type: "string", enum: ["follow", "pinned"], description: { en: "Viewport follow mode", ko: "viewport 따라가기 모드" } },
    idleMs: { type: "number", description: { en: "No output for this long", ko: "이 시간 동안 출력 없음" } },
  }), async (params, context) => {
    const found = target(params, context);
    if (!found) return { ...closedStatus(), historySize: 0, offset: 0, followMode: "follow" };
    const { pane } = found;
    const phase = String(params.phase) as TerminalPluginPublicStatus["phase"];
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
    const startedAt = performance.now();
    const waited = await waitForTerminalConditions({
      status: pane.status, phase,
      contains: typeof params.contains === "string" && params.contains !== ""
        ? params.contains : undefined,
      timeoutMs, waitForText: pane.presenter.waitForText,
      presentation: {
        ...(typeof params.focusedInput === "boolean" ? { focusedInput: params.focusedInput } : {}),
        ...(typeof params.cursorVisible === "boolean" ? { cursorVisible: params.cursorVisible } : {}),
        ...(typeof params.cursorActive === "boolean" ? { cursorActive: params.cursorActive } : {}),
        ...(typeof params.acceptedInputSequenceGreaterThan === "number"
          ? { acceptedInputSequenceGreaterThan: params.acceptedInputSequenceGreaterThan } : {}),
        ...(typeof params.ptyWriteSequenceGreaterThan === "number"
          ? { ptyWriteSequenceGreaterThan: params.ptyWriteSequenceGreaterThan } : {}),
      },
      theme: {
        ...(params.themeMode === "light" || params.themeMode === "dark"
          ? { themeMode: params.themeMode } : {}),
        ...(typeof params.effectiveBackground === "string"
          ? { effectiveBackground: params.effectiveBackground } : {}),
      },
      viewport: {
        ...(typeof params.historySize === "number" ? { historySize: params.historySize } : {}),
        ...(typeof params.minHistorySize === "number" ? { minHistorySize: params.minHistorySize } : {}),
        ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
        ...(params.followMode === "follow" || params.followMode === "pinned"
          ? { followMode: params.followMode } : {}),
      },
      readViewport: () => ({
        historySize: pane.historySize,
        offset: pane.offset,
        followMode: pane.followMode,
      }),
      size: {
        ...(typeof params.cols === "number" ? { cols: params.cols } : {}),
        ...(typeof params.colsLessThan === "number" ? { colsLessThan: params.colsLessThan } : {}),
        ...(typeof params.colsGreaterThan === "number" ? { colsGreaterThan: params.colsGreaterThan } : {}),
        ...(typeof params.rows === "number" ? { rows: params.rows } : {}),
      },
      waitForSize: (condition, limit) => waitForTerminalSize(
        pane.root, condition, limit, pane.presenter.size,
      ),
    });
    if (typeof params.idleMs === "number" && params.idleMs > 0) {
      await pane.waitIdle(params.idleMs, Math.max(1, Math.ceil(timeoutMs - (performance.now() - startedAt))));
    }
    return {
      ...waited, ...pane.presenter.size(),
      operation: pane.root.dataset.terminalOperation ?? "unknown",
      pane: pane.key,
    };
  });
  register("read", scoped({
    lines: { type: "number", description: { en: "Trailing line count", ko: "마지막 줄 수" } },
  }), async (params, context) => {
    const found = target(params, context);
    return {
      text: found
        ? await found.pane.presenter.read(typeof params.lines === "number" ? params.lines : undefined)
        : "",
    };
  });
  register("send", scoped({
    data: { type: "string", required: true, description: { en: "Input data", ko: "입력 데이터" } },
  }), (params, context) => {
    const found = target(params, context);
    if (!found?.pane.writable || typeof params.data !== "string") return { sent: false };
    void found.pane.write(params.data).catch(() => {});
    return { sent: params.data.length };
  });
  register("clear", scoped(), (params, context) => {
    const found = target(params, context);
    if (!found?.pane.writable) return { cleared: false };
    void found.pane.write("\x0c").catch(() => {});
    return { cleared: true };
  });
  register("focus", scoped(), (params, context) => {
    const found = target(params, context);
    if (!found) return { focused: false };
    found.view.workbench.focus(found.pane.key, false);
    return { focused: found.pane.presenter.focus() };
  });
  register("recovery-status", scoped(), statusHandler);

  register("split", scoped({
    direction: { type: "string", required: true, enum: ["right", "down"], description: { en: "Split direction", ko: "분할 방향" } },
    command: { type: "string", description: { en: "Command to run in the new pane", ko: "새 판에서 실행할 명령" } },
  }), (params, context) => {
    const found = target(params, context);
    if (!found) return { view: null, pane: null, engineId: engineSelection().engineId };
    found.view.workbench.focus(found.pane.key, false);
    const opened = found.view.workbench.split(params.direction === "down" ? "down" : "right");
    if (!opened) return { view: found.view.viewId, pane: null, engineId: found.pane.engineId };
    const session = found.view.set.get(opened.key);
    const command = typeof params.command === "string" ? params.command : "";
    if (session && command) {
      void session.status.wait(["live"], 10000).then(() => session.write(`${command}\r`)).catch(() => {});
    }
    return { view: found.view.viewId, pane: opened.key, engineId: opened.engineId };
  });
  register("pane.close", scoped(), (params, context) => {
    const found = target(params, context);
    return found ? found.view.workbench.close(found.pane.key) : { closed: false, focused: null };
  });
  register("pane.focus", scoped({
    dir: { type: "string", enum: [...DIRECTIONS], description: { en: "Neighbor direction", ko: "이웃 방향" } },
    cycle: { type: "number", enum: [1, -1], description: { en: "Cycle step", ko: "순환 단계" } },
  }), (params, context) => {
    const found = target(params, context);
    if (!found) return { focused: null };
    const { workbench } = found.view;
    if (typeof params.pane === "string") workbench.focus(found.pane.key, true);
    else if (isDirection(params.dir)) workbench.focusDirection(params.dir);
    else if (params.cycle === 1 || params.cycle === -1) workbench.focusCycle(params.cycle);
    else workbench.focus(found.pane.key, true);
    return { focused: workbench.focused()?.key ?? null };
  });
  register("pane.list", { view: viewParam }, (params, context) => {
    const view = viewFor(params, context);
    if (!view) return { view: null, focused: null, maximized: null, broadcast: false, panes: [] };
    return {
      view: view.viewId, focused: view.workbench.focused()?.key ?? null,
      maximized: view.workbench.maximized(), broadcast: view.workbench.isBroadcast(),
      panes: view.set.list().map(paneSummary),
    };
  });
  register("pane.resize", scoped({
    side: { type: "string", required: true, enum: ["right", "bottom"], description: { en: "Edge to move", ko: "옮길 가장자리" } },
    px: { type: "number", description: { en: "Pixels", ko: "픽셀" } },
    cells: { type: "number", description: { en: "Cells", ko: "칸" } },
  }), (params, context) => {
    const found = target(params, context);
    const side = params.side === "bottom" ? "bottom" : params.side === "right" ? "right" : null;
    if (!found || !side) return { applied: false };
    if (typeof params.px === "number") return { applied: found.view.workbench.resize(found.pane.key, side, params.px) };
    if (typeof params.cells === "number") return { applied: found.view.workbench.resizeCells(found.pane.key, side, params.cells) };
    return { applied: false };
  });
  register("pane.equalize", { view: viewParam }, (params, context) => ({
    applied: viewFor(params, context)?.workbench.equalize() ?? false,
  }));
  register("pane.maximize", scoped(), (params, context) => {
    const found = target(params, context);
    if (!found) return { maximized: null };
    const { workbench } = found.view;
    return { maximized: workbench.maximize(workbench.maximized() === found.pane.key ? null : found.pane.key) };
  });
  register("pane.broadcast", {
    view: viewParam,
    on: { type: "boolean", required: true, description: { en: "Broadcast input to every pane", ko: "모든 판에 입력 전달" } },
  }, (params, context) => ({
    broadcast: viewFor(params, context)?.workbench.broadcast(params.on === true) ?? false,
  }));
  register("pane.title", scoped({
    title: { type: ["string", "null"], required: true, description: { en: "Pane title, null clears", ko: "판 제목, null이면 지움" } },
  }), (params, context) => {
    const found = target(params, context);
    if (!found) return { title: null };
    found.view.workbench.setTitle(found.pane.key, typeof params.title === "string" ? params.title : null);
    return { title: found.pane.title };
  });
  register("scroll", scoped({
    lines: { type: "number", description: { en: "Lines into history (negative toward the bottom)", ko: "기록 방향 줄 수(음수는 아래)" } },
    offset: { type: "number", description: { en: "Absolute offset from the bottom", ko: "아래에서부터의 절대 위치" } },
    edge: { type: "string", enum: ["top", "bottom"], description: { en: "Jump to an edge", ko: "가장자리로 이동" } },
  }), async (params, context) => {
    const found = target(params, context);
    if (!found) return { pane: null, offset: 0, historySize: 0, followMode: "follow" };
    return found.pane.scroll({
      ...(typeof params.lines === "number" ? { lines: params.lines } : {}),
      ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
      ...(params.edge === "top" || params.edge === "bottom" ? { edge: params.edge } : {}),
    });
  });
  register("selection", scoped(), async (params, context) => {
    const found = target(params, context);
    const text = found ? await (found.pane.presenter.selection?.() ?? "") : "";
    const result = found ? { pane: found.pane.key, text } : { pane: null, text: "" };
    if (found) {
      found.pane.root.dataset.selectionActive = String(result.text !== "");
      found.pane.root.dataset.selectionText = result.text;
    }
    found?.pane.root.dispatchEvent(new CustomEvent("soksak:terminal-selection", { bubbles: true, detail: result }));
    return result;
  });
  register("copy", scoped(), async (params, context) => {
    const found = target(params, context);
    const text = found ? await (found.pane.presenter.selection?.() ?? "") : "";
    if (found) {
      found.pane.root.dataset.selectionActive = String(text !== "");
      found.pane.root.dataset.selectionText = text;
    }
    const copied = Boolean(found && text && host.clipboard?.writeText);
    if (copied) await host.clipboard!.writeText!(text);
    const result = { pane: found?.pane.key ?? null, text, copied };
    found?.pane.root.dispatchEvent(new CustomEvent("soksak:terminal-clipboard-copied", { bubbles: true, detail: result }));
    return result;
  });
  register("paste", scoped({
    data: { type: "string", description: { en: "Text; omitted reads the granted clipboard", ko: "텍스트; 생략하면 허용된 클립보드를 읽음" } },
  }), async (params, context) => {
    const found = target(params, context);
    const explicit = typeof params.data === "string" ? params.data : null;
    const data = explicit ?? (host.clipboard?.readText ? await host.clipboard.readText() : null);
    if (!found?.pane.writable || data === null) {
      return { pane: found?.pane.key ?? null, pasted: false, sent: 0 };
    }
    const bracketed = found.pane.presenter.modes?.().bracketedPaste === true;
    const payload = bracketed ? `\x1b[200~${data}\x1b[201~` : data;
    await found.pane.write(payload);
    const result = { pane: found.pane.key, pasted: true, sent: payload.length };
    found.pane.root.dispatchEvent(new CustomEvent("soksak:terminal-clipboard-pasted", { bubbles: true, detail: result }));
    return result;
  }, "inject");
  const handleDrop = async (params: Record<string, unknown>, context?: CommandContext) => {
    const found = target(params, context);
    const mode = "path" as const;
    const tokens = Array.isArray(params.grants)
      ? params.grants.filter((value): value is string => typeof value === "string" && value !== "")
      : [];
    const redeemed = [];
    if (found && host.fileGrants) {
      for (const token of tokens) {
        const grant = await host.fileGrants.redeem(token);
        if (grant && grant.path !== "" && !/[\0\r\n]/.test(grant.path)) redeemed.push(grant);
      }
    }
    let accepted = 0;
    if (found?.pane.writable && redeemed.length > 0) {
      const shell = await terminalLoginShell(host.commands);
      await found.pane.write(`${redeemed.map((grant) => quoteTerminalDropPath(grant.path, shell)).join(" ")} `);
      accepted = redeemed.length;
    }
    const result = { pane: found?.pane.key ?? null, accepted, refused: tokens.length - accepted, mode };
    const drop = found?.pane.root.querySelector<HTMLElement>('[data-node^="terminal-drop-target"]');
    if (drop) drop.dataset.lastDrop = JSON.stringify({ accepted, refused: tokens.length - accepted, mode });
    found?.pane.root.dispatchEvent(new CustomEvent(
      accepted > 0 ? "soksak:terminal-drop-accepted" : "soksak:terminal-drop-refused",
      { bubbles: true, detail: result },
    ));
    return result;
  };
  register("drop", scoped({
    grants: { type: "array", required: true, description: { en: "Opaque host-issued file grants", ko: "host가 발급한 불투명 file grant" } },
  }), handleDrop, "inject");
  const dropped = host.events?.on("paths.dropped", (payload) => {
    if (!payload.paneId || payload.grants.length === 0) return;
    void handleDrop({
      view: payload.paneId,
      grants: payload.grants.map((grant) => grant.id),
    }).catch(() => {});
  });
  if (dropped) subscriptions.push(dropped);
  const refusal = (
    found: Target | undefined,
    resourceId: string,
    code: TerminalInlineImageRefusal["code"],
    message: string,
  ): TerminalImagePresentResult => ({
    pane: found?.pane.key ?? null,
    resourceId,
    presented: false,
    protocol: null,
    refusal: { resourceId, code, message },
  });
  const publishImageResult = (
    found: Target | undefined,
    resource: TerminalImageResource,
    result: TerminalImagePresentResult,
  ): TerminalImagePresentResult => {
    if (found) {
      if (result.refusal) found.pane.root.dataset.inlineImageRefusal = JSON.stringify(result.refusal);
      else delete found.pane.root.dataset.inlineImageRefusal;
      found.pane.status.refresh();
      found.pane.root.dispatchEvent(new CustomEvent(
        result.presented ? TERMINAL_INLINE_IMAGE_EVENTS.presented : TERMINAL_INLINE_IMAGE_EVENTS.refused,
        {
          bubbles: true,
          detail: result.presented
            ? {
                pane: found.pane.key, resourceId: resource.resourceId,
                protocol: result.protocol, mime: resource.mime, sizeBytes: resource.sizeBytes,
              }
            : { pane: found.pane.key, resourceId: resource.resourceId, refusal: result.refusal },
        },
      ));
    }
    return result;
  };
  register("image.present", scoped({
    resource: { type: "object", required: true, description: { en: "Authorized opaque image resource", ko: "허용된 불투명 이미지 리소스" } },
    protocol: { type: "string", description: { en: "Requested terminal image protocol", ko: "요청할 터미널 이미지 프로토콜" } },
  }), async (params, context) => {
    const resourceErrors = validateTerminalImageResource(params.resource);
    if (resourceErrors.length > 0) throw new Error(`invalid terminal image resource: ${resourceErrors.join("; ")}`);
    const resource = params.resource as TerminalImageResource;
    const found = target(params, context);
    if (consumedImageResources.has(resource.resourceId)) {
      return publishImageResult(found, resource, refusal(
        found, resource.resourceId, "resource-unavailable", "image resource was already consumed",
      ));
    }
    consumedImageResources.add(resource.resourceId);
    let result: TerminalImagePresentResult;
    try {
      if (!found) {
        result = refusal(found, resource.resourceId, "resource-unavailable", "target pane is unavailable");
      } else {
        const imageStatus = found.pane.presenter.inlineImageStatus?.() ?? {
          inlineImageProtocols: [], inlineImageLimits: {}, inlineImageRefusal: null,
        };
        const statusErrors = validateTerminalInlineImageStatus(imageStatus);
        if (statusErrors.length > 0) {
          result = refusal(found, resource.resourceId, "unsupported-engine", `engine image status is invalid: ${statusErrors.join("; ")}`);
        } else {
          const requested = params.protocol;
          const knownRequest = requested === undefined || (
            typeof requested === "string"
            && TERMINAL_INLINE_IMAGE_PROTOCOLS.includes(requested as TerminalInlineImageProtocol)
          );
          const protocol = knownRequest
            ? (requested as TerminalInlineImageProtocol | undefined) ?? imageStatus.inlineImageProtocols[0]
            : undefined;
          if (!found.pane.presenter.presentInlineImage || imageStatus.inlineImageProtocols.length === 0) {
            result = refusal(found, resource.resourceId, "unsupported-engine", "engine declares no inline image protocol");
          } else if (!protocol || !imageStatus.inlineImageProtocols.includes(protocol)) {
            result = refusal(found, resource.resourceId, "unsupported-protocol", "requested inline image protocol is unavailable");
          } else {
            const limits = imageStatus.inlineImageLimits[protocol];
            if (!limits) {
              result = refusal(found, resource.resourceId, "unsupported-engine", "engine omitted limits for the selected protocol");
            } else if (!limits.supportedMimeTypes.includes(resource.mime)) {
              result = refusal(found, resource.resourceId, "unsupported-mime", "image MIME is not supported by the selected protocol");
            } else if (resource.sizeBytes > limits.maxBytes) {
              result = refusal(found, resource.resourceId, "resource-too-large", "image exceeds the selected protocol byte limit");
            } else if (resource.lifetime.expiresAtUnixMs <= Date.now()) {
              result = refusal(found, resource.resourceId, "resource-expired", "image resource lease has expired");
            } else if (!host.resources) {
              result = refusal(found, resource.resourceId, "resource-unavailable", "host resource delivery is unavailable");
            } else {
              let stream: ReadableStream<Uint8Array> | null;
              try { stream = await host.resources.open(resource.resourceId); }
              catch { stream = null; }
              if (!stream) {
                result = refusal(found, resource.resourceId, "resource-unavailable", "image resource cannot be opened");
              } else {
                try {
                  const presented = await found.pane.presenter.presentInlineImage({ resource, protocol, stream });
                  result = presented
                    ? { pane: found.pane.key, resourceId: resource.resourceId, presented: true, protocol, refusal: null }
                    : refusal(found, resource.resourceId, "presentation-failed", "engine refused image presentation");
                } catch {
                  result = refusal(found, resource.resourceId, "presentation-failed", "engine image presentation failed");
                }
              }
            }
          }
        }
      }
    } finally {
      await host.resources?.release(resource.resourceId);
    }
    return publishImageResult(found, resource, result!);
  });
  register("input.compose", scoped({
    updates: { type: "array", required: true, description: { en: "Composition updates in order", ko: "순서대로의 조합 갱신" } },
    data: { type: "string", required: true, description: { en: "Committed text", ko: "확정 텍스트" } },
  }), (params, context) => {
    const found = target(params, context);
    const updates = Array.isArray(params.updates) ? params.updates.filter((value): value is string => typeof value === "string") : [];
    if (!found || typeof params.data !== "string") return { emitted: 0 };
    return { emitted: found.pane.presenter.compose?.(updates, params.data) ?? 0 };
  }, "inject");

  for (const extension of config.extensions ?? []) {
    if ((TERMINAL_PLUGIN_COMMANDS as readonly string[]).includes(extension.name)) {
      throw new Error(`terminal extension cannot replace standard command ${extension.name}`);
    }
    register(extension.name, extension.params, (params, context) => {
      const found = target(params, context);
      return extension.handler(params, found ? {
        view: found.view.viewId, pane: found.pane.key, presenter: found.pane.presenter,
        writable: found.pane.writable,
        send: (data) => { void found.pane.write(data).catch(() => {}); },
      } : undefined);
    }, extension.danger);
  }
  subscriptions.push({
    async dispose() {
      await Promise.all([...views.values()].map((view) => disposeView(view)));
      await Promise.all([...bindings.values()].map((binding) => binding.dispose()));
      bindings.clear();
    },
  });
}
