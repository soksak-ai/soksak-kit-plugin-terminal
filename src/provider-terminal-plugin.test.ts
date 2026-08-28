// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { activateProviderTerminalPlugin, type ProviderTerminalPluginHost } from "./provider-terminal-plugin";
import {
  TERMINAL_PLUGIN_COMMANDS,
  TERMINAL_PLUGIN_COMMAND_SCHEMAS,
} from "@soksak/soksak-contract-plugin-terminal";
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as typeof ResizeObserver;

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);

const settledClose = () => ({ dispose() {}, settled: Promise.resolve() });
type Handler = (params: Record<string, unknown>, context?: { pane: string }) => Promise<Record<string, unknown>> | Record<string, unknown>;
type View = {
  mount(container: HTMLElement, context: unknown): void;
  unmount?(container: HTMLElement): void;
  closeIntent?(container: HTMLElement): "handled" | "pass";
  closeView?(container: HTMLElement): Promise<void>;
};

// One sidecar channel answering both PTY and recovery commands: sessions count up per open.
function fakeSidecars() {
  let nextSession = 0;
  const requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
  const channel = {
    send: vi.fn(async (request: Record<string, unknown>) => {
      const command = String(request.command);
      const payload = (request.args as { request: Record<string, unknown> }).request;
      requests.push({ command, payload });
      if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
      const data = command === "pty.pane" ? { held: false }
        : command === "pty.open" ? { session: ++nextSession }
        : command === "terminal.prepareSession" ? { observerToken: "observer" }
        : command === "terminal.waitSize" ? { cols: payload.cols, rows: payload.rows }
        : command === "terminal.frame" ? { outputSequence: Number(payload.afterSequence ?? 0), cols: 2, rows: 1, cursor: [0, 0], cursorVisible: true, altActive: false, full: true, lines: [] }
        : {};
      return { ok: true, result: { data } };
    }),
    stream: vi.fn(async () => ({ answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() })),
  };
  return { channel, requests };
}

function activate(channel: { send: unknown; stream: unknown }) {
  let view: View | undefined;
  const commands = new Map<string, Record<string, unknown>>();
  const host: ProviderTerminalPluginHost = {
    windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
    sidecar: { open: async () => channel as never },
    ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
    commands: { register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; }, execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
  };
  activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100" });
  const call = (name: string, params: Record<string, unknown> = {}, context?: { pane: string }) =>
    Promise.resolve((commands.get(name)!.handler as Handler)(params, context));
  return { view: view!, commands, call };
}

