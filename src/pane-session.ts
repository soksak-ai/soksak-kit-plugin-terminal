import type { TerminalPluginPublicStatus } from "@soksak/soksak-contract-plugin-terminal";
import { createProviderFramePresenter, type ProviderFrame } from "./provider-frame-presenter";
import type { TerminalSessionBinding } from "./terminal-session-binding";
import { createTerminalStatusController, type TerminalStatusController } from "./terminal-status-publication";
import {
  createTerminalPresentationStatus, terminalNodeId, type TerminalPresentationStatusController,
} from "./terminal-presentation-status";
import { createTerminalResizeWorker } from "./terminal-resize-worker";
import { readTerminalTheme } from "./terminal-theme";

export interface TerminalPresenter {
  root: HTMLElement;
  size(): { cols: number; rows: number };
  measure?(): { cols: number; rows: number };
  metrics?(): { cellWidth: number; cellHeight: number } | null;
  fit?(): void;
  renderFrame?(frame: ProviderFrame): void;
  applySnapshot?(snapshot: Record<string, unknown>, archived: boolean): Promise<void> | void;
  writeOutput?(bytes: Uint8Array): Promise<void>;
  onRendered?(callback: (durationMs: number) => void): { dispose(): void };
  read(lines?: number): string;
  selection?(): string;
  compose?(updates: string[], data: string): number;
  waitForText(contains: string, timeoutMs: number): Promise<string>;
  focus(): boolean;
  prepareFocusTransfer?(): void;
  refresh?(): void;
  // A renderer that owns its own scrollback answers where it is and moves on request. offset counts
  // rows back into history, as the terminal contract declares it.
  scrollState?(): { offset: number; historySize: number };
  scrollLines?(lines: number): void;
  scrollTo?(offset: number): void;
  dispose(): void;
}

export interface TerminalRendererAdapter {
  delivery: "frames" | "bytes";
  rendererId: string;
  rendererProfile?: "web" | "native-surface";
  // A renderer mounts inside one pane: options name the pane's nodes and its box.
  create(container: HTMLElement, pane: string, send: (text: string) => void, options: TerminalPresenterOptions): TerminalPresenter;
}

export interface TerminalPresenterOptions {
  nodeSuffix: string | null;
  hostPixels(): { width: number; height: number };
}
export type TerminalPresenterFactory = (
  root: HTMLElement, send: (text: string) => void, options: TerminalPresenterOptions,
) => TerminalPresenter;

export interface PaneSessionConfig {
  pluginId: string;
  // The plugin's own engine; the pane's engine may differ and names the renderer id.
  engineId: string;
  renderer?: TerminalRendererAdapter;
  presenter?: TerminalPresenterFactory;
}

export interface PaneScrollRequest { offset?: number; lines?: number; edge?: "top" | "bottom" }

export interface PaneSessionInput {
  key: string;
  viewId: string;
  engineId: string;
  binding: TerminalSessionBinding;
  root: HTMLElement;
  config: PaneSessionConfig;
  nodeSuffix: string | null;
  cwd?: string | null;
  title?: string | null;
  presenterFactory?: TerminalPresenterFactory;
  observe(bytes: Uint8Array): void;
  publish(status: TerminalPluginPublicStatus): void;
  hostPixels?(): { width: number; height: number };
  readyToStart?: Promise<void>;
  now?: () => number;
}

