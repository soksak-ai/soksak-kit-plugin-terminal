import { describe, expect, it, vi } from "vitest";
import { createTerminalSessionBinding, type TerminalSidecarChannel } from "./terminal-session-binding";

const settledClose = () => ({ dispose() {}, settled: Promise.resolve() });

describe("shared terminal session binding", () => {
  it("identifies a sidecar when a response has no error detail", async () => {
    const channel: TerminalSidecarChannel = {
      send: vi.fn(async () => ({ ok: false })),
      stream: vi.fn(),
    };
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async () => channel },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    await expect(binding.write(9, "x")).rejects.toThrow("sidecar refused request");
  });

  it("opens atomically, ACKs absolute coordinates, buffers first bytes, and injects only a key name", async () => {
    const sent: Record<string, unknown>[] = [];
    let onBytes: ((bytes: Uint8Array) => void) | undefined;
    const pty: TerminalSidecarChannel = {
      send: vi.fn(async (request) => {
        sent.push(request);
        const command = request.command;
        const data = command === "pty.open" ? { session: 9 } : command === "pty.pane" ? { held: true } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request, handlers) => {
        onBytes = handlers.onBytes;
        return { answer: { ok: true, result: { data: { startSeq: 41 } } }, close: settledClose() };
      }),
    };
    const provider: TerminalSidecarChannel = {
      send: vi.fn(async () => ({ ok: true, result: { data: {} } })),
      stream: vi.fn(),
    };
    const opens: unknown[] = [];
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async (name, opts) => { opens.push([name, opts]); return name === "soksak-sidecar-pty" ? pty : provider; } },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    const session = await binding.open("pane-a", 80, 24, "none", "observer-a");
    onBytes!(new Uint8Array([65, 66, 67]));
    const received: number[] = [];
    binding.onData(session, (bytes) => received.push(...bytes));
    await binding.recoveryRequest({ op: "status" });
    await binding.diagnostics();
    await Promise.resolve();

    expect(received).toEqual([65, 66, 67]);
    expect(sent.find((value) => value.command === "pty.open"))
      .toMatchObject({ args: { request: { observerToken: "observer-a", shell: "/bin/zsh" } } });
    expect(sent.find((value) => value.command === "pty.ack"))
      .toMatchObject({ args: { request: { session: 9, throughSeq: 44 } } });
    expect(opens).toContainEqual(["soksak-sidecar-terminal-vt100", {
      generatedSecretEnv: {
        SOKSAK_TERMINAL_CHECKPOINT_KEY: { key: "terminal-checkpoint-key-v1", bytes: 32 },
      },
    }]);
  });

  it("anchors bytes delivered before the stream answer to its absolute start sequence", async () => {
    const acknowledgements: number[] = [];
    let onBytes: ((bytes: Uint8Array) => void) | undefined;
    const channel: TerminalSidecarChannel = {
      send: vi.fn(async (request) => {
        if (request.command === "pty.open") return { ok: true, result: { data: { session: 9 } } };
        if (request.command === "pty.ack") {
          const args = request.args as { request: { throughSeq: number } };
          acknowledgements.push(args.request.throughSeq);
        }
        return { ok: true, result: { data: {} } };
      }),
      stream: vi.fn(async (_request, handlers) => {
        onBytes = handlers.onBytes;
        handlers.onBytes(new Uint8Array([65, 66, 67]));
        return { answer: { ok: true, result: { data: { startSeq: 41 } } }, close: settledClose() };
      }),
    };
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async () => channel },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    const session = await binding.open("pane-a", 80, 24, "none");
    const received: number[] = [];
    binding.onData(session, (bytes) => received.push(...bytes));
    onBytes!(new Uint8Array([68]));
    onBytes!(new Uint8Array([69]));

    await vi.waitFor(() => expect(acknowledgements).toEqual([44, 46]));
    expect(received).toEqual([65, 66, 67, 68, 69]);
  });

  it("closes the byte stream before explicitly detaching its renderer generation", async () => {
    const order: string[] = [];
    let settleClose!: () => void;
    const settled = new Promise<void>((resolve) => { settleClose = resolve; });
    const channel: TerminalSidecarChannel = {
      send: vi.fn(async (request) => {
        order.push(String(request.command));
        const data = request.command === "pty.open" ? { session: 9 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({
        answer: { ok: true, result: { data: { startSeq: 0 } } },
        close: { dispose: () => { order.push("stream.close"); }, settled },
      })),
    };
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async () => channel },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    const session = await binding.open("pane-a", 80, 24, "none");
    const detaching = binding.detach(session);
    await Promise.resolve();
    expect(order).not.toContain("pty.detachRenderer");
    settleClose();
    await detaching;
    expect(order.slice(-2)).toEqual(["stream.close", "pty.detachRenderer"]);
  });
  it("passes cwd and environment pairs to pty.open and routes bytes to the observe option", async () => {
    const sent: Record<string, unknown>[] = [];
    let onBytes: ((bytes: Uint8Array) => void) | undefined;
    const channel: TerminalSidecarChannel = {
      send: vi.fn(async (request) => {
        sent.push(request);
        const data = request.command === "pty.open" ? { session: 3 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request, handlers) => {
        onBytes = handlers.onBytes;
        return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() };
      }),
    };
    const hostObserved: string[] = [];
    const observed: Array<[string, number[]]> = [];
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async () => channel },
      terminal: { observe: (paneId) => { hostObserved.push(paneId); } },
    }, {
      ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      observe: (paneId, bytes) => { observed.push([paneId, [...bytes]]); },
    });

    await binding.open("tab-a.2", 80, 24, "none", "observer-a", { cwd: "/work", env: { SOKSAK_CALLER_PANE: "tab-a.2" } });
    onBytes!(new Uint8Array([65]));

    expect(sent.find((value) => value.command === "pty.open")).toMatchObject({
      args: { request: { paneId: "tab-a.2", cwd: "/work", env: [["SOKSAK_CALLER_PANE", "tab-a.2"]] } },
    });
    expect(observed).toEqual([["tab-a.2", [65]]]);
    expect(hostObserved).toEqual([]);
  });
});