describe("provider-backed terminal plugin", () => {
  it("rejects a corrupt archive but starts a fresh writable terminal with visible failure status", async () => {
    let view: View | undefined;
    const commands = new Map<string, Record<string, unknown>>();
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        const data = command === "pty.pane" ? { held: false } : command === "pty.open" ? { session: 7 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({ answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() })),
    };
    const recovery = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        if (command === "terminal.archived") return { ok: false, error: "missing cursor_visible", result: { code: "CHECKPOINT_CORRUPT" } };
        const data = command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async (name) => name === "soksak-sidecar-pty" ? pty : recovery },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; }, execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100" });
    const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    const status = await (commands.get("status")!.handler as Handler)({ view: "pane" }, { pane: "pane" });
    expect(status).toMatchObject({ phase: "live", recoveryOutcome: "fresh", fidelity: "complete", failure: { code: "CHECKPOINT_REJECTED", message: "missing cursor_visible" } });
    expect(root.dataset.terminalFailure).toBe("CHECKPOINT_REJECTED");
    // The pane owns one notice: the failure is readable there, and the notice takes no pointer
    // events, so the terminal beneath keeps the mouse.
    const notices = root.querySelectorAll<HTMLElement>('[data-node="terminal-restore-status/1"]');
    expect(notices.length).toBe(1);
    expect(notices[0].hidden).toBe(false);
    expect(notices[0].textContent).toContain("CHECKPOINT_REJECTED");
    expect(notices[0].textContent).toContain("missing cursor_visible");
    expect(notices[0].style.pointerEvents).toBe("none");
  });

  it("shows a start failure inside the pane and clears the notice when the terminal is live", async () => {
    let view: View | undefined;
    let alive = false;
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        if (command === "pty.pane") { if (!alive) throw new Error("file does not exist"); return { ok: true, result: { data: { held: false } } }; }
        const data = command === "pty.open" ? { session: 7 } : command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
        if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({ answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() })),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100" });
    const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("blocked"));
    const notice = root.querySelector<HTMLElement>('[data-node="terminal-restore-status/1"]')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("START_FAILED");
    expect(notice.textContent).toContain("file does not exist");
    alive = true;
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    expect(root.querySelectorAll('[data-node="terminal-restore-status/1"]')).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('[data-node="terminal-restore-status/1"]')!.hidden).toBe(true);
  });

  it("keeps the recorded startup failure readable when diagnostics cannot open a sidecar", async () => {
    let view: View | undefined;
    const commands = new Map<string, Record<string, unknown>>();
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      sidecar: { open: async () => { throw new Error("DEPENDENCY_VERSION_CONFLICT: terminal-state requires 0.0.12, selected 0.0.13"); } },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: {
        register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty",
      terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("blocked"));
    await expect((commands.get("status")!.handler as Handler)({ view: "pane" }, { pane: "pane" })).resolves.toMatchObject({
      phase: "blocked",
      failure: { code: "START_FAILED", message: expect.stringContaining("DEPENDENCY_VERSION_CONFLICT") },
      pty: null, recovery: null,
    });
  });

  it("owns standard commands and session lifecycle for a byte presenter", async () => {
    let view: View | undefined;
    const commands = new Map<string, Record<string, unknown>>();
    const snapshots: Record<string, unknown>[] = [];
    const output: Uint8Array[] = [];
    let emit: ((bytes: Uint8Array) => void) | undefined;
    let rendered: ((durationMs: number) => void) | undefined;
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
        emit = handlers.onBytes;
        handlers.onBytes(new Uint8Array([65]));
        return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() };
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
      pluginId: "plugin", engineId: "byte", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      programId: "terminal-byte", renderer: {
        delivery: "bytes", rendererId: "byte-renderer",
        create: (container) => ({
          root: container,
          size: () => ({ cols: 80, rows: 24 }),
          fit() {},
          applySnapshot: async (snapshot) => { snapshots.push(snapshot); },
          writeOutput: async (bytes) => { output.push(bytes); },
          onRendered: (callback) => { rendered = callback; return { dispose() {} }; },
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
    await vi.waitFor(() => expect(output).toEqual([new Uint8Array([65])]));
    expect([...commands.keys()].sort()).toEqual([...TERMINAL_PLUGIN_COMMANDS].sort());
    expect(output).toEqual([new Uint8Array([65])]);
    output.length = 0;
    emit!(new Uint8Array([66]));
    emit!(new Uint8Array([67]));
    emit!(new Uint8Array([68]));
    await vi.waitFor(() => expect(output).toEqual([new Uint8Array([66, 67, 68])]));
    expect(snapshots).toEqual([]);
    const status = await (commands.get("status")!.handler as Handler)({ view: "pane" }, { pane: "pane" });
    expect(status.presentation).toMatchObject({
      delivery: "bytes", readySequence: 1, renderSequence: 0,
      acceptedInputSequence: 0, ptyWriteSequence: 0,
    });
    rendered!(6);
    const painted = await (commands.get("status")!.handler as Handler)({ view: "pane" }, { pane: "pane" });
    expect(painted.presentation).toMatchObject({
      renderSequence: 1, lastRenderDurationMs: 6,
    });
  });

  it("applies sidecar output while the page receives no animation frames", async () => {
    // WebKit stops requestAnimationFrame for an occluded window; output must still reach the presenter.
    const frame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
    try {
      let view: View | undefined;
      const output: Uint8Array[] = [];
      let emit: ((bytes: Uint8Array) => void) | undefined;
      const channel = {
        send: vi.fn(async (request: Record<string, unknown>) => {
          const command = String(request.command);
          const data = command === "pty.pane" ? { held: false }
            : command === "pty.open" ? { session: 7 }
            : command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
          if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
          return { ok: true, result: { data } };
        }),
        stream: vi.fn(async (_request: unknown, handlers: { onBytes(bytes: Uint8Array): void }) => {
          emit = handlers.onBytes;
          return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() };
        }),
      };
      const host: ProviderTerminalPluginHost = {
        windowLabel: () => "window",
        secrets: { generate: async () => ({ created: true }) },
        sidecar: { open: async () => channel },
        ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
        commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      };
      activateProviderTerminalPlugin(host, [], {
        pluginId: "plugin", engineId: "byte", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
        programId: "terminal-byte", renderer: {
          delivery: "bytes", rendererId: "byte-renderer",
          create: (container) => ({
            root: container, size: () => ({ cols: 80, rows: 24 }), fit() {},
            applySnapshot: async () => {}, writeOutput: async (bytes) => { output.push(bytes); },
            onRendered: () => ({ dispose() {} }), read: () => "", waitForText: async () => "", focus: () => true, dispose() {},
          }),
        },
      });
      const root = document.createElement("div"); document.body.append(root);
      view!.mount(root, { viewId: "pane" });
      await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
      emit!(new Uint8Array([66]));
      emit!(new Uint8Array([67]));
      await vi.waitFor(() => expect(output).toEqual([new Uint8Array([66, 67])]), { timeout: 1000 });
    } finally {
      frame.mockRestore();
    }
  });

  it("copies, bracket-pastes, and redeems file drops with public state and events", async () => {
    let view: View | undefined;
    const commands = new Map<string, Record<string, unknown>>();
    const { channel, requests } = fakeSidecars();
    const writeText = vi.fn(async () => {});
    const readText = vi.fn(async () => "붙여넣기");
    const redeem = vi.fn(async (id: string) => id === "grant-file"
      ? { kind: "file" as const, shellText: "'/tmp/a b'" }
      : id === "grant-image"
        ? { kind: "image" as const, shellText: "'/tmp/image.png'", inline: { protocol: "kitty", data: "image" } }
        : null);
    const events: string[] = [];
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel as never },
      clipboard: { readText, writeText },
      fileGrants: { redeem },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: {
        register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty",
      terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
      presenter: (root) => ({
        root, size: () => ({ cols: 80, rows: 24 }), read: () => "screen",
        selection: () => "selected", modes: () => ({ bracketedPaste: true }),
        waitForText: async () => "screen", focus: () => true, dispose() {},
      }),
    });
    const root = document.createElement("div");
    for (const event of [
      "soksak:terminal-clipboard-copied", "soksak:terminal-clipboard-pasted",
      "soksak:terminal-drop-accepted", "soksak:terminal-drop-refused",
    ]) root.addEventListener(event, () => events.push(event));
    document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    const call = (name: string, params: Record<string, unknown> = {}) =>
      Promise.resolve((commands.get(name)!.handler as Handler)({ view: "pane", ...params }, { pane: "pane" }));
    const decode = (value: unknown) => new TextDecoder().decode(
      Uint8Array.from(atob(String(value)), (character) => character.charCodeAt(0)),
    );

    await expect(call("copy")).resolves.toEqual({ pane: "pane.1", text: "selected", copied: true });
    expect(writeText).toHaveBeenCalledWith("selected");
    await expect(call("paste")).resolves.toMatchObject({ pane: "pane.1", pasted: true });
    const pasted = requests.filter((request) => request.command === "pty.write").at(-1)?.payload.dataB64;
    expect(decode(pasted)).toBe("\x1b[200~붙여넣기\x1b[201~");
    await expect(call("drop", { grants: ["grant-file", "missing"], mode: "path" }))
      .resolves.toEqual({ pane: "pane.1", accepted: 1, mode: "path" });
    const dropped = requests.filter((request) => request.command === "pty.write").at(-1)?.payload.dataB64;
    expect(decode(dropped)).toBe("'/tmp/a b' ");
    await expect(call("drop", { grants: ["grant-image"], mode: "inline" }))
      .resolves.toEqual({ pane: "pane.1", accepted: 0, mode: "inline" });
    expect(events).toEqual([
      "soksak:terminal-clipboard-copied", "soksak:terminal-clipboard-pasted",
      "soksak:terminal-drop-accepted", "soksak:terminal-drop-refused",
    ]);
    const drop = root.querySelector<HTMLElement>('[data-node="terminal-drop-target/1"]')!;
    expect(drop.dataset.fileGrantState).toBe("available");
    expect(JSON.parse(drop.dataset.lastDrop ?? "null")).toEqual({ accepted: 0, refused: 1, mode: "inline" });
    await expect(call("status")).resolves.toMatchObject({
      presentation: {
        bracketedPaste: true,
        selection: { active: true, text: "selected" },
        clipboardPermission: { read: true, write: true },
        drop: { fileGrantState: "available", last: { accepted: 0, refused: 1, mode: "inline" } },
      },
    });
  });

  it("opens the engine sidecar the setting selects; the plugin's engine is the default", async () => {
    const opened: string[] = [];
    const run = async (engine: string | undefined) => {
      let view: View | undefined;
      const commands = new Map<string, Record<string, unknown>>();
      const channel = {
        send: vi.fn(async (request: Record<string, unknown>) => {
          const command = String(request.command);
          const data = command === "pty.pane" ? { held: false } : command === "pty.open" ? { session: 7 } : command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
          if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
          return { ok: true, result: { data } };
        }),
        stream: vi.fn(async () => ({ answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() })),
      };
      const host: ProviderTerminalPluginHost = {
        windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
        sidecar: { open: async (name) => { opened.push(name); return channel; } },
        settings: { get: () => engine },
        ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
        commands: { register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; }, execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      };
      activateProviderTerminalPlugin(host, [], {
        pluginId: "plugin", engineId: "vt220", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt220", programId: "terminal",
        engines: { setting: "engine", sidecars: { vt220: "soksak-sidecar-terminal-vt220", vt100: "soksak-sidecar-terminal-vt100" } },
      });
      const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: `pane-${engine ?? "default"}` });
      await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
      const status = await (commands.get("status")!.handler as Handler)({ view: `pane-${engine ?? "default"}` }, { pane: `pane-${engine ?? "default"}` });
      return status.engineId;
    };
    expect(await run("vt100")).toBe("vt100");
    expect(opened).toContain("soksak-sidecar-terminal-vt100");
    expect(opened).not.toContain("soksak-sidecar-terminal-vt220");
    opened.length = 0;
    expect(await run(undefined)).toBe("vt220");
    expect(opened).toContain("soksak-sidecar-terminal-vt220");
    expect(await run("vt52")).toBe("vt220");
  });

  it("refuses an engine table that does not name the plugin's own engine sidecar", () => {
    const host = { windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) }, sidecar: { open: async () => ({ send: vi.fn(), stream: vi.fn() }) }, ui: { registerView: () => ({ dispose() {} }) }, commands: { register: () => ({ dispose() {} }) } } as unknown as ProviderTerminalPluginHost;
    expect(() => activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt220", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt220", programId: "terminal",
      engines: { setting: "engine", sidecars: { vt100: "soksak-sidecar-terminal-vt100" } },
    })).toThrow(/engines\.sidecars\.vt220/);
  });

  it("rejects extensions that replace standard terminal commands", () => {
    const host = {
      windowLabel: () => "window", sidecar: { open: vi.fn() },
      ui: { registerView: vi.fn(() => ({ dispose() {} })) },
      commands: { register: vi.fn(() => ({ dispose() {} })) },
    } as unknown as ProviderTerminalPluginHost;
    expect(() => activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      programId: "terminal-byte",
      extensions: [{ name: "status", params: {}, handler: () => ({}) }],
    })).toThrow("terminal extension cannot replace standard command status");
    expect(() => activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      programId: "terminal-byte",
      extensions: [{ name: "pane.close", params: {}, handler: () => ({}) }],
    })).toThrow("terminal extension cannot replace standard command pane.close");
  });

  it("publishes and disposes shell status through the common view lifecycle", () => {
    let view: View | undefined;
    const disposed: string[] = [];
    const items: Array<{ id: string; label: string }> = [];
    let cwdChanged: ((cwd: string) => void) | undefined;
    const host = {
      windowLabel: () => "window", locale: () => "en", sidecar: { open: vi.fn() },
      ui: {
        registerView: (_id: string, provider: View) => { view = provider; return { dispose() {} }; },
        statusBarItem: (item: { id: string; label: string }) => {
          items.push(item); return { dispose: () => { disposed.push(item.id); } };
        },
      },
      terminal: {
        getCwd: () => "/one",
        onCwd: (_pane: string, callback: (cwd: string) => void) => { cwdChanged = callback; return { dispose: () => disposed.push("watch") }; },
      },
      commands: { register: () => ({ dispose() {} }) },
    } as unknown as ProviderTerminalPluginHost;
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "frame", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      programId: "terminal-frame", label: { en: "Terminal", ko: "터미널" },
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cwd:pane", label: "/one" }),
      expect.objectContaining({ id: "kind:pane", label: "Terminal · frame" }),
    ]));
    expect(items.some((item) => item.id.includes("pane."))).toBe(false);
    cwdChanged!("/two");
    expect(items.at(-1)).toMatchObject({ id: "cwd:pane", label: "/two" });
    view!.unmount?.(root);
    expect(disposed).toEqual(expect.arrayContaining(["cwd:pane", "kind:pane", "watch"]));
  });

  it("hands warm byte snapshots to the presenter before attaching the lease", async () => {
    let view: View | undefined;
    const snapshots: Record<string, unknown>[] = [];
    const requests: string[] = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command); requests.push(command);
        const data = command === "pty.pane" ? { held: true }
          : command === "terminal.rehydrate" ? { leaseToken: "lease", paint: "QQ==", uptoSeq: 41 }
          : command === "pty.open" ? { session: 9 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (request: Record<string, unknown>) => {
        requests.push(String(request.command));
        return { answer: { ok: true, result: { data: { startSeq: 1 } } }, close: settledClose() };
      }),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "byte", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100",
      programId: "terminal-byte", renderer: {
        delivery: "bytes", rendererId: "byte-renderer",
        create: (container) => ({
          root: container, size: () => ({ cols: 80, rows: 24 }),
          applySnapshot: async (snapshot) => { snapshots.push(snapshot); }, async writeOutput() {},
          onRendered: () => ({ dispose() {} }),
          read: () => "", waitForText: async () => "", focus: () => true, dispose() {},
        }),
      },
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalRecovery).toBe("continued"));
    expect(snapshots).toEqual([{ leaseToken: "lease", paint: "QQ==", uptoSeq: 41 }]);
    expect(requests).toContain("pty.attachLease");
  });

  it("resizes from the host post-commit reflow event", async () => {
    let view: View | undefined;
    let reflow: (() => void) | undefined;
    const resizeRequests: Array<Record<string, unknown>> = [];
    let width = 800;
    let releaseNarrow!: () => void;
    const narrowObserved = new Promise<void>((resolve) => { releaseNarrow = resolve; });
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const payload = (request.args as { request: Record<string, unknown> }).request;
        if (request.command === "pty.resize") resizeRequests.push(payload);
        const data = request.command === "pty.open" ? { session: 7 }
          : request.command === "pty.pane" ? { held: false } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({
        answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose(),
      })),
    };
    const provider = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        if (request.command === "terminal.archived") return { ok: false, error: "missing", result: { code: "NOT_FOUND" } };
        const payload = (request.args as { request: Record<string, unknown> }).request;
        if (request.command === "terminal.waitSize" && payload.cols === 54) await narrowObserved;
        const data = request.command === "terminal.prepareSession" ? { observerToken: "observer" }
          : request.command === "terminal.waitSize" ? { cols: payload.cols, rows: payload.rows }
          : request.command === "terminal.frame" ? { outputSequence: 0, cols: Number(payload.cols ?? 54), rows: 24, cursor: [0,0], cursorVisible: true, altActive: false, full: true, lines: [] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async (name) => name === "soksak-sidecar-pty" ? pty : provider },
      events: { on: (event: "layout.reflow" | "window.gone", callback: (() => void) | ((payload: { windowLabel?: string }) => void)) => {
        if (event === "layout.reflow") reflow = callback as () => void;
        return { dispose() {} };
      } },
      ui: { registerView: (_id, item) => { view = item; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100" });
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
    width = 736;
    releaseNarrow();
    // The host announces the new geometry; the pane's size comes from the layout, not from a poll.
    reflow!();
    await vi.waitFor(() => expect(resizeRequests).toContainEqual(expect.objectContaining({ cols: 92, rows: 24 })));
  });

  it("registers the common command contract exactly", async () => {
    const registered = new Map<string, Record<string, unknown>>();
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => ({
        send: async () => ({ ok: true, result: { data: {} } }),
        stream: async () => ({ answer: { ok: true, result: { data: {} } }, close: settledClose() }),
      }) },
      ui: { registerView: () => ({ dispose() {} }) },
      commands: {
        register: (name, spec) => { registered.set(name, spec); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
    });
    expect([...registered.keys()].sort()).toEqual([...TERMINAL_PLUGIN_COMMANDS].sort());
    const sample: Record<string, Record<string, unknown>> = {
      wait: { phase: "closed" }, send: { data: "x" }, split: { direction: "right" },
      "pane.resize": { side: "right", px: 10 }, "pane.broadcast": { on: true }, "pane.title": { title: null },
      "input.compose": { updates: ["a"], data: "a" },
    };
    for (const command of TERMINAL_PLUGIN_COMMANDS) {
      const actual = registered.get(command)!;
      const contract = TERMINAL_PLUGIN_COMMAND_SCHEMAS[command];
      const params = actual.params as Record<string, { type: string; required?: boolean }>;
      expect(Object.keys(params).sort()).toEqual(Object.keys(contract.input.properties).sort());
      expect(Object.entries(params).filter(([, value]) => value.required).map(([name]) => name).sort())
        .toEqual([...contract.input.required].sort());
      expect(actual.danger ?? "none").toBe(contract.danger);
      const result = await (actual.handler as Handler)(sample[command] ?? {}) as Record<string, unknown>;
      for (const field of contract.output.required) expect(result).toHaveProperty(field);
    }
  });

  it("detaches presentation without ending the PTY session", async () => {
    let view: View | undefined;
    const requests: string[] = [];
    let settleFirst!: () => void;
    const firstSettled = new Promise<void>((resolve) => { settleFirst = resolve; });
    let streamCount = 0;
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
      stream: vi.fn(async () => {
        streamCount += 1;
        return {
          answer: { ok: true, result: { data: { startSeq: 0 } } },
          close: { dispose: vi.fn(), settled: streamCount === 1 ? firstSettled : Promise.resolve() },
        };
      }),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(requests).toContain("pty.open"));
    view!.unmount?.(root);
    const replacement = document.createElement("div");
    view!.mount(replacement, { viewId: "pane" });
    await Promise.resolve();
    expect(requests.filter((command) => command === "pty.pane")).toHaveLength(1);
    expect(requests.filter((command) => command === "pty.open")).toHaveLength(1);
    settleFirst();
    await vi.waitFor(() => expect(requests.filter((command) => command === "pty.pane")).toHaveLength(2));
    await vi.waitFor(() => expect(requests.filter((command) => command === "pty.open")).toHaveLength(2));
    expect(requests.indexOf("pty.detachRenderer")).toBeLessThan(requests.lastIndexOf("pty.open"));
    expect(requests).not.toContain("pty.close");
  });

  it("detaches mounted panes before closing generation-owned sidecar handles", async () => {
    let view: View | undefined;
    const order: string[] = [];
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        const data = command === "pty.pane" ? { held: false }
          : command === "pty.open" ? { session: 7 } : {};
        if (command === "pty.detachRenderer") order.push("pane.detach");
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async () => ({
        answer: { ok: true, result: { data: { startSeq: 0 } } },
        close: { dispose: () => { order.push("stream.close"); }, settled: Promise.resolve() },
      })),
      close: vi.fn(async () => { order.push("pty.handle.close"); }),
    };
    const recovery = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        if (request.command === "terminal.archived") {
          return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        }
        const data = request.command === "terminal.prepareSession" ? { observerToken: "observer" } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
      close: vi.fn(async () => { order.push("recovery.handle.close"); }),
    };
    const subscriptions: Array<{ dispose(): void }> = [];
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window",
      sidecar: { open: async (name) => name === "pty" ? pty : recovery },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, subscriptions, {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "pty",
      terminalSidecarId: "recovery", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));

    for (const subscription of [...subscriptions].reverse()) await subscription.dispose();
    expect(order).toEqual([
      "stream.close", "pane.detach", "pty.handle.close", "recovery.handle.close",
    ]);
  });

  it("rehydrates a live pane and attaches from its snapshot lease", async () => {
    let view: View | undefined;
    const requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
    const channel = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = String(request.command);
        const payload = (request.args as { request: Record<string, unknown> }).request;
        requests.push({ command, payload });
        const data = command === "pty.pane" ? { held: true }
          : command === "terminal.rehydrate" ? {
            leaseToken: "lease", uptoSeq: 12,
            frame: { cols: 2, rows: 1, cursor: [0, 1], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "R", fg: "default", bg: "default", attrs: 0, n: 1 }] }] },
          }
          : command === "pty.open" ? { session: 7 } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (request: Record<string, unknown>) => ({
        answer: { ok: true, result: { data: { startSeq: 12 } } },
        close: settledClose(),
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
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(root.querySelector('[data-node="terminal-screen/1"]')?.textContent).toContain("R"));
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
    let view: View | undefined;
    const commands = new Map<string, (params: Record<string, unknown>) => unknown>();
    const writes: unknown[] = [];
    let writeCalls = 0;
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let emit: ((bytes: Uint8Array) => void) | undefined;
    const pty = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command; writes.push(request);
        if (command === "pty.write" && ++writeCalls === 1) await firstWrite;
        const data = command === "pty.open" ? { session: 4 } : command === "pty.pane" ? { held: false } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request: unknown, handlers: { onBytes(bytes: Uint8Array): void }) => {
        emit = handlers.onBytes; return { answer: { ok: true, result: { data: { startSeq: 10 } } }, close: settledClose() };
      }),
    };
    const provider = {
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command;
        if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        const data = command === "terminal.prepareSession" ? { observerToken: "obs" }
          : command === "terminal.frame" ? { outputSequence: 12, cols: 4, rows: 1, cursor: [0, 2], cursorVisible: true, altActive: false, full: true, lines: [{ y: 0, wrapped: false, runs: [{ text: "OK", fg: "default", bg: "default", attrs: 0, n: 2 }] }] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(),
    };
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: vi.fn(async () => ({ created: true })) },
      sidecar: { open: async (name) => name === "soksak-sidecar-pty" ? pty : provider },
      ui: { registerView: (_id, item) => { view = item; return { dispose() {} }; } },
      commands: {
        register: (name, spec) => { commands.set(name, (spec as { handler(p: Record<string, unknown>): unknown }).handler); return { dispose() {} }; },
        execute: async () => ({ data: { loginShell: "/bin/zsh" } }),
      },
    };
    activateProviderTerminalPlugin(host, [], { pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100" });
    const root = document.createElement("div"); document.body.append(root); view!.mount(root, { viewId: "pane" });
    await vi.waitFor(() => expect(emit).toBeTypeOf("function")); emit!(new Uint8Array([79, 75]));
    await vi.waitFor(() => expect(root.querySelector('[data-node="terminal-screen/1"]')?.textContent).toContain("OK"));
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ args: { request: expect.objectContaining({
      afterSequence: 12, pane: "pane.1", subscriber: "pane.1#4", offset: 0, timeoutMs: 2000,
    }) } }));
    const status = await commands.get("status")!({}) as Record<string, unknown>;
    expect(status).toMatchObject({
      hostPixels: { width: 0, height: 0 }, requested: { cols: 80, rows: 24 },
      pty: null, recovery: null, rendered: { cols: 4, rows: 1 }, operation: "ready",
      view: "pane", pane: "pane.1",
    });
    expect(status).not.toHaveProperty("source");
    expect(status).not.toHaveProperty("cols");
    const screen = root.querySelector<HTMLElement>('[data-node="terminal-screen/1"]')!;
    const input = root.querySelector<HTMLTextAreaElement>('[data-node="terminal-input/1"]')!;
    screen.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    input.value = "x";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = "y";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(writeCalls).toBe(1));
    releaseFirstWrite();
    await vi.waitFor(() => expect(writeCalls).toBe(2));
    const afterInput = await commands.get("status")!({ view: "pane" }) as {
      presentation: Record<string, unknown>;
    };
    expect(afterInput.presentation).toMatchObject({
      delivery: "frame", acceptedInputSequence: 2, ptyWriteSequence: 2,
      focusedInput: true, cursorVisible: true, cursorActive: true,
      cursorRow: 0, cursorColumn: 2,
    });
  });

  it("coalesces an output burst before requesting a provider frame", async () => {
    let view: View | undefined; let emit: ((bytes: Uint8Array) => void) | undefined;
    let release!: () => void; const blocked = new Promise<void>((resolve) => { release = resolve; });
    const frameSequences: number[] = [];
    const channel = () => ({
      send: vi.fn(async (request: Record<string, unknown>) => {
        const command = request.command; const asked = (request.args as { request: Record<string, unknown> }).request;
        if (command === "terminal.frame") { frameSequences.push(Number(asked.afterSequence)); if (frameSequences.length === 1) await blocked; }
        if (command === "terminal.archived") return { ok: false, error: "not found", result: { code: "NOT_FOUND" } };
        const data = command === "pty.open" ? { session: 1 } : command === "terminal.prepareSession" ? { observerToken: "o" }
          : command === "terminal.frame" ? { outputSequence: Number(asked.afterSequence), cols: 1, rows: 1, cursor: [0,0], cursorVisible: true, altActive: false, full: true, lines: [] } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_r: unknown, h: { onBytes(bytes: Uint8Array): void }) => { emit = h.onBytes; return { answer: { ok: true, result: { data: { startSeq: 0 } } }, close: settledClose() }; }),
    });
    const pty = channel(), provider = channel();
    const host: ProviderTerminalPluginHost = { windowLabel: () => "w", secrets: { generate: async () => ({ created: true }) }, sidecar: { open: async (n) => n === "soksak-sidecar-pty" ? pty : provider }, ui: { registerView: (_i,v) => { view=v; return { dispose(){} }; } }, commands: { register: () => ({ dispose(){} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) } };
    activateProviderTerminalPlugin(host, [], { pluginId:"p", engineId:"e", ptySidecarId: "soksak-sidecar-pty", terminalSidecarId:"soksak-sidecar-terminal-vt100", programId:"terminal-e" });
    const root=document.createElement("div"); view!.mount(root,{viewId:"pane"}); await vi.waitFor(()=>expect(emit).toBeTypeOf("function"));
    emit!(new Uint8Array([1])); emit!(new Uint8Array([2])); emit!(new Uint8Array([3])); release();
    await vi.waitFor(()=>expect(frameSequences).toEqual([3]));
  });

  it("publishes every pane in status and routes pane, view and context targets", async () => {
    const { channel, requests } = fakeSidecars();
    const { view, call } = activate(channel);
    const root = document.createElement("div"); document.body.append(root);
    // A mounted view has a size; directional focus is decided by where the panes are.
    Object.defineProperty(root, "clientWidth", { value: 800 });
    Object.defineProperty(root, "clientHeight", { value: 400 });
    view.mount(root, { viewId: "tab-a", restore: { cwd: "/start", state: null } });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    expect(root.querySelector('[data-node="pane/1"]')).not.toBeNull();
    await expect(call("split", { view: "tab-a", direction: "right" })).resolves.toEqual({ view: "tab-a", pane: "tab-a.2", engineId: "vt100" });
    expect(root.querySelector('[data-node="pane/2"]')).not.toBeNull();
    expect(root.querySelector('[data-node="gutter/1/right"]')).not.toBeNull();
    await vi.waitFor(() => expect(requests.filter((item) => item.command === "pty.open").map((item) => item.payload.paneId)).toEqual(["tab-a.1", "tab-a.2"]));
    expect(requests.find((item) => item.command === "pty.open" && item.payload.paneId === "tab-a.1")!.payload).toMatchObject({ cwd: "/start", env: { SOKSAK_CALLER_PANE: "tab-a.1" } });
    const byView = await call("status", { view: "tab-a" });
    expect(byView).toMatchObject({ view: "tab-a", pane: "tab-a.2" });
    expect((byView.panes as Array<{ pane: string }>).map((pane) => pane.pane)).toEqual(["tab-a.1", "tab-a.2"]);
    expect((byView.panes as Array<Record<string, unknown>>)[0]).toMatchObject({ engineId: "vt100", offset: 0, historySize: 0, title: null });
    expect(await call("status", { pane: "tab-a.1" })).toMatchObject({ pane: "tab-a.1", view: "tab-a" });
    expect(await call("status", {}, { pane: "tab-a" })).toMatchObject({ pane: "tab-a.2" });
    expect(await call("status", { pane: "tab-b.1" })).toMatchObject({ phase: "closed", pane: null, panes: [] });
    await expect(call("pane.focus", { pane: "tab-a.1" })).resolves.toEqual({ focused: "tab-a.1" });
    expect(await call("status", { view: "tab-a" })).toMatchObject({ pane: "tab-a.1" });
    await expect(call("pane.focus", { view: "tab-a", dir: "right" })).resolves.toEqual({ focused: "tab-a.2" });
    await expect(call("pane.title", { pane: "tab-a.2", title: "build" })).resolves.toEqual({ title: "build" });
    await expect(call("pane.list", { view: "tab-a" })).resolves.toMatchObject({
      view: "tab-a", focused: "tab-a.2", maximized: null, broadcast: false,
      panes: [{ pane: "tab-a.1" }, { pane: "tab-a.2", title: "build" }],
    });
    await expect(call("pane.broadcast", { view: "tab-a", on: true })).resolves.toEqual({ broadcast: true });
    await expect(call("pane.maximize", { pane: "tab-a.1" })).resolves.toEqual({ maximized: "tab-a.1" });
    await expect(call("pane.maximize", { pane: "tab-a.1" })).resolves.toEqual({ maximized: null });
    await expect(call("pane.equalize", { view: "tab-a" })).resolves.toEqual({ applied: true });
    await expect(call("pane.resize", { pane: "tab-a.1", side: "right", px: 10 })).resolves.toEqual({ applied: true });
    await expect(call("pane.resize", { pane: "tab-a.1", side: "bottom", px: 10 })).resolves.toEqual({ applied: false });
    await expect(call("selection", { pane: "tab-a.1" })).resolves.toEqual({ pane: "tab-a.1", text: "" });
    await expect(call("scroll", { pane: "tab-a.1", lines: 5 })).resolves.toEqual({ pane: "tab-a.1", offset: 0, historySize: 0 });
    await expect(call("wait", { pane: "tab-a.1", phase: "live", idleMs: 20, timeoutMs: 1000 })).resolves.toMatchObject({ phase: "live", pane: "tab-a.1" });
    expect(await call("input.compose", { pane: "tab-a.1", updates: ["ㅎ"], data: "한" })).toEqual({ emitted: 4 });
    await vi.waitFor(() => expect(requests.some((item) => item.command === "pty.write")).toBe(true));
  });

  it("exposes the close intent: one pane passes, a second pane is handled", async () => {
    const { channel, requests } = fakeSidecars();
    const { view, call } = activate(channel);
    const root = document.createElement("div"); document.body.append(root);
    view.mount(root, { viewId: "tab-a" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    await call("split", { view: "tab-a", direction: "down" });
    expect(root.querySelector('[data-node="pane/2"]')).not.toBeNull();
    expect(view.closeIntent!(root)).toBe("handled");
    expect(root.querySelector('[data-node="pane/2"]')).toBeNull();
    await expect(call("pane.list", { view: "tab-a" })).resolves.toMatchObject({ focused: "tab-a.1", panes: [{ pane: "tab-a.1" }] });
    expect(view.closeIntent!(root)).toBe("pass");
    await vi.waitFor(() => expect(requests.some((item) => item.command === "pty.close")).toBe(true));
    await expect(call("pane.close", { pane: "tab-a.1" })).resolves.toEqual({ closed: false, focused: null });
    expect(view.closeIntent!(document.createElement("div"))).toBe("pass");
  });
});

// An extension command runs against one pane inside one view, and is told both.
describe("an extension command", () => {
  it("is told the view and the pane it reached", async () => {
    const seen: Array<{ view: string; pane: string }> = [];
    const commands = new Map<string, Record<string, unknown>>();
    let view: View | undefined;
    const { channel } = fakeSidecars();
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel as never },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: (name, spec) => { commands.set(name, spec); return { dispose() {} }; }, execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty",
      terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
      extensions: [{
        name: "probe.where", params: {},
        handler: (_params, screen) => {
          if (screen) seen.push({ view: screen.view, pane: screen.pane });
          return { view: screen?.view ?? null, pane: screen?.pane ?? null };
        },
      }],
    });
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, { viewId: "tab-a" });
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));
    const answer = await (commands.get("probe.where")!.handler as Handler)({ view: "tab-a" }, undefined);
    expect(answer).toMatchObject({ view: "tab-a", pane: "tab-a.1" });
    expect(seen).toEqual([{ view: "tab-a", pane: "tab-a.1" }]);
  });
});