export interface PaneSession {
  readonly key: string;
  readonly viewId: string;
  readonly engineId: string;
  readonly root: HTMLElement;
  readonly binding: TerminalSessionBinding;
  readonly presenter: TerminalPresenter;
  readonly status: TerminalStatusController;
  readonly presentation: TerminalPresentationStatusController;
  readonly session: number;
  readonly writable: boolean;
  readonly requestedSize: { cols: number; rows: number } | null;
  readonly renderedOutputSequence: number | null;
  readonly offset: number;
  readonly historySize: number;
  readonly lastOutputAtUnixMs: number | null;
  title: string | null;
  hostPixels(): { width: number; height: number };
  write(data: string): Promise<void>;
  sendInput(data: string): void;
  onInput(listener: (text: string) => void): { dispose(): void };
  scroll(request: PaneScrollRequest): Promise<{ pane: string; offset: number; historySize: number }>;
  waitIdle(idleMs: number, timeoutMs: number): Promise<void>;
  lastCwdReport(): Uint8Array | null;
  cwd(): string | null;
  requestResize(): void;
  // A pane nobody can see is not painted: it keeps its session and its output and asks for a frame
  // again when it is shown.
  setShown(shown: boolean): void;
  // "detach" keeps the session for the pane to reattach to; "close" ends it with the pane.
  stop(intent?: "detach" | "close"): Promise<void>;
}

export const CALLER_PANE_ENV = "SOKSAK_CALLER_PANE";
const FRAME_TIMEOUT_MS = 2000;
const TAIL_BYTES = 4096;
const CWD_REPORT = /\x1b\]7;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export const defaultTerminalPresenterFactory: TerminalPresenterFactory = (root, send, options) => {
  const framed = createProviderFramePresenter(root, send, options);
  return { ...framed, renderFrame: (frame) => framed.render(frame) };
};

