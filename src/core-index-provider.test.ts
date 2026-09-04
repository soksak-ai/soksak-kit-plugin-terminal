// @vitest-environment jsdom
// The attach reaches the host from a mounted view, through the whole provider.
//
// The seam this covers is provider → pane set → pane session. The wiring test beside it starts at
// the pane set, so a provider that builds the index writer wrong — or does not pass it — passes
// there and fails here.
//
// Measured 2026-09-04: a released kit had every link of that chain present in its bundle and no
// attach ever reached the core. Nothing between the two ends was tested together.
import { describe, expect, it, vi } from "vitest";

import { activateProviderTerminalPlugin, type ProviderTerminalPluginHost } from "./provider-terminal-plugin";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as typeof ResizeObserver;

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.dataset.themeMode = "dark";

const settledClose = () => ({ dispose() {}, settled: Promise.resolve() });

type View = {
  restores: string;
  mount(container: HTMLElement, context: unknown): void;
  unmount?(container: HTMLElement): void;
};

function activate() {
  const executed: Array<{ name: string; params?: Record<string, unknown> }> = [];
  let view: View | undefined;
  let session = 0;
  const channel = {
    // The wire is { command, args: { request } } — the shape the sidecar channel carries.
    send: vi.fn(async (message: Record<string, unknown>) => {
      const command = String(message.command ?? "");
      const request = ((message.args as { request?: unknown } | undefined)?.request ?? {}) as Record<string, unknown>;
      if (command === "pty.open") return { ok: true, result: { data: { session: ++session } } };
      if (command === "pty.pane") return { ok: true, result: { data: { held: false } } };
      // A refusal carries its code under result, which is where the binding reads it.
      if (command === "terminal.archived") return { ok: false, result: { code: "NOT_FOUND" }, error: "none" };
      if (command === "terminal.prepareSession") {
        return { ok: true, result: { data: { observerToken: "observer" } } };
      }
      if (command === "terminal.waitSize") {
        return { ok: true, result: { data: { cols: request.cols, rows: request.rows } } };
      }
      if (command === "terminal.frame") {
        return { ok: true, result: { data: { outputSequence: 0, cols: 2, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, full: true, lines: [] } } };
      }
      return { ok: true, result: { data: {} } };
    }),
    stream: vi.fn(async () => ({
      answer: { ok: true, result: { data: { startSeq: 0 } } },
      close: settledClose(),
    })),
  };
  const host: ProviderTerminalPluginHost = {
    windowLabel: () => "window",
    secrets: { generate: async () => ({ created: true }) },
    sidecar: { open: async () => channel as never },
    ui: { registerView: (_id: string, provider: unknown) => { view = provider as View; return { dispose() {} }; } },
    commands: {
      register: () => ({ dispose() {} }),
      execute: async (name: string, params?: Record<string, unknown>) => {
        executed.push({ name, params });
        return { ok: true, data: { loginShell: "/bin/zsh" } };
      },
    },
  } as unknown as ProviderTerminalPluginHost;

  activateProviderTerminalPlugin(host, [], {
    pluginId: "plugin",
    engineId: "vt100",
    ptySidecarId: "an-owner",
    terminalSidecarId: "soksak-sidecar-terminal-vt100",
    programId: "terminal-vt100",
  });
  return { view: view!, executed };
}

describe("a mounted terminal view", () => {
  it("tells the host which session it holds", async () => {
    const { view, executed } = activate();
    const container = document.createElement("div");
    // jsdom reports no size, and a pane with no size never starts a session. The provider takes the
    // size from the container rather than from an injected reader.
    Object.defineProperty(container, "clientWidth", { value: 800 });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    document.body.append(container);

    view.mount(container, { viewId: "tab-a", containerGeneration: 1, setRestoreState: () => {}, setTitle: () => {} });
    await vi.waitFor(
      () => expect(executed.some((one) => one.name === "session.attach")).toBe(true),
      { timeout: 4000 },
    );

    const attach = executed.find((one) => one.name === "session.attach");
    // The owner is the one the plugin declared, the view is the one that mounted, and the id is
    // text — a number goes through a JSON parser exact only to 2^53.
    expect(attach?.params).toMatchObject({ owner: "an-owner", view: "tab-a" });
    expect(typeof attach?.params?.session).toBe("string");
  });
});