// A view the host is not showing is a view nothing has to be painted for.
describe("a view that is not shown", () => {
  it("stops its panes asking for frames until the host shows it again", async () => {
    const { channel, requests } = fakeSidecars();
    let view: View | undefined;
    const host: ProviderTerminalPluginHost = {
      windowLabel: () => "window", secrets: { generate: async () => ({ created: true }) },
      sidecar: { open: async () => channel as never },
      ui: { registerView: (_id, provider) => { view = provider; return { dispose() {} }; } },
      commands: { register: () => ({ dispose() {} }), execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
    };
    activateProviderTerminalPlugin(host, [], {
      pluginId: "plugin", engineId: "vt100", ptySidecarId: "soksak-sidecar-pty",
      terminalSidecarId: "soksak-sidecar-terminal-vt100", programId: "terminal-vt100",
    });
    let visible = true;
    const listeners: Array<(p: { visible: boolean }) => void> = [];
    const root = document.createElement("div"); document.body.append(root);
    view!.mount(root, {
      viewId: "tab-a",
      presentation: () => ({ visible }),
      onPresentationChange: (listener: (p: { visible: boolean }) => void) => { listeners.push(listener); return () => {}; },
    } as never);
    await vi.waitFor(() => expect(root.dataset.terminalPhase).toBe("live"));

    visible = false;
    for (const listener of listeners) listener({ visible: false });
    const asked = requests.filter((entry) => entry.command === "terminal.frame").length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(requests.filter((entry) => entry.command === "terminal.frame").length).toBe(asked);

    visible = true;
    for (const listener of listeners) listener({ visible: true });
    await vi.waitFor(() => expect(requests.filter((entry) => entry.command === "terminal.frame").length).toBeGreaterThan(asked));
  });
});
