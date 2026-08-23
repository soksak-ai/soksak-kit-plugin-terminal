export interface TerminalSidecarChannel {
  send(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  stream(
    request: Record<string, unknown>,
    handlers: { onBytes(data: Uint8Array): void; onEnd?(reason: string): void },
  ): Promise<{ answer: Record<string, unknown>; close: { dispose(): void; settled: Promise<void> } }>;
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

export interface TerminalSessionBinding {
  open(paneId: string, cols: number, rows: number, replay: "none" | { leaseToken: string }, observerToken?: string): Promise<number>;
  write(session: number, data: string): Promise<void>;
  resize(session: number, cols: number, rows: number): Promise<void>;
  close(session: number): Promise<void>;
  detach(session: number): Promise<void>;
  onData(session: number, callback: (bytes: Uint8Array, throughSeq: number) => void): { dispose(): void };
  paneAlive(paneId: string): Promise<boolean>;
  recoveryRequest(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  diagnostics(): Promise<{ pty: Record<string, unknown>; recovery: Record<string, unknown> }>;
  closeWindow(windowLabel: string): Promise<void>;
}

export interface TerminalSessionBindingOptions {
  ptySidecarId: string;
  terminalSidecarId: string;
  checkpointKey?: string;
  onOperation?: (operation: string) => void;
}

const KEY_ENV = "SOKSAK_TERMINAL_CHECKPOINT_KEY";

export function createTerminalSessionBinding(
  host: TerminalSessionHost,
  options: TerminalSessionBindingOptions,
): TerminalSessionBinding {
  let sequence = 0;
  const request = (command: string, value: Record<string, unknown>) => ({
    id: `terminal-${++sequence}`, command, args: { request: value },
  });
  const answer = (response: Record<string, unknown>) => {
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "sidecar refused request");
    return ((response.result as { data?: unknown } | undefined)?.data ?? {}) as Record<string, unknown>;
  };
  let ptyPromise: Promise<TerminalSidecarChannel> | null = null;
  const pty = () => (ptyPromise ??= host.sidecar.open(options.ptySidecarId));
  let recoveryPromise: Promise<TerminalSidecarChannel> | null = null;
  const recovery = () => (recoveryPromise ??= (async () => {
    const key = options.checkpointKey ?? "terminal-checkpoint-key-v1";
    options.onOperation?.("opening-recovery");
    return host.sidecar.open(options.terminalSidecarId, {
      generatedSecretEnv: { [KEY_ENV]: { key, bytes: 32 } },
    });
  })());
  const streams = new Map<number, { dispose(): void; settled: Promise<void> }>();
  const readers = new Map<number, Set<(bytes: Uint8Array, throughSeq: number) => void>>();
  const pending = new Map<number, Array<{ bytes: Uint8Array; throughSeq: number }>>();
  const taken = new Map<number, number>();
  const encode = (text: string) => {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  let loginShellPromise: Promise<string> | null = null;
  const loginShell = () => (loginShellPromise ??= (async () => {
    const executed = await host.commands?.execute?.("app.environment", {});
    const data = executed && typeof executed === "object" && "data" in executed
      ? (executed as { data?: unknown }).data : executed;
    const shell = data && typeof data === "object"
      ? (data as { loginShell?: unknown }).loginShell : undefined;
    if (typeof shell !== "string" || shell === "") {
      throw new Error("app.environment returned no login shell");
    }
    return shell;
  })());
  return {
    async open(paneId, cols, rows, replay, observerToken) {
      const channel = await pty();
      const shell = await loginShell();
      const opened = answer(await channel.send(request("pty.open", {
        paneId, cols, rows, shell, windowLabel: host.windowLabel(),
        ...(observerToken ? { observerToken } : {}),
      })));
      const session = Number(opened.session);
      const leaseToken = replay === "none" ? undefined : replay.leaseToken;
      const beforeAnswer: Uint8Array[] = [];
      let streamStarted = false;
      const deliver = (bytes: Uint8Array) => {
        const throughSeq = (taken.get(session) ?? 0) + bytes.length;
        taken.set(session, throughSeq);
        void channel.send(request("pty.ack", { session, throughSeq })).catch(() => {});
        const subscribed = readers.get(session);
        if (subscribed?.size) subscribed.forEach((reader) => reader(bytes, throughSeq));
        else pending.set(session, [...(pending.get(session) ?? []), { bytes, throughSeq }]);
        host.terminal?.observe?.(paneId, bytes);
      };
      const stream = await channel.stream(request(
        leaseToken ? "pty.attachLease" : "pty.attach",
        leaseToken ? { token: leaseToken } : { session },
      ), { onBytes(bytes) {
        if (!streamStarted) { beforeAnswer.push(bytes.slice()); return; }
        deliver(bytes);
      }});
      const attached = answer(stream.answer);
      const startSeq = Number(attached.startSeq);
      if (!Number.isSafeInteger(startSeq) || startSeq < 0) { stream.close.dispose(); throw new Error("pty.attach returned invalid startSeq"); }
      taken.set(session, startSeq);
      streamStarted = true;
      for (const bytes of beforeAnswer) deliver(bytes);
      streams.set(session, stream.close);
      return session;
    },
    async write(session, data) { answer(await (await pty()).send(request("pty.write", { session, dataB64: encode(data) }))); },
    async resize(session, cols, rows) { answer(await (await pty()).send(request("pty.resize", { session, cols, rows }))); },
    async close(session) {
      await release(session);
      answer(await (await pty()).send(request("pty.close", { session })));
    },
    async detach(session) { await release(session); },
    onData(session, callback) {
      const set = readers.get(session) ?? new Set(); readers.set(session, set); set.add(callback);
      for (const item of pending.get(session) ?? []) callback(item.bytes, item.throughSeq); pending.delete(session);
      return { dispose: () => void readers.get(session)?.delete(callback) };
    },
    async paneAlive(paneId) { return answer(await (await pty()).send(request("pty.pane", { paneId }))).held === true; },
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
      const response = await (await recovery()).send(request(command, { ...payload, window: host.windowLabel() }));
      if (response.ok !== true) return { ok: false, code: (response.result as { code?: string })?.code ?? "FAILED", message: response.error ?? "recovery request failed" };
      return { ok: true, code: "OK", data: answer(response) };
    },
    async diagnostics() {
      const [ptyStatus, recoveryStatus] = await Promise.all([
        (async () => answer(await (await pty()).send(request("pty.status", {}))))(),
        (async () => {
          const response = await this.recoveryRequest({ op: "status" });
          return response.ok === true && response.data && typeof response.data === "object"
            ? response.data as Record<string, unknown> : response;
        })(),
      ]);
      return { pty: ptyStatus, recovery: recoveryStatus };
    },
    async closeWindow(windowLabel) { answer(await (await pty()).send(request("pty.closeWindow", { windowLabel }))); },
  };

  async function release(session: number): Promise<void> {
    const stream = streams.get(session);
    stream?.dispose();
    if (stream) await stream.settled;
    answer(await (await pty()).send(request("pty.detachRenderer", { session })));
    streams.delete(session);
    readers.delete(session);
    pending.delete(session);
    taken.delete(session);
  }
}
