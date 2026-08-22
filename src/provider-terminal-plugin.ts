import {
  TERMINAL_PLUGIN_COMMAND_SCHEMAS,
  type TerminalPluginCommand,
  type TerminalPluginPublicStatus,
} from "@soksak/soksak-contract-plugin-terminal";
import { createProviderFramePresenter, type ProviderFrame } from "./provider-frame-presenter";
import { createTerminalSessionBinding, type TerminalSessionHost } from "./terminal-session-binding";
import { createTerminalStatusController } from "./terminal-status-publication";
import { waitForTerminalConditions } from "./terminal-condition-wait";
import { waitForTerminalSize } from "./terminal-size-wait";
import { createTerminalResizeWorker } from "./terminal-resize-worker";
import { terminalResizeStatus } from "./terminal-resize-status";

interface ViewContext {
  viewId?: string | null;
  setStatus?: (status: { code: string; message?: string } | null) => void;
}

export interface ProviderTerminalPluginHost extends TerminalSessionHost {
  ui: {
    registerView(id: string, provider: {
      mount(container: HTMLElement, context: ViewContext): void;
      unmount?(container: HTMLElement): void;
      focus?(container: HTMLElement, context: ViewContext, request: { signal: AbortSignal }): void;
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
  };
}

export interface ProviderTerminalPluginConfig {
  pluginId: string;
  engineId: string;
  providerSidecar: string;
  programId: string;
}

interface MountedScreen {
  pane: string;
  presenter: ReturnType<typeof createProviderFramePresenter>;
  session: number;
  status: ReturnType<typeof createTerminalStatusController>;
  requestedSize: { cols: number; rows: number } | null;
  stop(): void;
}

const viewParam = { type: "string", description: { en: "Terminal view id", ko: "터미널 뷰 ID" } };

export function activateProviderTerminalPlugin(
  host: ProviderTerminalPluginHost,
  subscriptions: { dispose(): void }[],
  config: ProviderTerminalPluginConfig,
): void {
  const screens = new Map<string, MountedScreen>();
  const binding = createTerminalSessionBinding(host, {
    ptySidecar: "pty",
    providerSidecar: config.providerSidecar,
    onOperation(operation) {
      for (const screen of screens.values()) {
        screen.presenter.root.dataset.terminalOperation = operation;
      }
    },
  });

  const register = (
    name: string,
    params: Record<string, unknown>,
    handler: (params: Record<string, unknown>) => unknown,
  ) => {
    const description = {
      en: `${config.engineId} terminal ${name}`,
      ko: `${config.engineId} 터미널 ${name}`,
    };
    const schema = TERMINAL_PLUGIN_COMMAND_SCHEMAS[name as TerminalPluginCommand];
    const disposable = host.commands.register(name, {
      description, params, returns: "{}", message: () => description, handler,
      ...(schema?.danger === "inject" ? { danger: "inject" } : {}),
    });
    if (disposable) subscriptions.push(disposable);
  };

  const target = (params: Record<string, unknown>): MountedScreen | undefined => {
    if (typeof params.view === "string") return screens.get(params.view);
    if (screens.size === 1) return screens.values().next().value;
    return undefined;
  };

  const view = {
    mount(container: HTMLElement, context: ViewContext) {
      const pane = context.viewId ?? "";
      if (!pane) throw new Error("terminal view requires a view id");

      let session = 0;
      let stopped = false;
      let output: { dispose(): void } | undefined;
      let io: { dispose(): void } | undefined;
      let requestedSequence = 0;
      let renderedSequence = 0;
      let rendering = false;
      let writable = false;
      let requestedSize: { cols: number; rows: number } | null = null;
      const terminalSize = () => ({
        cols: Math.max(1, Math.floor(container.clientWidth / 8)),
        rows: Math.max(1, Math.floor(container.clientHeight / 16)),
      });
      const presenter = createProviderFramePresenter(container, (text) => {
        if (writable && session) void binding.write(session, text);
      });
      const status = createTerminalStatusController({
        root: container,
        pluginId: config.pluginId,
        engineId: config.engineId,
        rendererId: `${config.engineId}-frame`,
        rendererProfile: "web",
        publish(value) {
          context.setStatus?.(value.failure ? {
            code: value.failure.code, message: value.failure.message,
          } : null);
        },
      });

      const applyFrame = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        presenter.render(value as ProviderFrame);
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
        if (rendering || stopped || requestedSequence <= renderedSequence) return;
        rendering = true;
        try {
          while (!stopped && requestedSequence > renderedSequence) {
            const sequence = requestedSequence;
            const response = await binding.providerRequest({
              op: "frame", pane, afterSequence: sequence,
            });
            applyFrame(requireReply(response, "frame"));
            renderedSequence = sequence;
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
        const observed = requireReply(await binding.providerRequest({
          op: "waitSize", pane, cols, rows, timeoutMs: 8000,
        }), "waitSize");
        if (stopped) return;
        if (!applyFrame(requireReply(await binding.providerRequest({ op: "frame", pane }), "frame"))) {
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
      const resizeWorker = createTerminalResizeWorker(resizeSession, reportResizeFailure);
      const requestResize = () => resizeWorker.request();
      const attach = (opened: number) => {
        session = opened;
        output = binding.onData(session, (_bytes, throughSeq) => {
          requestedSequence = Math.max(requestedSequence, throughSeq);
          void renderLatest();
        });
        writable = true;
        io = host.terminal?.registerIo?.(pane, {
          readBuffer: (lines) => presenter.read(lines),
          sendInput: (data) => { if (writable && session) void binding.write(session, data); },
        });
        requestResize();
      };
      const startFresh = async () => {
        container.dataset.terminalOperation = "preparing-observer";
        const prepared = requireReply(await binding.providerRequest({
          op: "prepareSession", pane, cols: 80, rows: 24,
        }), "prepareSession");
        const token = typeof prepared.observerToken === "string"
          ? prepared.observerToken : "";
        if (!token) throw new Error("prepareSession returned no observer token");
        container.dataset.terminalOperation = "opening-pty";
        const opened = await binding.open(pane, 80, 24, "none", token);
        requestedSize = { cols: 80, rows: 24 };
        container.dataset.terminalOperation = "subscribing-provider";
        requireReply(await binding.providerRequest({
          op: "ensureSession", pane, cols: 80, rows: 24, observerToken: token,
        }), "ensureSession");
        attach(opened);
        container.dataset.terminalOperation = "ready";
        status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
      };
      const startWarm = async () => {
        container.dataset.terminalOperation = "subscribing-provider";
        requireReply(await binding.providerRequest({
          op: "ensureSession", pane, cols: 80, rows: 24,
        }), "ensureSession");
        const restored = requireReply(await binding.providerRequest({
          op: "rehydrate", pane,
        }), "rehydrate");
        const leaseToken = typeof restored.leaseToken === "string"
          ? restored.leaseToken : "";
        if (!leaseToken || !applyFrame(restored.frame)) {
          throw new Error("rehydrate returned no frame or snapshot lease");
        }
        status.set("applying-snapshot", {
          recoveryOutcome: "continued", fidelity: "complete",
        });
        container.dataset.terminalOperation = "attaching-snapshot-lease";
        const opened = await binding.open(pane, 80, 24, { leaseToken });
        requestedSize = { cols: 80, rows: 24 };
        attach(opened);
        container.dataset.terminalOperation = "ready";
        status.set("live", { recoveryOutcome: "continued", fidelity: "complete" });
      };
      const startArchived = async (): Promise<boolean> => {
        container.dataset.terminalOperation = "checking-archive";
        const archived = await binding.providerRequest({ op: "archived", pane });
        if (archived.ok !== true) {
          if (archived.code === "NOT_FOUND") return false;
          requireReply(archived, "archived");
        }
        const data = requireReply(archived, "archived");
        if (!applyFrame(data.frame)) throw new Error("archived returned no frame");
        writable = false;
        container.dataset.terminalOperation = "ready";
        status.set("archived", {
          recoveryOutcome: "archived", fidelity: "complete",
        });
        return true;
      };
      const start = async () => {
        status.set("preparing-recovery");
        container.dataset.terminalOperation = "checking-live";
        if (await binding.paneAlive(pane)) await startWarm();
        else if (!await startArchived()) await startFresh();
      };

      const resize = new ResizeObserver(requestResize);
      resize.observe(container);
      void start().catch((error) => status.set("blocked", {
        failure: { code: "START_FAILED", message: String(error) },
        fidelity: "unavailable", recoveryOutcome: "blocked",
      }));

      const entry: MountedScreen = {
        pane,
        presenter,
        get session() { return session; },
        status,
        get requestedSize() { return requestedSize; },
        stop() {
          stopped = true;
          writable = false;
          resize.disconnect();
          output?.dispose();
          io?.dispose();
          if (session) binding.detach(session);
          status.close();
          presenter.dispose();
        },
      };
      screens.set(pane, entry);
    },
    unmount(container: HTMLElement) {
      const found = [...screens.entries()].find(([, value]) => value.presenter.root === container);
      if (!found) return;
      found[1].stop();
      screens.delete(found[0]);
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
      rendererId: `${config.engineId}-frame`, rendererProfile: "web",
      phase: "closed", recoveryOutcome: "blocked", fidelity: "unavailable",
      failure: null, hostPixels: { width: 0, height: 0 }, requested: null, pty: null,
      recovery: null, rendered: null, operation: "closed",
  });
  register("status", { view: viewParam }, async (params) => {
    const screen = target(params);
    if (!screen) return closedStatus();
    const rendered = screen.presenter.size();
    return {
      ...screen.status.current(),
      ...terminalResizeStatus({
        pane: screen.pane, session: screen.session,
        hostPixels: { width: screen.presenter.root.clientWidth, height: screen.presenter.root.clientHeight },
        requested: screen.requestedSize, rendered: rendered.cols > 0 && rendered.rows > 0 ? rendered : null,
        operation: screen.presenter.root.dataset.terminalOperation ?? "unknown",
        diagnostics: await binding.diagnostics(),
      }),
    };
  });
  register("archive", { view: viewParam }, async (params) => {
    const screen = target(params);
    if (!screen) return { archived: false };
    const response = await binding.providerRequest({ op: "archive", pane: String(params.view) });
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
    rows: { type: "number", description: { en: "Exact terminal rows", ko: "정확한 터미널 행 수" } },
    view: viewParam,
  }, async (params) => {
    const screen = target(params);
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
  }, (params) => ({
    text: target(params)?.presenter.read(
      typeof params.lines === "number" ? params.lines : undefined,
    ) ?? "",
  }));
  register("send", {
    data: { type: "string", required: true, description: { en: "Input data", ko: "입력 데이터" } },
    view: viewParam,
  }, (params) => {
    const screen = target(params);
    if (!screen || screen.status.current().phase === "archived" || typeof params.data !== "string") {
      return { sent: false };
    }
    void binding.write(screen.session, params.data);
    return { sent: params.data.length };
  });
  register("clear", { view: viewParam }, (params) => {
    const screen = target(params);
    if (!screen || screen.status.current().phase === "archived") return { cleared: false };
    void binding.write(screen.session, "\x0c");
    return { cleared: true };
  });
  register("focus", { view: viewParam }, (params) => ({
    focused: target(params)?.presenter.focus() ?? false,
  }));
  register("recovery-status", { view: viewParam }, async (params) => {
    const screen = target(params);
    if (!screen) return closedStatus();
    const rendered = screen.presenter.size();
    return {
      ...screen.status.current(),
      ...terminalResizeStatus({
        pane: screen.pane, session: screen.session,
        hostPixels: { width: screen.presenter.root.clientWidth, height: screen.presenter.root.clientHeight },
        requested: screen.requestedSize, rendered: rendered.cols > 0 && rendered.rows > 0 ? rendered : null,
        operation: screen.presenter.root.dataset.terminalOperation ?? "unknown",
        diagnostics: await binding.diagnostics(),
      }),
    };
  });
}