export function createPaneSession(input: PaneSessionInput): PaneSession {
  const { key, binding, root, config, nodeSuffix } = input;
  const now = input.now ?? Date.now;
  const document = root.ownerDocument;
  const hostPixels = input.hostPixels ?? (() => ({ width: root.clientWidth, height: root.clientHeight }));
  const bytesDelivery = config.renderer?.delivery === "bytes";
  let session = 0;
  let stopped = false;
  let output: { dispose(): void } | undefined;
  let outputEnd: { dispose(): void } | undefined;
  let requestedSequence = 0;
  let renderedSequence: number | null = null;
  let renderingTask: Promise<void> | null = null;
  let frameForced = false;
  // ReturnType<typeof setTimeout>: a consumer that type-checks this source with Node types sees Timeout, not number.
  let frameRequest: ReturnType<typeof setTimeout> | null = null;
  let byteFrameRequest: ReturnType<typeof setTimeout> | null = null;
  let writingOutput = false;
  let pendingOutput: Uint8Array[] = [];
  let pendingOutputSequence = 0;
  let writable = false;
  let requestedSize: { cols: number; rows: number } | null = null;
  let startTask = Promise.resolve();
  let writeQueue = Promise.resolve();
  let stopping: Promise<void> | null = null;
  let offset = 0;
  let historySize = 0;
  let title: string | null = input.title ?? null;
  let tail = new Uint8Array(0);
  const mountedAt = now();
  let lastOutputAt: number | null = null;
  const outputListeners = new Set<() => void>();
  const inputListeners = new Set<(text: string) => void>();
  let presentation: TerminalPresentationStatusController;
  let status: TerminalStatusController;

  const writeToPty = (text: string, acceptedInput: boolean): Promise<void> => {
    if (acceptedInput) {
      presentation.markInputAccepted();
      status?.refresh();
      for (const listener of inputListeners) listener(text);
    }
    // Input the pane cannot deliver is not input that quietly disappears. A pane with nothing behind
    // it says so and starts a session again; a pane that is still starting keeps its silence.
    if (!session) {
      const error = new Error(`pane ${key} has no session`);
      if (!stopped && status && status.current().phase === "live") {
        status.set("blocked", {
          failure: { code: "INPUT_WRITE_FAILED", message: error.message },
          fidelity: "unavailable",
        });
        restartSession();
      }
      return Promise.reject(error);
    }
    if (!writable) return Promise.reject(new Error(`pane ${key} is not writable`));
    const attached = session;
    const result = writeQueue.then(() => binding.write(attached, text)).then(() => {
      presentation.markPtyWrite();
      status.refresh();
    });
    writeQueue = result.catch((error) => {
      if (stopped) return;
      status?.set("blocked", {
        failure: { code: "INPUT_WRITE_FAILED", message: String(error) },
        fidelity: "unavailable",
      });
      // A write that failed has lost the input and the session with it. The pane starts one again
      // rather than standing blocked until something remounts it.
      restartSession();
    });
    return result;
  };
  const send = (text: string) => { void writeToPty(text, true).catch(() => {}); };
  const presenter: TerminalPresenter = config.renderer
    ? config.renderer.create(root, key, send, { nodeSuffix, hostPixels })
    : (input.presenterFactory ?? config.presenter ?? defaultTerminalPresenterFactory)(root, send, { nodeSuffix, hostPixels });
  // The pane owns the one notice inside it. It reads the failure the status carries and takes no
  // pointer events, so the terminal beneath keeps the mouse.
  const notice = document.createElement("div");
  notice.dataset.node = terminalNodeId("terminal-restore-status", nodeSuffix);
  notice.hidden = true;
  notice.setAttribute("role", "status");
  Object.assign(notice.style, {
    position: "absolute", top: "0", left: "0", right: "0", padding: "4px 8px",
    font: "12px/1.4 ui-monospace, monospace", pointerEvents: "none", zIndex: "1",
    background: "var(--card)", color: "var(--fg)",
  });
  if (!root.style.position) root.style.position = "relative";
  root.append(notice);
  presentation = createTerminalPresentationStatus(
    root, bytesDelivery ? "bytes" : "frame",
    () => readTerminalTheme(document.documentElement), now, nodeSuffix,
  );
  if (bytesDelivery && (!presenter.writeOutput || !presenter.applySnapshot || !presenter.onRendered)) {
    throw new Error("byte renderer requires parser and rendered-frame completion contracts");
  }
  const terminalSize = () => {
    presenter.fit?.();
    const measured = presenter.measure?.() ?? presenter.size();
    if (measured.cols > 0 && measured
.rows > 0) return measured;
    const px = hostPixels();
    return {
      cols: Math.max(1, Math.floor(px.width / 8)),
      rows: Math.max(1, Math.floor(px.height / 16)),
    };
  };
  status = createTerminalStatusController({
    root,
    pluginId: config.pluginId,
    engineId: input.engineId,
    rendererId: config.renderer?.rendererId ?? `${config.engineId}-frame`,
    rendererProfile: config.renderer?.rendererProfile ?? "web",
    publish(value) {
      // A pane that is not live says so inside itself. A failure states its code and message; any
      // other phase that is not live states the phase, because a blank screen alone is a pane the
      // reader cannot tell apart from an idle shell.
      const spoken = value.failure
        ? `${value.failure.code}: ${value.failure.message}`
        : value.phase === "live" ? "" : value.phase;
      notice.hidden = spoken === "";
      notice.textContent = spoken;
      input.publish(value);
    },
    presentation: presentation.current,
  });
  const inputNode = terminalNodeId("terminal-input", nodeSuffix);
  const focusChanged = (event: FocusEvent) => {
    const node = event.target instanceof HTMLElement ? event.target.dataset.node : undefined;
    if (node !== inputNode && node !== "terminal-input") return;
    presentation.markFocused(event.type === "focusin");
    status.refresh();
  };
  root.addEventListener("focusin", focusChanged);
  root.addEventListener("focusout", focusChanged);

  const markRendered = (startedAt: number) => {
    presentation.markRendered(Math.max(0, performance.now() - startedAt));
    status.refresh();
  };
  const presenterRendering = presenter.onRendered?.((durationMs) => {
    presentation.markRendered(durationMs);
    status.refresh();
  });

  const applyFrame = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const startedAt = performance.now();
    presenter.renderFrame?.(value as ProviderFrame);
    markRendered(startedAt);
    return true;
  };
  // The frame reply is the frame: the sequence, the geometry and the lines arrive in one object.
  const applyFrameSnapshot = (value: Record<string, unknown>): boolean => {
    const outputSequence = Number(value.outputSequence);
    if (!Number.isSafeInteger(outputSequence) || outputSequence < 0 || !applyFrame(value)) return false;
    renderedSequence = outputSequence;
    // A frame that was applied is the pane working again: the retry delay starts over from there.
    restartsWithoutProgress = 0;
    const frame = value;
    const reportedHistory = Number(value.historySize ?? frame.historySize);
    if (Number.isSafeInteger(reportedHistory) && reportedHistory >= 0) historySize = reportedHistory;
    // The reply's offset is the one applied; the request was only a wish.
    const reportedOffset = Number(value.offset ?? frame.offset);
    if (Number.isSafeInteger(reportedOffset) && reportedOffset >= 0) offset = reportedOffset;
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
  const reportFrameFailure = (error: unknown) => {
    if (stopped) return;
    status.set("blocked", {
      failure: { code: "FRAME_FAILED", message: String(error) }, fidelity: "unavailable",
    });
    // A frame the engine has no mirror for is a session that is gone; the pane starts one again.
    restartSession();
  };
  const flushByteOutput = async () => {
    if (writingOutput || stopped || pendingOutput.length === 0 || !presenter.writeOutput) return;
    const chunks = pendingOutput;
    const throughSeq = pendingOutputSequence;
    pendingOutput = [];
    const size = chunks.reduce((total, bytes) => total + bytes.length, 0);
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    writingOutput = true;
    try {
      await presenter.writeOutput(bytes);
      renderedSequence = Math.max(renderedSequence ?? 0, throughSeq);
      status.refresh();
    } finally {
      writingOutput = false;
      scheduleByteOutput();
    }
  };
  // Output is applied on a task, not on an animation frame: WebKit stops requestAnimationFrame
  // for an occluded window, and output that waits for a frame never reaches the presenter.
  const scheduleByteOutput = () => {
    if (byteFrameRequest !== null || writingOutput || stopped || pendingOutput.length === 0) return;
    byteFrameRequest = setTimeout(() => {
      byteFrameRequest = null;
      void flushByteOutput().catch(reportFrameFailure);
    }, 0);
  };
  const outputAhead = () => requestedSequence > (renderedSequence ?? -1);
  let shown = true;
  // Restarting a session is for one that went away while the pane was working. A pane that keeps
  // failing waits longer between tries, and never stops: what it is waiting for — a unit coming
  // back — is the thing that happens on its own.
  let restartsWithoutProgress = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRenderLatest = () => {
    if (frameRequest !== null || renderingTask || stopped || !shown || (!frameForced && !outputAhead())) return;
    frameRequest = setTimeout(() => {
      frameRequest = null;
      void renderLatest().catch(reportFrameFailure);
    }, 0);
  };
  const renderLatest = (): Promise<void> => {
    if (renderingTask) return renderingTask;
    if (stopped || bytesDelivery || (!frameForced && !outputAhead())) return Promise.resolve();
    const forced = frameForced;
    frameForced = false;
    const sequence = requestedSequence;
    renderingTask = (async () => {
      const response = await binding.recoveryRequest({
        op: "frame", pane: key, subscriber: `${key}#${session}`,
        ...(forced ? {} : { afterSequence: sequence }),
        offset, timeoutMs: FRAME_TIMEOUT_MS,
      });
      if (stopped) return;
      // A timed-out long poll carries no frame; the loop re-arms only when output is ahead.
      if (response.ok !== true && response.code === "TIMEOUT") return;
      if (!applyFrameSnapshot(requireReply(response, "frame"))) throw new Error("frame response has no exact output sequence");
    })().finally(() => {
      renderingTask = null;
      scheduleRenderLatest();
    });
    return renderingTask;
  };
  let requestResize = () => {};
  const resizeSession = async () => {
    const px = hostPixels();
    if (px.width <= 0 || px.height <= 0) return;
    // Fitting the renderer to the pane is display, not session: a pane with no session still shows
    // the whole box, and a renderer left at its own default fills only part of it.
    const { cols, rows } = terminalSize();
    if (!session) return;
    await binding.resize(session, cols, rows);
    requestedSize = { cols, rows };
    const observed = requireReply(await binding.recoveryRequest({ op: "waitSize", pane: key, cols, rows, timeoutMs: 8000 }), "waitSize");
    if (stopped) return;
    if (!bytesDelivery && !applyFrameSnapshot(requireReply(await binding.recoveryRequest({ op: "frame", pane: key, subscriber: `${key}#${session}`, offset }), "frame"))) {
      throw new Error("resize frame is invalid");
    }
    root.dispatchEvent(new CustomEvent("soksak:terminal-size", { detail: observed }));
    const latest = terminalSize();
    if (!stopped && (latest.cols !== cols || latest.rows !== rows)) requestResize();
  };
  const reportResizeFailure = (error: unknown) => {
    if (stopped) return;
    status.set("blocked", {
      failure: { code: "RESIZE_FAILED", message: String(error) }, fidelity: "unavailable",
    });
  };
  const resizeWorker = createTerminalResizeWorker(resizeSession, reportResizeFailure);
  requestResize = () => resizeWorker.request();
  // The pane shows its whole box from the moment it is mounted, whether or not a session ever
  // starts behind it.
  requestResize();
  const keepTail = (chunk: Uint8Array) => {
    if (chunk.length >= TAIL_BYTES) { tail = chunk.slice(chunk.length - TAIL_BYTES); return; }
    const length = Math.min(TAIL_BYTES, tail.length + chunk.length);
    const joined = new Uint8Array(length);
    const kept = length - chunk.length;
    joined.set(tail.subarray(tail.length - kept), 0);
    joined.set(chunk, kept);
    tail = joined;
  };
  const attach = (opened: number) => {
    // A pane is live when it has a session. A number that is not one is not a session, and writing
    // to it hands every keystroke to something nothing serves.
    if (!Number.isSafeInteger(opened) || opened < 1) {
      throw new Error(`pty returned no session for pane ${key}`);
    }
    session = opened;
    output = binding.onData(session, (chunk, throughSeq) => {
      lastOutputAt = now();
      keepTail(chunk);
      input.observe(chunk);
      for (const listener of outputListeners) listener();
      if (bytesDelivery) {
        pendingOutput.push(chunk.slice());
        pendingOutputSequence = Math.max(pendingOutputSequence, throughSeq);
        scheduleByteOutput();
        return;
      }
      requestedSequence = Math.max(requestedSequence, throughSeq);
      scheduleRenderLatest();
    });
    outputEnd = binding.onEnd(session, (reason) => {
      if (stopped || session !== opened) return;
      status.set("blocked", {
        failure: { code: "SESSION_ENDED", message: reason || `pane ${key} stream ended` },
        fidelity: "unavailable", recoveryOutcome: "blocked",
      });
      restartSession();
    });
    writable = true;
    requestResize();
  };
  const detachIfStopped = async (opened: number): Promise<boolean> => {
    if (!stopped) return false;
    await binding.detach(opened);
    return true;
  };
  const openOptions = () => ({
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: { [CALLER_PANE_ENV]: key },
  });
  const startFresh = async (outcome?: {
    phase?: "live" | "degraded-tail";
    recoveryOutcome?: "archived" | "continued" | "degraded-tail";
    fidelity?: "complete" | "unavailable";
    failure?: { code: string; message: string };
  }) => {
    root.dataset.terminalOperation = "preparing-observer";
    const prepared = requireReply(await binding.recoveryRequest({
      op: "prepareSession", pane: key, cols: 80, rows: 24,
    }), "prepareSession");
    if (stopped) return;
    const token = typeof prepared.observerToken === "string" ? prepared.observerToken : "";
    if (!token) throw new Error("prepareSession returned no observer token");
    root.dataset.terminalOperation = "opening-pty";
    const opened = await binding.open(key, 80, 24, "none", token, openOptions());
    if (await detachIfStopped(opened)) return;
    requestedSize = { cols: 80, rows: 24 };
    root.dataset.terminalOperation = "subscribing-recovery";
    requireReply(await binding.recoveryRequest({
      op: "ensureSession", pane: key, cols: 80, rows: 24, observerToken: token,
    }), "ensureSession");
    if (await detachIfStopped(opened)) return;
    attach(opened);
    root.dataset.terminalOperation = "ready";
    presentation.markReady();
    status.refresh();
    status.set(outcome?.phase ?? "live", {
      recoveryOutcome: outcome?.recoveryOutcome ?? "fresh",
      fidelity: outcome?.fidelity ?? "complete",
      failure: outcome?.failure,
    });
  };
  const startWarm = async () => {
    root.dataset.terminalOperation = "subscribing-recovery";
    requireReply(await binding.recoveryRequest({
      op: "ensureSession", pane: key, cols: 80, rows: 24,
    }), "ensureSession");
    if (stopped) return;
    // The screen a pane lost is lost: an observer that missed part of the output cannot rebuild it.
    // The shell behind the pane is not lost, so the pane attaches to that instead of failing.
    const rehydrated = await binding.recoveryRequest({ op: "rehydrate", pane: key });
    if (stopped) return;
    if (rehydrated.ok !== true && rehydrated.code === "SOURCE_GAP") {
      await startFresh({
        phase: "degraded-tail", recoveryOutcome: "degraded-tail", fidelity: "unavailable",
        failure: {
          code: "SOURCE_GAP",
          message: String(rehydrated.message ?? "the terminal-state observer missed source events"),
        },
      });
      return;
    }
    const restored = requireReply(rehydrated, "rehydrate");
    if (stopped) return;
    const leaseToken = typeof restored.leaseToken === "string" ? restored.leaseToken : "";
    if (!leaseToken || (bytesDelivery ? !presenter.applySnapshot : !applyFrame(restored.frame))) {
      throw new Error("rehydrate returned no frame or snapshot lease");
    }
    if (bytesDelivery) await presenter.applySnapshot!(restored, false);
    const restoredSequence = Number(restored.uptoSeq);
    if (!Number.isSafeInteger(restoredSequence) || restoredSequence < 0) {
      throw new Error("rehydrate returned no exact output sequence");
    }
    renderedSequence = restoredSequence;
    status.set("applying-snapshot", { recoveryOutcome: "continued", fidelity: "complete" });
    root.dataset.terminalOperation = "attaching-snapshot-lease";
    const opened = await binding.open(key, 80, 24, { leaseToken }, undefined, openOptions());
    if (await detachIfStopped(opened)) return;
    requestedSize = { cols: 80, rows: 24 };
    attach(opened);
    root.dataset.terminalOperation = "ready";
    presentation.markReady();
    status.refresh();
    status.set("live", { recoveryOutcome: "continued", fidelity: "complete" });
  };
  const startArchived = async (): Promise<boolean> => {
    root.dataset.terminalOperation = "checking-archive";
    const archived = await binding.recoveryRequest({ op: "archived", pane: key });
    if (stopped) return true;
    if (archived.ok !== true) {
      if (archived.code === "NOT_FOUND") return false;
      if (archived.code === "CHECKPOINT_CORRUPT") {
        status.set("preparing-recovery", {
          recoveryOutcome: "fresh", fidelity: "unavailable",
          failure: { code: "CHECKPOINT_REJECTED", message: String(archived.message ?? "checkpoint is corrupt") },
        });
        return false;
      }
      requireReply(archived, "archived");
    }
    const data = requireReply(archived, "archived");
    if (bytesDelivery) {
      if (!presenter.applySnapshot) throw new Error("byte presenter cannot restore snapshots");
      await presenter.applySnapshot(data, true);
    } else if (!applyFrame(data.frame)) throw new Error("archived returned no frame");
    const archivedSequence = Number(data.uptoSeq);
    if (!Number.isSafeInteger(archivedSequence) || archivedSequence < 0) {
      throw new Error("archived returned no exact output sequence");
    }
    renderedSequence = archivedSequence;
    root.dataset.terminalOperation = "ready";
    presentation.markReady();
    status.refresh();
    status.set("archived", { recoveryOutcome: "archived", fidelity: "complete" });
    return true;
  };
  // restartSession runs the start path again for a pane whose session is gone. One restart is in
  // flight at a time, and a restart that fails leaves the pane blocked with the reason.
  let restarting: Promise<void> | null = null;
  // The first try is immediate; every try after it waits, and the wait grows to half a minute. A
  // pane that cannot reach its terminal is waiting for something outside itself, and asking again
  // as fast as it can costs the whole application while changing nothing.
  const retryDelayMs = () => Math.min(30_000, 1000 * 2 ** Math.max(0, restartsWithoutProgress - 1));
  const restartSession = () => {
    if (stopped || restarting || retryTimer !== null) return;
    if (restartsWithoutProgress >= 1) {
      retryTimer = setTimeout(() => { retryTimer = null; restartNow(); }, retryDelayMs());
      return;
    }
    restartNow();
  };
  const restartNow = () => {
    if (stopped || restarting) return;
    restartsWithoutProgress += 1;
    const attached = session;
    session = 0;
    writable = false;
    output?.dispose();
    output = undefined;
    outputEnd?.dispose();
    outputEnd = undefined;
    restarting = (async () => {
      if (attached) {
        try {
          await binding.detach(attached);
        } catch (error) {
          if (!stopped) status.set("blocked", {
            failure: { code: "SESSION_DETACH_FAILED", message: String(error) },
            fidelity: "unavailable", recoveryOutcome: "blocked",
          });
        }
      }
      if (!stopped) await start();
    })()
      .then(() => {
        // A pane that came back carries no reason to be worried about: the failure that took it
        // down is what it showed while it was down. A failure the pane did not recover from — a
        // rejected checkpoint, say — is set by whatever recorded it and stays.
        const current = status.current();
        if (!stopped && current.phase === "live" && current.failure) {
          status.set("live", {
            recoveryOutcome: current.recoveryOutcome, fidelity: current.fidelity, failure: null,
          });
        }
      })
      .catch((error) => {
        if (!stopped) status.set("blocked", {
          failure: { code: "START_FAILED", message: String(error) },
          fidelity: "unavailable", recoveryOutcome: "blocked",
        });
      })
      .finally(() => {
        restarting = null;
        if (!stopped && status.current().phase !== "live") restartSession();
      });
  };
  const start = async () => {
    status.set("preparing-recovery");
    root.dataset.terminalOperation = "checking-live";
    const alive = await binding.paneAlive(key);
    if (stopped) return;
    if (alive) {
      await startWarm();
      return;
    }
    // A terminal pane is where a shell runs. An archive is what the last one left on screen; it is
    // shown, and then a shell is started, so the pane can be typed into rather than standing as a
    // picture of one that ended.
    const restored = await startArchived();
    if (stopped) return;
    await startFresh({ recoveryOutcome: restored ? "archived" : undefined });
  };
  const capturePrepare = () => presenter.refresh?.();
  window.addEventListener("soksak:capture-prepare", capturePrepare);

  startTask = (input.readyToStart ?? Promise.resolve()).then(async () => {
    if (!stopped) await start();
  });
  void startTask.catch((error) => {
    if (!stopped) status.set("blocked", {
      failure: { code: "START_FAILED", message: String(error) },
      fidelity: "unavailable", recoveryOutcome: "blocked",
    });
  });

  const lastCwdReport = (): Uint8Array | null => {
    const text = new TextDecoder().decode(tail);
    let last: string | null = null;
    for (const match of text.matchAll(CWD_REPORT)) last = match[0];
    return last === null ? null : new TextEncoder().encode(last);
  };

  return {
    key,
    viewId: input.viewId,
    engineId: input.engineId,
    root,
    binding,
    presenter,
    status,
    presentation,
    get session() { return session; },
    get writable() { return writable; },
    get requestedSize() { return requestedSize; },
    get renderedOutputSequence() { return renderedSequence; },
    get offset() { return offset; },
    get historySize() { return historySize; },
    get lastOutputAtUnixMs() { return lastOutputAt; },
    get title() { return title; },
    set title(value: string | null) { title = value; },
    hostPixels,
    async write(data) {
      await writeToPty(data, false);
    },
    sendInput(data) { void writeToPty(data, false).catch(() => {}); },
    onInput(listener) {
      inputListeners.add(listener);
      return { dispose: () => void inputListeners.delete(listener) };
    },
    async scroll(request) {
      // A renderer that keeps its own scrollback is the authority on where it is.
      if (presenter.scrollState) {
        const state = presenter.scrollState();
        const bounded = (value: number) => Math.max(0, Math.min(state.historySize, Math.floor(value)));
        if (request.edge === "top") presenter.scrollTo?.(state.historySize);
        else if (request.edge === "bottom") presenter.scrollTo?.(0);
        else if (typeof request.offset === "number") presenter.scrollTo?.(bounded(request.offset));
        else if (typeof request.lines === "number") presenter.scrollLines?.(request.lines);
        const moved = presenter.scrollState();
        return { pane: key, offset: moved.offset, historySize: moved.historySize };
      }
      const clamp = (value: number) => Math.max(0, Math.min(historySize, Math.floor(value)));
      if (request.edge === "top") offset = historySize;
      else if (request.edge === "bottom") offset = 0;
      else if (typeof request.offset === "number") offset = clamp(request.offset);
      else if (typeof request.lines === "number") offset = clamp(offset + request.lines);
      if (!stopped && !bytesDelivery && session) {
        frameForced = true;
        if (renderingTask) await renderingTask.catch(() => {});
        await renderLatest().catch(reportFrameFailure);
      }
      return { pane: key, offset, historySize };
    },
    waitIdle(idleMs, timeoutMs) {
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const cleanup = () => {
          clearTimeout(deadline);
          if (timer !== null) clearTimeout(timer);
          outputListeners.delete(arm);
        };
        const deadline = setTimeout(() => {
          cleanup();
          reject(new Error(`terminal idle wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const arm = () => {
          if (timer !== null) clearTimeout(timer);
          const since = now() - (lastOutputAt ?? mountedAt);
          timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, idleMs - since));
        };
        outputListeners.add(arm);
        arm();
      });
    },
    lastCwdReport,
    cwd() {
      const report = lastCwdReport();
      if (!report) return input.cwd ?? null;
      const text = new TextDecoder().decode(report);
      const url = text.slice(4, text.endsWith("\x07") ? -1 : -2);
      try {
        const path = decodeURIComponent(new URL(url).pathname);
        return path || (input.cwd ?? null);
      } catch {
        return input.cwd ?? null;
      }
    },
setShown(next) {
      if (shown === next) return;
      shown = next;
      if (shown) { frameForced = true; scheduleRenderLatest(); }
    },
        requestResize,
    stop(intent = "detach") {
      if (stopping) return stopping;
      stopped = true;
      writable = false;
      if (frameRequest !== null) clearTimeout(frameRequest);
      frameRequest = null;
      if (byteFrameRequest !== null) clearTimeout(byteFrameRequest);
      byteFrameRequest = null;
      pendingOutput = [];
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      root.removeEventListener("focusin", focusChanged);
      root.removeEventListener("focusout", focusChanged);
      window.removeEventListener("soksak:capture-prepare", capturePrepare);
      output?.dispose();
      outputEnd?.dispose();
      presenterRendering?.dispose();
      outputListeners.clear();
      inputListeners.clear();
      const attached = session;
      const pendingWrites = writeQueue;
      session = 0;
      status.close();
      presenter.dispose();
      stopping = (async () => {
        await pendingWrites;
        if (attached) await (intent === "close" ? binding.close(attached) : binding.detach(attached));
        await startTask.catch(() => {});
      })();
      return stopping;
    },
  };
}
