import {
  TERMINAL_PLUGIN_COMMANDS,
  TERMINAL_PLUGIN_COMMAND_SCHEMAS,
  type TerminalPluginCommand,
  type TerminalPluginPublicStatus,
} from "@soksak/soksak-contract-plugin-terminal";
import { createProviderFramePresenter, type ProviderFrame } from "./provider-frame-presenter";
import { createTerminalSessionBinding, type TerminalSessionHost } from "./terminal-session-binding";
import { createTerminalStatusController } from "./terminal-status-publication";
import {
  closedTerminalPresentation,
  createTerminalPresentationStatus,
} from "./terminal-presentation-status";
import { waitForTerminalConditions } from "./terminal-condition-wait";
import { waitForTerminalSize } from "./terminal-size-wait";
import { createTerminalResizeWorker } from "./terminal-resize-worker";
import { terminalResizeStatus } from "./terminal-resize-status";
import { observeTerminalLayout, type TerminalLayoutEvents } from "./terminal-layout-observer";

interface ViewContext {
  viewId?: string | null;
  setStatus?: (status: { code: string; message?: string } | null) => void;
}

export interface ProviderTerminalPluginHost extends TerminalSessionHost {
  locale?(): string;
  events?: TerminalLayoutEvents & {
    on(event: "window.gone", callback: (payload: { windowLabel?: string }) => void): { dispose(): void };
  };
  ui: {
    registerView(id: string, provider: {
      mount(container: HTMLElement, context: ViewContext): void;
      unmount?(container: HTMLElement): void;
      focus?(container: HTMLElement, context: ViewContext, request: { signal: AbortSignal }): void;
    }): { dispose(): void };
    statusBarItem?(item: {
      id: string; paneId: string; label: string; title?: string; side?: "left" | "right";
    }): { dispose(): void };
  };
  commands: {
    register(name: string, spec: Record<string, unknown>): { dispose(): void } | void;
    execute?(name: string, params?: Record<string, unknown>): Promise<unknown>;
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

export interface ProviderTerminalPluginConfig {
  pluginId: string;
  engineId: string;
  ptySidecarId: string;
  terminalSidecarId: string;
  programId: string;
  renderer?: TerminalRendererAdapter;
  extensions?: TerminalCommandExtension[];
  label?: { en: string; ko: string };
}

export interface TerminalPresenter {
  root: HTMLElement;
  size(): { cols: number; rows: number };
  measure?(): { cols: number; rows: number };
  fit?(): void;
  renderFrame?(frame: ProviderFrame): void;
  applySnapshot?(snapshot: Record<string, unknown>, archived: boolean): Promise<void> | void;
  writeOutput?(bytes: Uint8Array): Promise<void>;
  read(lines?: number): string;
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  focus(): boolean;
  prepareFocusTransfer?(): void;
  refresh?(): void;
  dispose(): void;
}

export interface TerminalRendererAdapter {
  delivery: "frames" | "bytes";
  rendererId: string;
  rendererProfile?: "web" | "native-surface";
  create(container: HTMLElement, pane: string, send: (text: string) => void): TerminalPresenter;
}

export interface TerminalCommandExtension {
  name: string;
  params: Record<string, unknown>;
  danger?: "inject";
  handler(params: Record<string, unknown>, screen: {
    pane: string; presenter: TerminalPresenter; writable: boolean; send(data: string): void;
  } | undefined): unknown;
}

interface MountedScreen {
  pane: string;
  presenter: TerminalPresenter;
  session: number;
  status: ReturnType<typeof createTerminalStatusController>;
  presentation: ReturnType<typeof createTerminalPresentationStatus>;
  requestedSize: { cols: number; rows: number } | null;
  renderedOutputSequence: number | null;
  writable: boolean;
  stop(): Promise<void>;
}

const viewParam = { type: "string", description: { en: "Terminal view id", ko: "터미널 뷰 ID" } };

export function activateProviderTerminalPlugin(
  host: ProviderTerminalPluginHost,
  subscriptions: { dispose(): void }[],
  config: ProviderTerminalPluginConfig,
): void {
  const screens = new Map<string, MountedScreen>();
  const stopBarriers = new Map<string, Promise<void>>();
  const binding = createTerminalSessionBinding(host, {
    ptySidecarId: config.ptySidecarId,
    terminalSidecarId: config.terminalSidecarId,
    onOperation(operation) {
      for (const screen of screens.values()) {
        screen.presenter.root.dataset.terminalOperation = operation;
      }
    },
  });
  const windowGone = host.events?.on("window.gone", (payload?: { windowLabel?: string }) => {
    const windowLabel = payload?.windowLabel;
    if (typeof windowLabel === "string" && windowLabel !== "") void binding.closeWindow(windowLabel);
  });
  if (windowGone) subscriptions.push(windowGone);

  const register = (
    name: string,
    params: Record<string, unknown>,
    handler: (params: Record<string, unknown>, context?: { pane?: string }) => unknown,
    danger?: "inject",
  ) => {
    const description = {
      en: `${config.engineId} terminal ${name}`,
      ko: `${config.engineId} 터미널 ${name}`,
    };
    const schema = TERMINAL_PLUGIN_COMMAND_SCHEMAS[name as TerminalPluginCommand];
    const disposable = host.commands.register(name, {
      description, params, returns: "{}", message: () => description, handler,
      ...(schema?.danger === "inject" || danger === "inject" ? { danger: "inject" } : {}),
    });
    if (disposable) subscriptions.push(disposable);
  };

  const target = (params: Record<string, unknown>, context?: { pane?: string }): MountedScreen | undefined => {
    if (typeof params.view === "string") return screens.get(params.view);
    if (typeof context?.pane === "string") {
      const contextual = screens.get(context.pane);
      if (contextual) return contextual;
    }
    if (screens.size === 1) return screens.values().next().value;
    return undefined;
  };

  const view = {
    mount(container: HTMLElement, context: ViewContext) {
      const pane = context.viewId ?? "";
      if (!pane) throw new Error("terminal view requires a view id");
      const readyToStart = screens.get(pane)?.stop() ?? stopBarriers.get(pane) ?? Promise.resolve();

      let session = 0;
      let stopped = false;
      let output: { dispose(): void } | undefined;
      let io: { dispose(): void } | undefined;
      let requestedSequence = 0;
      let renderedSequence: number | null = null;
      let rendering = false;
      let writable = false;
      let requestedSize: { cols: number; rows: number } | null = null;
      let startTask = Promise.resolve();
      let stopping: Promise<void> | null = null;
      let presentation: ReturnType<typeof createTerminalPresentationStatus>;
      let status: ReturnType<typeof createTerminalStatusController>;
      const writeToPty = (text: string, acceptedInput: boolean) => {
        if (acceptedInput) {
          presentation.markInputAccepted();
          status?.refresh();
        }
        if (!writable || !session) return;
        void binding.write(session, text).then(() => {
          presentation.markPtyWrite();
          status.refresh();
        });
      };
      const framePresenter = config.renderer
        ? undefined
        : createProviderFramePresenter(container, (text) => writeToPty(text, true));
      const presenter: TerminalPresenter = config.renderer
        ? config.renderer.create(container, pane, (text) => writeToPty(text, true))
        : {
            ...framePresenter!,
            renderFrame: (frame) => framePresenter!.render(frame),
          };
      presentation = createTerminalPresentationStatus(
        container,
        config.renderer?.delivery === "bytes" ? "bytes" : "frame",
      );
      if (config.renderer?.delivery === "bytes" && (!presenter.writeOutput || !presenter.applySnapshot)) {
        throw new Error("byte renderer requires output and snapshot completion contracts");
      }
      const terminalSize = () => {
        presenter.fit?.();
        const measured = presenter.measure?.() ?? presenter.size();
        if (measured.cols > 0 && measured.rows > 0) return measured;
        return {
          cols: Math.max(1, Math.floor(container.clientWidth / 8)),
          rows: Math.max(1, Math.floor(container.clientHeight / 16)),
        };
      };
      status = createTerminalStatusController({
        root: container,
        pluginId: config.pluginId,
        engineId: config.engineId,
        rendererId: config.renderer?.rendererId ?? `${config.engineId}-frame`,
        rendererProfile: config.renderer?.rendererProfile ?? "web",
        publish(value) {
          context.setStatus?.(value.failure ? {
            code: value.failure.code, message: value.failure.message,
          } : null);
        },
        presentation: presentation.current,
      });
      const focusChanged = (event: FocusEvent) => {
        const node = event.target instanceof HTMLElement ? event.target.dataset.node : undefined;
        if (node !== "terminal-input") return;
        presentation.markFocused(event.type === "focusin");
        status.refresh();
      };
      container.addEventListener("focusin", focusChanged);
      container.addEventListener("focusout", focusChanged);

      const markRendered = (startedAt: number) => {
        presentation.markRendered(Math.max(0, performance.now() - startedAt));
        status.refresh();
      };

      const applyFrame = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        const startedAt = performance.now();
        presenter.renderFrame?.(value as ProviderFrame);
        markRendered(startedAt);
        return true;
      };
      const applyFrameSnapshot = (value: Record<string, unknown>): boolean => {
        const outputSequence = Number(value.outputSequence);
        if (!Number.isSafeInteger(outputSequence) || outputSequence < 0 || !applyFrame(value.frame)) return false;
        renderedSequence = outputSequence;
        return true;
      };
      const requireReply = (reply: Record<string, unknown>, operation: string) => {
        if (reply.ok !== true) {
          const code = typeof reply.code === "string" ? reply.code : "FAILED";
          const message = typeof reply.message === "string" ? reply.message : "request failed";
          throw new Error(`${operation} failed (${code}): ${message}`);
        }
        return reply.data && typeof reply.data === "object"
          ? reply.data as Record<string, unknown> : {};
      };
      const renderLatest = async (): Promise<void> => {
        if (rendering || stopped || requestedSequence <= (renderedSequence ?? -1)) return;
        rendering = true;
        try {
          while (!stopped && requestedSequence > (renderedSequence ?? -1)) {
            const sequence = requestedSequence;
            if (config.renderer?.delivery === "bytes") break;
            const response = await binding.recoveryRequest({ op: "frame", pane, afterSequence: sequence });
            if (!applyFrameSnapshot(requireReply(response, "frame"))) {
              throw new Error("frame response has no exact output sequence");
            }
          }
        } finally {
          rendering = false;
        }
      };
      const resizeSession = async () => {
        if (!session || container.clientWidth <= 0 || container.clientHeight <= 0) return;
        const { cols, rows } = terminalSize();
        await binding.resize(session, cols, rows);
        requestedSize = { cols, rows };
        const observed = requireReply(await binding.recoveryRequest({ op: "waitSize", pane, cols, rows, timeoutMs: 8000 }), "waitSize");
        if (stopped) return;
        if (config.renderer?.delivery !== "bytes" && !applyFrameSnapshot(requireReply(await binding.recoveryRequest({ op: "frame", pane }), "frame"))) {
          throw new Error("resize frame is invalid");
        }
        container.dispatchEvent(new CustomEvent("soksak:terminal-size", { detail: observed }));
      };
      const reportResizeFailure = (error: unknown) => {
        if (stopped) return;
        status.set("blocked", {
          failure: { code: "RESIZE_FAILED", message: String(error) }, fidelity: "unavailable",
        });
      };
      const reportFrameFailure = (error: unknown) => {
        if (stopped) return;
        status.set("blocked", {
          failure: { code: "FRAME_FAILED", message: String(error) }, fidelity: "unavailable",
        });
      };
      const resizeWorker = createTerminalResizeWorker(resizeSession, reportResizeFailure);
      const requestResize = () => resizeWorker.request();
      const attach = (opened: number) => {
        session = opened;
        output = binding.onData(session, (bytes, throughSeq) => {
          if (config.renderer?.delivery === "bytes") {
            const startedAt = performance.now();
            void presenter.writeOutput!(bytes).then(() => {
              renderedSequence = Math.max(renderedSequence ?? 0, throughSeq);
              markRendered(startedAt);
            }).catch(reportFrameFailure);
            return;
          }
          requestedSequence = Math.max(requestedSequence, throughSeq);
          void renderLatest().catch(reportFrameFailure);
        });
        writable = true;
        io = host.terminal?.registerIo?.(pane, {
          readBuffer: (lines) => presenter.read(lines),
          sendInput: (data) => writeToPty(data, false),
        });
        requestResize();
      };
      const detachIfStopped = async (opened: number): Promise<boolean> => {
        if (!stopped) return false;
        await binding.detach(opened);
        return true;
      };
      const startFresh = async () => {
        container.dataset.terminalOperation = "preparing-observer";
        const prepared = requireReply(await binding.recoveryRequest({
          op: "prepareSession", pane, cols: 80, rows: 24,
        }), "prepareSession");
        if (stopped) return;
        const token = typeof prepared.observerToken === "string"
          ? prepared.observerToken : "";
        if (!token) throw new Error("prepareSession returned no observer token");
        container.dataset.terminalOperation = "opening-pty";
        const opened = await binding.open(pane, 80, 24, "none", token);
        if (await detachIfStopped(opened)) return;
        requestedSize = { cols: 80, rows: 24 };
        container.dataset.terminalOperation = "subscribing-recovery";
        requireReply(await binding.recoveryRequest({
          op: "ensureSession", pane, cols: 80, rows: 24, observerToken: token,
        }), "ensureSession");
        if (await detachIfStopped(opened)) return;
        attach(opened);
        container.dataset.terminalOperation = "ready";
        presentation.markReady();
        status.refresh();
        status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
      };
      const startWarm = async () => {
        container.dataset.terminalOperation = "subscribing-recovery";
        requireReply(await binding.recoveryRequest({
          op: "ensureSession", pane, cols: 80, rows: 24,
        }), "ensureSession");
        if (stopped) return;
        const restored = requireReply(await binding.recoveryRequest({
          op: "rehydrate", pane,
        }), "rehydrate");
        if (stopped) return;
        const leaseToken = typeof restored.leaseToken === "string"
          ? restored.leaseToken : "";
        if (!leaseToken || (config.renderer?.delivery === "bytes"
          ? !presenter.applySnapshot
          : !applyFrame(restored.frame))) {
          throw new Error("rehydrate returned no frame or snapshot lease");
        }
        if (config.renderer?.delivery === "bytes") {
          const startedAt = performance.now();
          await presenter.applySnapshot!(restored, false);
          markRendered(startedAt);
        }
        const restoredSequence = Number(restored.uptoSeq);
        if (!Number.isSafeInteger(restoredSequence) || restoredSequence < 0) {
          throw new Error("rehydrate returned no exact output sequence");
        }
        renderedSequence = restoredSequence;
        status.set("applying-snapshot", {
          recoveryOutcome: "continued", fidelity: "complete",
        });
        container.dataset.terminalOperation = "attaching-snapshot-lease";
        const opened = await binding.open(pane, 80, 24, { leaseToken });
        if (await detachIfStopped(opened)) return;
        requestedSize = { cols: 80, rows: 24 };
        attach(opened);
        container.dataset.terminalOperation = "ready";
        presentation.markReady();
        status.refresh();
        status.set("live", { recoveryOutcome: "continued", fidelity: "complete" });
      };
      const startArchived = async (): Promise<boolean> => {
        container.dataset.terminalOperation = "checking-archive";
        const archived = await binding.recoveryRequest({ op: "archived", pane });
        if (stopped) return true;
        if (archived.ok !== true) {
          if (archived.code === "NOT_FOUND") return false;
          requireReply(archived, "archived");
        }
        const data = requireReply(archived, "archived");
        if (config.renderer?.delivery === "bytes") {
          if (!presenter.applySnapshot) throw new Error("byte presenter cannot restore snapshots");
          const startedAt = performance.now();
          await presenter.applySnapshot(data, true);
          markRendered(startedAt);
        } else if (!applyFrame(data.frame)) throw new Error("archived returned no frame");
        const archivedSequence = Number(data.uptoSeq);
        if (!Number.isSafeInteger(archivedSequence) || archivedSequence < 0) {
          throw new Error("archived returned no exact output sequence");
        }
        renderedSequence = archivedSequence;
        writable = false;
        container.dataset.terminalOperation = "ready";
        presentation.markReady();
        status.refresh();
        status.set("archived", {
          recoveryOutcome: "archived", fidelity: "complete",
        });
        return true;
      };
      const start = async () => {
        status.set("preparing-recovery");
        container.dataset.terminalOperation = "checking-live";
        const alive = await binding.paneAlive(pane);
        if (stopped) return;
        if (alive) await startWarm();
        else if (!await startArchived() && !stopped) await startFresh();
      };

      const resize = observeTerminalLayout({ element: container, resized: requestResize, events: host.events });
      const capturePrepare = () => presenter.refresh?.();
      window.addEventListener("soksak:capture-prepare", capturePrepare);
      const viewDisposables: { dispose(): void }[] = [];
      const entry: MountedScreen = {
        pane,
        presenter,
        get session() { return session; },
        status,
        presentation,
        get requestedSize() { return requestedSize; },
        get renderedOutputSequence() { return renderedSequence; },
        get writable() { return writable; },
        stop() {
          if (stopping) return stopping;
          stopped = true;
          writable = false;
          resize.dispose();
          container.removeEventListener("focusin", focusChanged);
          container.removeEventListener("focusout", focusChanged);
          window.removeEventListener("soksak:capture-prepare", capturePrepare);
          output?.dispose();
          io?.dispose();
          viewDisposables.splice(0).forEach((item) => item.dispose());
          const attached = session;
          session = 0;
          status.close();
          presenter.dispose();
          stopping = (async () => {
            if (attached) await binding.detach(attached);
            await startTask.catch(() => {});
          })();
          stopBarriers.set(pane, stopping);
          void stopping.finally(() => {
            if (stopBarriers.get(pane) === stopping) stopBarriers.delete(pane);
          });
          return stopping;
        },
      };
      screens.set(pane, entry);
      startTask = readyToStart.then(async () => {
        if (!stopped) await start();
      });
      void startTask.catch((error) => {
        if (!stopped) status.set("blocked", {
          failure: { code: "START_FAILED", message: String(error) },
          fidelity: "unavailable", recoveryOutcome: "blocked",
        });
      });
      if (host.ui.statusBarItem) {
        const locale = host.locale?.() ?? "en";
        const label = locale.startsWith("ko") ? config.label?.ko : config.label?.en;
        let cwdItem: { dispose(): void } | undefined;
        const placeCwd = (cwd?: string) => {
          cwdItem?.dispose();
          const item = host.ui.statusBarItem?.({ id: `cwd:${pane}`, paneId: pane, label: cwd ?? "~", title: cwd, side: "left" });
          cwdItem = item;
        };
        placeCwd(host.terminal?.getCwd?.(pane));
        const cwd = host.terminal?.onCwd?.(pane, placeCwd);
        if (cwd) viewDisposables.push(cwd);
        viewDisposables.push({ dispose: () => cwdItem?.dispose() });
        if (label) {
          const kind = host.ui.statusBarItem({ id: `kind:${pane}`, paneId: pane, label });
          viewDisposables.push(kind);
        }
      }
    },
    unmount(container: HTMLElement) {
      const found = [...screens.entries()].find(([, value]) => value.presenter.root === container);
      if (!found) return;
      void found[1].stop();
      screens.delete(found[0]);
    },
    prepareFocusTransfer(container: HTMLElement) {
      const found = [...screens.values()].find((screen) => screen.presenter.root === container);
      found?.presenter.prepareFocusTransfer?.();
    },
    focus(container: HTMLElement, _context: ViewContext, request: { signal: AbortSignal }) {
      if (request.signal.aborted) return;
      const found = [...screens.values()].find((screen) => screen.presenter.root === container);
      found?.presenter.focus();
    },
  };
  subscriptions.push(host.ui.registerView("content", view));

  const closedStatus = (): TerminalPluginPublicStatus => ({
      pluginId: config.pluginId, engineId: config.engineId,
      rendererId: config.renderer?.rendererId ?? `${config.engineId}-frame`,
      rendererProfile: config.renderer?.rendererProfile ?? "web",
      phase: "closed", recoveryOutcome: "blocked", fidelity: "unavailable",
      failure: null, hostPixels: { width: 0, height: 0 }, requested: null, pty: null,
      recovery: null, rendered: null, operation: "closed",
      presentation: closedTerminalPresentation(
        config.renderer?.delivery === "bytes" ? "bytes" : "frame",
      ),
  });
  register("status", { view: viewParam }, async (params, context) => {
    const screen = target(params, context);
    if (!screen) return closedStatus();
    const rendered = screen.presenter.size();
    return {
      ...screen.status.current(),
      ...terminalResizeStatus({
        pane: screen.pane, session: screen.session,
        hostPixels: { width: screen.presenter.root.clientWidth, height: screen.presenter.root.clientHeight },
        requested: screen.requestedSize, rendered: rendered.cols > 0 && rendered.rows > 0 ? rendered : null,
        renderedOutputSequence: screen.renderedOutputSequence,
        operation: screen.presenter.root.dataset.terminalOperation ?? "unknown",
        diagnostics: await binding.diagnostics(),
      }),
    };
  });
  register("archive", { view: viewParam }, async (params, context) => {
    const screen = target(params, context);
    if (!screen) return { archived: false };
    const response = await binding.recoveryRequest({ op: "archive", pane: screen.pane });
    return response.ok === true ? { archived: true, ...(response.data as object) } : response;
  });
  register("wait", {
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
    view: viewParam,
  }, async (params, context) => {
    const screen = target(params, context);
    if (!screen) return closedStatus();
    const phase = String(params.phase) as TerminalPluginPublicStatus["phase"];
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 10000;
    const waited = await waitForTerminalConditions({
      status: screen.status, phase,
      contains: typeof params.contains === "string" && params.contains !== ""
        ? params.contains : undefined,
      timeoutMs, waitForText: screen.presenter.waitForText,
      size: {
        ...(typeof params.cols === "number" ? { cols: params.cols } : {}),
        ...(typeof params.colsLessThan === "number" ? { colsLessThan: params.colsLessThan } : {}),
        ...(typeof params.colsGreaterThan === "number" ? { colsGreaterThan: params.colsGreaterThan } : {}),
        ...(typeof params.rows === "number" ? { rows: params.rows } : {}),
      },
      waitForSize: (condition, limit) => waitForTerminalSize(
        screen.presenter.root, condition, limit, screen.presenter.size,
      ),
    });
    return {
      ...waited, ...screen.presenter.size(),
      operation: screen.presenter.root.dataset.terminalOperation ?? "unknown",
    };
  });
  register("read", {
    lines: { type: "number", description: { en: "Trailing line count", ko: "마지막 줄 수" } },
    view: viewParam,
  }, (params, context) => ({
    text: target(params, context)?.presenter.read(
      typeof params.lines === "number" ? params.lines : undefined,
    ) ?? "",
  }));
  register("send", {
    data: { type: "string", required: true, description: { en: "Input data", ko: "입력 데이터" } },
    view: viewParam,
  }, (params, context) => {
    const screen = target(params, context);
    if (!screen?.writable || typeof params.data !== "string") {
      return { sent: false };
    }
    void binding.write(screen.session, params.data).then(() => {
      screen.presentation.markPtyWrite();
      screen.status.refresh();
    });
    return { sent: params.data.length };
  });
  register("clear", { view: viewParam }, (params, context) => {
    const screen = target(params, context);
    if (!screen?.writable) return { cleared: false };
    void binding.write(screen.session, "\x0c");
    return { cleared: true };
  });
  register("focus", { view: viewParam }, (params, context) => ({
    focused: target(params, context)?.presenter.focus() ?? false,
  }));
  register("recovery-status", { view: viewParam }, async (params, context) => {
    const screen = target(params, context);
    if (!screen) return closedStatus();
    const rendered = screen.presenter.size();
    return {
      ...screen.status.current(),
      ...terminalResizeStatus({
        pane: screen.pane, session: screen.session,
        hostPixels: { width: screen.presenter.root.clientWidth, height: screen.presenter.root.clientHeight },
        requested: screen.requestedSize, rendered: rendered.cols > 0 && rendered.rows > 0 ? rendered : null,
        renderedOutputSequence: screen.renderedOutputSequence,
        operation: screen.presenter.root.dataset.terminalOperation ?? "unknown",
        diagnostics: await binding.diagnostics(),
      }),
    };
  });
  for (const extension of config.extensions ?? []) {
    if ((TERMINAL_PLUGIN_COMMANDS as readonly string[]).includes(extension.name)) {
      throw new Error(`terminal extension cannot replace standard command ${extension.name}`);
    }
    register(extension.name, extension.params, (params, context) => {
      const screen = target(params, context);
      return extension.handler(params, screen ? {
        pane: screen.pane, presenter: screen.presenter,
        writable: screen.writable,
        send: (data) => { void binding.write(screen.session, data); },
      } : undefined);
    }, extension.danger);
  }
}
