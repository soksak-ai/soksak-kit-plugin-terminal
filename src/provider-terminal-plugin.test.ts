// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { activateProviderTerminalPlugin, type ProviderTerminalPluginHost } from "./provider-terminal-plugin";
import {
  TERMINAL_PLUGIN_COMMANDS,
  TERMINAL_PLUGIN_COMMAND_SCHEMAS,
} from "@soksak/soksak-contract-plugin-terminal";
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;

describe("provider-backed terminal plugin", () => {
  it("owns standard commands and session lifecycle for a byte presenter", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined;
    const commands = new Map<string, Record<string, unknown>>();
    const snapshots: Record<string, unknown>[] = [];
    const output: Uint8Array[] = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        const data = command === "pty.pane" ? { held: false }
          : command === "pty.open" ? { session: 7 }
          : command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
        if (command === "terminal.archived") {
          return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        }
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request: unknown, handlers: { onBytes(bytes: Uint8Array): void }) => {
        handlers.onBytes(new Uint8Array([65]));
        return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: { dispose() {} } };
      }),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: {
        register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", providerSidecar: "terminal-byte",
      programId: "terminal-byte", renderer: {
        delivery: "bytes", rendererId: "byte-renderer",
        create: (container) => ({
        root: container,
        size: () => ({ cols: 80, rows: 24 }),
        fit() {},
        applySnapshot: async (snapshot) => { snapshots.push(snapshot); },
        writeOutput: (bytes) => { output.push(bytes); },
        read: () => "A",
        waitForText: async () => "A",
        focus: () => true,
        dispose() {},
        }),
      },
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    expect([...commands.keys()].sort()).toEqual([...TERMINAL_PLUGIN_COMMANDS].sort());
    expect(output).toEqual([new Uint8Array([65])]);
    expect(snapshots).toEqual([]);
  });

  it("rejects extensions that replace standard terminal commands", () => {
    const host = {
      windowLabel: () => "window", sidecar: { open: vi.fn() },
      ui: { registerView: vi.fn(() => ({ dispose() {} })) },
      commands: { register: vi.fn(() => ({ dispose() {} })) },
    } as unknown as ProviderTerminalPluginHost;
    expect(() => activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", providerSidecar: "terminal-byte",
      programId: "terminal-byte",
      extensions: [{ name: "status", params: {}, handler: () => ({}) }],
    })).toThrow("terminal extension cannot replace standard command status");
  });

  it("hands warm byte snapshots to the presenter before attaching the lease", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined;
    const snapshots: Record<string, unknown>[] = [];
    const requests: string[] = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command); requests.push(command);
        const data = command === "pty.pane" ? { held: true }
          : command === "terminal.rehydrate" ? { leaseToken: "lease", paint: "QQ==" }
          : command === "pty.open" ? { session: 9 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (request: Record<string, unknown>) => {
        requests.push(String(request.command));
        return { answer: { ok: true, result: { data: { startSeq: 1 } } }, close: { dispose() {} } };
      }),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", providerSidecar: "terminal-byte",
      programId: "terminal-byte", renderer: {
        delivery: "bytes", rendererId: "byte-renderer",
        create: (container) => ({
          root: container, size: () => ({ cols: 80, rows: 24 }),
          applySnapshot: async (snapshot) => { snapshots.push(snapshot); }, writeOutput() {},
          read: () => "", waitForText: async () => "", focus: () => true, dispose() {},
        }),
      },
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalRecovery).toBe("continued"));
    expect(snapshots).toEqual([{ leaseToken: "lease", paint: "QQ==" }]);
    expect(requests).toContain("pty.attachLease");
  });

  it("resizes from the host post-commit reflow event", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined;
    let reflow: (() => void) | undefined;
    const resizeRequests: Array<Record<string, unknown>> = [];
    let width = 800;
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const payload = (request.args as { request: Record<string, unknown> }).request;
        if (request.command === "pty.resize") resizeRequests.push(payload);
        const data = request.command === "pty.open" ? { session: 7 }
          : request.command === "pty.pane" ? { held: false } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({
        answer: { ok: true, result: { data: { startSeq: 0 } } }, close: { dispose() {} },
      })),
    };
    const provider = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        if (request.command === "terminal.archived") return { ok: false, error: "missing", result: { code: "NOT_FOUND" } };
        const payload = (request.args as { request: Record<string, unknown> }).request;
        const data = request.command === "terminal.prepareSession" ? { observerToken: "observer" }
          : request.command === "terminal.waitSize" ? { cols: payload.cols, rows: payload.rows }
          : request.command === "terminal.frame" ? { cols: Number(payload.cols ?? 54), rows: 24, cursor: [0,0], alt_active: false, lines: [[]] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async (name) => name === "pty" ? pty : provider },
      events: { on: (_event, callback) => { reflow = callback; return { dispose() {} }; } },
      ui: { registerView: (_id, item) => { view = item; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", providerSidecar: "terminal-vt100", programId: "terminal-vt100" });
    const root = document.createElement("div");
    Object.defineProperty(root, "clientWidth", { get: () => width });
    Object.defineProperty(root, "clientHeight", { value: 384 });
    document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(resizeRequests.length).toBeGreaterThan(0));
    resizeRequests.length = 0;
    width = 432;
    reflow!();
    await vi.waitFor(() => expect(resizeRequests).toContainEqual(expect.objectContaining({ cols: 54, rows: 24 })));
  });

  it("registers the common command contract exactly", async () => {
    const registered = new Map<string, Record<string, unknown>>();
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => ({
        send: async () => ({ ok: true, result: { data: {} } }),
        stream: async () => ({ answer: { ok: true, result: { data: {} } }, close: { dispose() {} } }),
      }) },
      ui: { registerView: () => ({ dispose() {} }) },
      commands: {
        register: (name, spec) => { registered.set(name, spec); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", providerSidecar: "terminal-vt100", programId: "terminal-vt100",
    });
    expect([...registered.keys()].sort()).toEqual([...TERMINAL_PLUGIN_COMMANDS].sort());
    for (const command of TERMINAL_PLUGIN_COMMANDS) {
      const actual = registered.get(command)!;
      const contract = TERMINAL_PLUGIN_COMMAND_SCHEMAS[command];
      const params = actual.params as Record<string, { type: string; required?: boolean }>;
      expect(Object.keys(params).sort()).toEqual(Object.keys(contract.input.properties).sort());
      expect(Object.entries(params).filter(([, value]) => value.required).map(([name]) => name).sort())
        .toEqual([...contract.input.required].sort());
      expect(actual.danger ?? "none").toBe(contract.danger);
      const result = await (actual.handler as (params: Record<string, unknown>) => unknown)(
        command === "wait" ? { phase: "closed" } : command === "send" ? { data: "x" } : {},
      ) as Record<string, unknown>;
      for (const field of contract.output.required) expect(result).toHaveProperty(field);
    }
  });

  it("detaches presentation without ending the PTY session", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void; unmount?(container: HTMLElement): void } | undefined;
    const requests: string[] = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command); requests.push(command);
        if (command === "terminal.archived") {
          return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        }
        const data = command === "pty.open" ? { session: 7 }
          : command === "pty.pane" ? { held: false }
          : command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({
        answer: { ok: true, result: { data: { startSeq: 0 } } },
        close: { dispose: vi.fn() },
      })),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", providerSidecar: "terminal-vt100", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(requests).toContain("pty.open"));
    view!.unmount?.(root);
    await Promise.resolve();
    expect(requests).not.toContain("pty.close");
  });

  it("rehydrates a live pane and attaches from its snapshot lease", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined;
    const requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        const payload = (request.args as { request: Record<string, unknown> }).request;
        requests.push({ command, payload });
        const data = command === "pty.pane" ? { held: true }
          : command === "terminal.rehydrate" ? {
            leaseToken: "lease", uptoSeq: 12,
            frame: { cols: 2, rows: 1, cursor: [0, 1], alt_active: false, lines: [[{ text: "R", fg: "default", bg: "default", attrs: 0, wide: false }]] },
          }
          : command === "pty.open" ? { session: 7 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (request: Record<string, unknown>) => ({
        answer: { ok: true, result: { data: { startSeq: 12 } } },
        close: { dispose() {} },
        request,
      })),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", providerSidecar: "terminal-vt100", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.querySelector('[data-node="terminal-screen"]')?.textContent).toContain("R"));
    expect(requests.map((item) => item.command)).toEqual(expect.arrayContaining([
      "pty.pane", "terminal.ensureSession", "terminal.rehydrate",
    ]));
    expect(requests.map((item) => item.command)).not.toContain("terminal.frame");
    const attach = channel.stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(attach.command).toBe("pty.attachLease");
    expect(root.dataset.terminalRecovery).toBe("continued");
    expect(root.dataset.terminalFidelity).toBe("complete");
  });

  it("renders the provider frame after the exact PTY sequence and sends input", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined;
    const commands = new Map<string, (params: Record<string, unknown>) => unknown>();
    const writes: unknown[] = [];
    let emit: ((bytes: Uint8Array) => void) | undefined;
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command; writes.push(request);
        const data = command === "pty.open" ? { session: 4 } : command === "pty.pane" ? { held: false } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request: unknown, handlers: { onBytes(bytes: Uint8Array): void }) => {
        emit = handlers.onBytes; return { answer: { ok: true, result: { data: { startSeq: 10 } } }, close: { dispose() {} } };
      }),
    };
    const provider = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command;
        if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        const data = command === "terminal.prepareSession" ? { observerToken: "obs" }
          : command === "terminal.frame" ? { cols: 4, rows: 1, cursor: [0, 2], alt_active: false, lines: [[{ text: "OK", fg: "default", bg: "default", attrs: 0, wide: false }]] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: vi.fn(async () => ({ created: true })) },
      sidecar: { open: async (name) => name === "pty" ? pty : provider },
      ui: { registerView: (_id, item) => { view = item; return { dispose() {} }; } },
      commands: {
        register: (name, spec) => { commands.set(name, (spec as { handler(p: Record<string, unknown>): unknown }).handler); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", providerSidecar: "terminal-vt100", programId: "terminal-vt100" });
    const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(emit).toBeTypeOf("function")); emit!(new Uint8Array([79, 75]));
    await vi.waitFor(() => expect(root.querySelector('[data-node="terminal-screen"]')?.textContent).toContain("OK"));
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ args: { request: expect.objectContaining({ afterSequence: 12 }) } }));
    const status = await commands.get("status")!({}) as Record<string, unknown>;
    expect(status).toMatchObject({
      hostPixels: { width: 0, height: 0 }, requested: { cols: 80, rows: 24 },
      pty: null, recovery: null, rendered: { cols: 4, rows: 1 }, operation: "ready",
    });
    expect(status).not.toHaveProperty("source");
    expect(status).not.toHaveProperty("cols");
    await commands.get("send")!({ view: "pane", data: "x" });
    expect(writes).toContainEqual(expect.objectContaining({ command: "pty.write" }));
  });

  it("coalesces output while one provider frame is in flight", async () => {
    let view: { mount(container: HTMLElement, context: unknown): void } | undefined; let emit: ((bytes: Uint8Array) => void) | undefined;
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    const frameSequences: number[] = [];
    const channel = () => ({
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command; const asked = (request.args as { request: Record<string, unknown> }).request;
        if (command === "terminal.frame") { frameSequences.push(Number(asked.afterSequence)); if (frameSequences.length === 1) await blocked; }
        if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        const data = command === "pty.open" ? { session: 1 } : command === "terminal.prepareSession" ? { observerToken: "o" }
          : command === "terminal.frame" ? { cols: 1, rows: 1, cursor: [0,0], alt_active: false, lines: [[]] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_r: unknown, h: { onBytes(bytes: Uint8Array): void }) => { emit = h.onBytes; return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: { dispose() {} } }; }),
    });
    const pty = channel(), provider = channel();
    const host: ProviderTerminalPluginHost = { windowLabel: () => "w", secrets: { generate: async () => ({ created: true }) }, sidecar: { open: async (n) => n === "pty" ? pty : provider }, ui: { registerView: (_i,v) => { view=v; return { dispose(){} }; } }, commands: { register: () => ({ dispose(){} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) } };
    activateProviderTerminalPlugin(host, [], { pluginId:"p", engineId:"e", providerSidecar:"terminal-e", programId:"terminal-e" });
    const root=document.createElement("div"); view!.mount(root,{viewId:"pane"}); await vi.waitFor(()=>expect(emit).toBeTypeOf("function"));
    emit!(new Uint8Array([1])); emit!(new Uint8Array([2])); emit!(new Uint8Array([3])); release();
    await vi.waitFor(()=>expect(frameSequences).toEqual([1,3]));
  });

});
