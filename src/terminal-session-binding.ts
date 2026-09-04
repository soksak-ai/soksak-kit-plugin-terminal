import { terminalLoginShell } from "./terminal-environment";

export interface TerminalSidecarChannel {
  send(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  stream(
    request: Record<string, unknown>,
    handlers: { onBytes(data: Uint8Array): void; onEnd?(reason: string): void },
  ): Promise<{ answer: Record<string, unknown>; close: { dispose(): void; settled: Promise<void> } }>;
  close?(): Promise<void>;
}

export interface TerminalSessionHost {
  windowLabel(): string;
  sidecar: {
    open(name: string, opts?: {
      secretEnv?: Record<string, string>;
      generatedSecretEnv?: Record<string, { key: string; bytes: number }>;
    }): Promise<TerminalSidecarChannel>;
  };
  commands?: { execute?(name: string, params?: Record<string, unknown>): Promise<unknown> };
  secrets?: { generate(key: string, bytes: number): Promise<{ created: boolean }> };
  terminal?: { observe?(paneId: string, bytes: Uint8Array): void };
}

export interface TerminalSessionOpenOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalSessionBinding {
  open(
    paneId: string, cols: number, rows: number, replay: "none" | { leaseToken: string },
    observerToken?: string, options?: TerminalSessionOpenOptions,
  ): Promise<number>;
  write(session: number, data: string): Promise<void>;
  resize(session: number, cols: number, rows: number): Promise<void>;
  close(session: number): Promise<void>;
  detach(session: number): Promise<void>;
  onData(session: number, callback: (bytes: Uint8Array, throughSeq: number, meta?: { initial?: boolean }) => void): { dispose(): void };
  onEnd(session: number, callback: (reason: string) => void): { dispose(): void };
  paneAlive(paneId: string): Promise<boolean>;
  /** The session the owner runs for this pane, or null when it runs none.
   *
   *  A surface-delivered pane does not open its own session — the surface owner does — so the view
   *  never learns the id from an open call and the core's index stays empty for it (SESSION.md
   *  S1-2). The owner already stamps the pane on every session it holds, so the id is asked for
   *  rather than reported. */
  sessionForPane(paneId: string): Promise<number | null>;
  /** Records the mode state a replay cannot rebuild. */
  recordModes(session: number, report: Uint8Array): Promise<void>;
  /** Reads back what was recorded, or null when nothing was. */
  recordedModes(session: number): Promise<Uint8Array | null>;
  recoveryRequest(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  diagnostics(): Promise<{ pty: Record<string, unknown>; recovery: Record<string, unknown> }>;
  closeWindow(windowLabel: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface TerminalSessionBindingOptions {
  ptySidecarId: string;
  terminalSidecarId: string;
  checkpointKey?: string;
  onOperation?: (operation: string) => void;
  // undefined: every delivered byte reaches host.terminal.observe under its pane id.
  // null: the caller feeds the host decoder itself. A function replaces the host feed.
  observe?: ((paneId: string, bytes: Uint8Array) => void) | null;
}

const KEY_ENV = "SOKSAK_TERMINAL_CHECKPOINT_KEY";

export function createTerminalSessionBinding(
  host: TerminalSessionHost,
  options: TerminalSessionBindingOptions,
): TerminalSessionBinding {
  let disposed = false;
  let disposing: Promise<void> | null = null;
  let sequence = 0;
  const request = (command: string, value: Record<string, unknown>) => ({
    id: `terminal-${++sequence}`, command, args: { request: value },
  });
  const answer = (response: Record<string, unknown>) => {
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "sidecar refused request");
    return ((response.result as { data?: unknown } | undefined)?.data ?? {}) as Record<string, unknown>;
  };
  const observe = (paneId: string, bytes: Uint8Array) => {
    if (options.observe === undefined) host.terminal?.observe?.(paneId, bytes);
    else options.observe?.(paneId, bytes);
  };
  let ptyChannel: TerminalSidecarChannel | null = null;
  let ptyPromise: Promise<TerminalSidecarChannel> | null = null;
  const pty = () => {
    if (disposed) return Promise.reject(new Error("terminal session binding is disposed"));
    if (!ptyPromise) {
      ptyPromise = host.sidecar.open(options.ptySidecarId)
        .then(async (channel) => {
          if (disposed) {
            await channel.close?.();
            throw new Error("terminal session binding is disposed");
          }
          ptyChannel = channel;
          return channel;
        })
        .catch((error) => { ptyPromise = null; throw error; });
    }
    return ptyPromise;
  };
  let recoveryChannel: TerminalSidecarChannel | null = null;
  let recoveryPromise: Promise<TerminalSidecarChannel> | null = null;
  const recovery = () => {
    if (disposed) return Promise.reject(new Error("terminal session binding is disposed"));
    if (!recoveryPromise) {
      const key = options.checkpointKey ?? "terminal-checkpoint-key-v1";
      options.onOperation?.("opening-recovery");
      recoveryPromise = pty().then(() => host.sidecar.open(options.terminalSidecarId, {
        generatedSecretEnv: { [KEY_ENV]: { key, bytes: 32 } },
      })).then(async (channel) => {
        if (disposed) {
          await channel.close?.();
          throw new Error("terminal session binding is disposed");
        }
        recoveryChannel = channel;
        return channel;
      })
        .catch((error) => { recoveryPromise = null; throw error; });
    }
    return recoveryPromise;
  };
  const invalidatePty = (channel: TerminalSidecarChannel) => {
    if (ptyChannel !== channel) return;
    ptyChannel = null;
    ptyPromise = null;
    void channel.close?.().catch(() => {});
  };
  const invalidateRecovery = (channel: TerminalSidecarChannel) => {
    if (recoveryChannel !== channel) return;
    recoveryChannel = null;
    recoveryPromise = null;
    void channel.close?.().catch(() => {});
  };
  const sendPty = async (channel: TerminalSidecarChannel, message: Record<string, unknown>) => {
    try { return await channel.send(message); }
    catch (error) { invalidatePty(channel); throw error; }
  };
  const sendRecovery = async (channel: TerminalSidecarChannel, message: Record<string, unknown>) => {
    try { return await channel.send(message); }
    catch (error) { invalidateRecovery(channel); throw error; }
  };
  const streams = new Map<number, { dispose(): void; settled: Promise<void> }>();
  const readers = new Map<number, Set<(bytes: Uint8Array, throughSeq: number) => void>>();
  const enders = new Map<number, Set<(reason: string) => void>>();
  const pending = new Map<number, Array<{ bytes: Uint8Array; throughSeq: number }>>();
  const taken = new Map<number, number>();
  type AcknowledgementState = {
    latest: number;
    sent: number;
    running: Promise<void> | null;
    failure: unknown;
  };
  const acknowledgements = new Map<number, AcknowledgementState>();
  const startAcknowledgement = (
    channel: TerminalSidecarChannel,
    session: number,
    state: AcknowledgementState,
  ) => {
    if (state.running || state.failure || state.sent >= state.latest) return;
    state.running = Promise.resolve().then(async () => {
      while (state.sent < state.latest) {
        const throughSeq = state.latest;
        answer(await sendPty(channel, request("pty.ack", { session, throughSeq })));
        state.sent = throughSeq;
      }
    }).catch((error) => {
      state.failure = error;
    }).finally(() => {
      state.running = null;
      if (!state.failure && state.sent < state.latest) startAcknowledgement(channel, session, state);
    });
  };
  const acknowledge = (channel: TerminalSidecarChannel, session: number, throughSeq: number) => {
    const state = acknowledgements.get(session);
    if (!state) return;
    state.latest = Math.max(state.latest, throughSeq);
    startAcknowledgement(channel, session, state);
  };
  const flushAcknowledgement = async (channel: TerminalSidecarChannel, session: number) => {
    const state = acknowledgements.get(session);
    if (!state) return;
    startAcknowledgement(channel, session, state);
    while (state.running) await state.running;
    if (state.failure) throw state.failure;
  };
  const encode = (text: string) => {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  let loginShellPromise: Promise<string> | null = null;
  const loginShell = () => (loginShellPromise ??= terminalLoginShell(host.commands));
  return {
    async open(paneId, cols, rows, replay, observerToken, openOptions) {
      const channel = await pty();
      const shell = await loginShell();
      const opened = answer(await sendPty(channel, request("pty.open", {
        paneId, cols, rows, shell, windowLabel: host.windowLabel(),
        ...(observerToken ? { observerToken } : {}),
        ...(openOptions?.cwd ? { cwd: openOptions.cwd } : {}),
        // The PTY contract reads an object as session variables added on top of the daemon's own
        // environment. An array would be the whole environment and would drop PATH and HOME.
        ...(openOptions?.env ? { env: openOptions.env } : {}),
      })));
      const session = Number(opened.session);
      const leaseToken = replay === "none" ? undefined : replay.leaseToken;
      const beforeAnswer: Uint8Array[] = [];
      let streamStarted = false;
      const deliver = (bytes: Uint8Array) => {
        const throughSeq = (taken.get(session) ?? 0) + bytes.length;
        taken.set(session, throughSeq);
        acknowledge(channel, session, throughSeq);
        const subscribed = readers.get(session);
        if (subscribed?.size) subscribed.forEach((reader) => reader(bytes, throughSeq));
        else pending.set(session, [...(pending.get(session) ?? []), { bytes, throughSeq }]);
        observe(paneId, bytes);
      };
      let stream;
      try {
        stream = await channel.stream(request(
          leaseToken ? "pty.attachLease" : "pty.attach",
          leaseToken ? { token: leaseToken } : { session },
        ), {
          onBytes(bytes) {
            if (!streamStarted) { beforeAnswer.push(bytes.slice()); return; }
            deliver(bytes);
          },
          onEnd(reason) { enders.get(session)?.forEach((listener) => listener(reason)); },
        });
      } catch (error) {
        invalidatePty(channel);
        throw error;
      }
      const attached = answer(stream.answer);
      const startSeq = Number(attached.startSeq);
      if (!Number.isSafeInteger(startSeq) || startSeq < 0) { stream.close.dispose(); throw new Error("pty.attach returned invalid startSeq"); }
      taken.set(session, startSeq);
      acknowledgements.set(session, { latest: startSeq, sent: startSeq, running: null, failure: null });
      streamStarted = true;
      for (const bytes of beforeAnswer) deliver(bytes);
      streams.set(session, stream.close);
      return session;
    },
    async write(session, data) { const channel = await pty(); answer(await sendPty(channel, request("pty.write", { session, dataB64: encode(data) }))); },
    async resize(session, cols, rows) { const channel = await pty(); answer(await sendPty(channel, request("pty.resize", { session, cols, rows }))); },
    async close(session) {
      await release(session);
      const channel = await pty();
      answer(await sendPty(channel, request("pty.close", { session })));
    },
    async detach(session) { await release(session); },
    onData(session, callback) {
      const set = readers.get(session) ?? new Set(); readers.set(session, set); set.add(callback);
      for (const item of pending.get(session) ?? []) callback(item.bytes, item.throughSeq); pending.delete(session);
      // Attach reports the current absolute sequence even when no bytes were pending. The pane
      // uses this event to request its first frame without a timer or a speculative write.
      callback(new Uint8Array(), taken.get(session) ?? 0, { initial: true });
      return { dispose: () => void readers.get(session)?.delete(callback) };
    },
    onEnd(session, callback) {
      const set = enders.get(session) ?? new Set();
      enders.set(session, set);
      set.add(callback);
      return { dispose: () => void enders.get(session)?.delete(callback) };
    },
    async paneAlive(paneId) { const channel = await pty(); return answer(await sendPty(channel, request("pty.pane", { paneId }))).held === true; },
    async sessionForPane(paneId) {
      const channel = await pty();
      const sessions = answer(await sendPty(channel, request("pty.status", {}))).sessions;
      if (!Array.isArray(sessions)) return null;
      for (const entry of sessions) {
        const held = entry as { paneId?: unknown; session?: unknown };
        if (held.paneId !== paneId) continue;
        const session = Number(held.session);
        return Number.isSafeInteger(session) && session > 0 ? session : null;
      }
      return null;
    },
    // The modes a program set are not in the stored output: a rotation drops the half that set
    // them, and a replay into a fresh mirror then draws in the wrong mode. The owner records them
    // as a fact of its own and answers them back before a replay (SESSION.md S4-5).
    //
    // Bytes on the wire, in the encoding the terminal contract defines. This kit does not read
    // them: what they mean is the mirror's.
    async recordModes(session, report) {
      const channel = await pty();
      await sendPty(channel, request("pty.modes", { session, report: [...report] }));
    },
    async recordedModes(session) {
      const channel = await pty();
      const recorded = answer(await sendPty(channel, request("pty.modes", { session })));
      const report = (recorded as { report?: unknown }).report;
      return Array.isArray(report) ? new Uint8Array(report) : null;
    },
    async recoveryRequest(value) {
      const operation = typeof value.op === "string" ? value.op : "";
      const commands: Record<string, string> = {
        prepareSession: "terminal.prepareSession", ensureSession: "terminal.ensureSession",
        rehydrate: "terminal.rehydrate", resize: "terminal.resize", waitSize: "terminal.waitSize", status: "terminal.status",
        archived: "terminal.archived", retire: "terminal.retire",
        archive: "terminal.archive",
        frame: "terminal.frame",
      };
      const command = commands[operation];
      if (!command) throw new Error(`unknown terminal recovery operation ${operation}`);
      const { op: _op, ...payload } = value;
      try {
        const channel = await recovery();
        const response = await sendRecovery(channel, request(command, { ...payload, window: host.windowLabel() }));
        if (response.ok !== true) return { ok: false, code: (response.result as { code?: string })?.code ?? "FAILED", message: response.error ?? "recovery request failed" };
        return { ok: true, code: "OK", data: answer(response) };
      } finally {
        options.onOperation?.("ready");
      }
    },
    async diagnostics() {
      const [ptyStatus, recoveryStatus] = await Promise.all([
        (async () => { const channel = await pty(); return answer(await sendPty(channel, request("pty.status", {}))); })(),
        (async () => {
          const response = await this.recoveryRequest({ op: "status" });
          return response.ok === true && response.data && typeof response.data === "object"
            ? response.data as Record<string, unknown> : response;
        })(),
      ]);
      return { pty: ptyStatus, recovery: recoveryStatus };
    },
    async closeWindow(windowLabel) { const channel = await pty(); answer(await sendPty(channel, request("pty.closeWindow", { windowLabel }))); },
    dispose() {
      if (disposing) return disposing;
      disposed = true;
      disposing = (async () => {
        const closingStreams = [...streams.values()];
        for (const stream of closingStreams) stream.dispose();
        await Promise.all(closingStreams.map((stream) => stream.settled));
        const channels = new Set<TerminalSidecarChannel>();
        if (ptyChannel) channels.add(ptyChannel);
        if (recoveryChannel) channels.add(recoveryChannel);
        const pendingChannels = [ptyPromise, recoveryPromise].filter(
          (pending): pending is Promise<TerminalSidecarChannel> => pending !== null,
        );
        for (const result of await Promise.allSettled(pendingChannels)) {
          if (result.status === "fulfilled") channels.add(result.value);
        }
        ptyChannel = null;
        ptyPromise = null;
        recoveryChannel = null;
        recoveryPromise = null;
        await Promise.all([...channels].map((channel) => channel.close?.()));
        streams.clear();
        readers.clear();
        enders.clear();
        pending.clear();
        taken.clear();
        acknowledgements.clear();
      })();
      return disposing;
    },
  };

  async function release(session: number): Promise<void> {
    const stream = streams.get(session);
    stream?.dispose();
    if (stream) await stream.settled;
    const channel = await pty();
    await flushAcknowledgement(channel, session);
    answer(await sendPty(channel, request("pty.detachRenderer", { session })));
    streams.delete(session);
    readers.delete(session);
    enders.delete(session);
    pending.delete(session);
    taken.delete(session);
    acknowledgements.delete(session);
  }
}
