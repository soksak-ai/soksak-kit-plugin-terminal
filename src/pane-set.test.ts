// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createPaneSet, type PaneSetHost } from "./pane-set";
import type { TerminalSessionBinding } from "./terminal-session-binding";

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.dataset.themeMode = "dark";

const frame = { cols: 2, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, full: true, lines: [
  { y: 0, wrapped: false, runs: [{ text: "OK", fg: "default", bg: "default", attrs: 0, n: 2 }] },
] };

function fakeBinding() {
  let nextSession = 0;
  const taken = new Map<number, number>();
  const readers = new Map<number, (bytes: Uint8Array, throughSeq: number) => void>();
  const opens: Array<{ paneId: string; session: number; options: unknown }> = [];
  const writes: Array<{ session: number; data: string }> = [];
  const detached: number[] = [];
  const binding: TerminalSessionBinding = {
    open: vi.fn(async (paneId: string, _cols: number, _rows: number, _replay: unknown, _token?: string, options?: unknown) => {
      const session = ++nextSession;
      opens.push({ paneId, session, options });
      return session;
    }),
    write: vi.fn(async (session: number, data: string) => { writes.push({ session, data }); }),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    detach: vi.fn(async (session: number) => { detached.push(session); }),
    onData: (session, callback) => { readers.set(session, callback); return { dispose: () => readers.delete(session) }; },
    onEnd: () => ({ dispose() {} }),
    paneAlive: vi.fn(async () => false),
    recordModes: vi.fn(async () => {}),
    recordedModes: vi.fn(async () => null),
    recoveryRequest: vi.fn(async (request: Record<string, unknown>) => {
      switch (request.op) {
        case "prepareSession": return { ok: true, code: "OK", data: { observerToken: "observer" } };
        case "archived": return { ok: false, code: "NOT_FOUND", message: "none" };
        case "frame": return { ok: true, code: "OK", data: { outputSequence: Number(request.afterSequence ?? 0), ...frame } };
        case "waitSize": return { ok: true, code: "OK", data: { cols: request.cols, rows: request.rows } };
        default: return { ok: true, code: "OK", data: {} };
      }
    }),
    diagnostics: async () => ({ pty: {}, recovery: {} }),
    closeWindow: async () => {},
    dispose: async () => {},
  };
  const emit = (session: number, bytes: Uint8Array) => {
    const throughSeq = (taken.get(session) ?? 0) + bytes.length;
    taken.set(session, throughSeq);
    readers.get(session)?.(bytes, throughSeq);
  };
  return { binding, opens, writes, detached, emit };
}

function setup(
  hostExtra: Partial<PaneSetHost> = {},
  restore: { next: number } | null = null,
  stopBarriers = new Map<string, Promise<void>>(),
) {
  const { binding, opens, writes, detached, emit } = fakeBinding();
  const engines: string[] = [];
  const states: unknown[] = [];
  const titles: string[] = [];
  const observed: Array<[string, string]> = [];
  const items: Array<{ id: string; label: string }> = [];
  const host: PaneSetHost = {
    windowLabel: () => "window",
    sidecar: { open: vi.fn() },
    locale: () => "en",
    ui: { statusBarItem: (item) => { items.push(item); return { dispose() {} }; } },
    terminal: { observe: (paneId, bytes) => observed.push([paneId, new TextDecoder().decode(bytes)]) },
    ...hostExtra,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const set = createPaneSet(host, {
    viewId: "tab-a", container,
    context: { setRestoreState: (state) => states.push(state), setTitle: (title) => titles.push(title) },
    config: { pluginId: "plugin", engineId: "vt100", label: { en: "Terminal", ko: "터미널" } },
    engineFor: (engineId) => { engines.push(engineId ?? ""); return { engineId: engineId ?? "vt100", binding }; },
    index: { attach: () => {}, detach: () => {} },
    stopBarriers,
    restore,
  });
  const paneRoot = () => { const root = document.createElement("div"); container.append(root); return root; };
  return { set, binding, opens, writes, detached, emit, engines, states, titles, observed, items, container, paneRoot };
}

describe("pane set", () => {
  it("opens keyed panes with their own PTY sessions and engine bindings", async () => {
    const { set, opens, engines, paneRoot } = setup();
    const first = set.openPane({ root: paneRoot() });
    const second = set.openPane({ root: paneRoot(), engineId: "vt220" });
    expect([first.key, second.key]).toEqual(["tab-a.1", "tab-a.2"]);
    expect(engines).toEqual(["", "vt220"]);
    expect(second.engineId).toBe("vt220");
    await vi.waitFor(() => expect(opens).toHaveLength(2));
    expect(opens.map((open) => open.paneId)).toEqual(["tab-a.1", "tab-a.2"]);
    expect(new Set(opens.map((open) => open.session)).size).toBe(2);
    await vi.waitFor(() => expect(second.status.current().phase).toBe("live"));
    expect(first.root.querySelector('[data-node="terminal-screen/1"]')).not.toBeNull();
    expect(second.root.querySelector('[data-node="terminal-screen/2"]')).not.toBeNull();
    expect(set.list().map((pane) => pane.key)).toEqual(["tab-a.1", "tab-a.2"]);
  });

  it("registers one io mirror under the view id that forwards to the focused pane", async () => {
    const registered: Array<[
      string,
      { readBuffer(lines?: number): string | Promise<string>; sendInput(data: string): void },
    ]> = [];
    const { set, writes, emit, paneRoot } = setup({
      terminal: { registerIo: (pane, io) => { registered.push([pane, io]); return { dispose() {} }; } },
    });
    set.openPane({ root: paneRoot() });
    const second = set.openPane({ root: paneRoot() });
    expect(registered).toHaveLength(1);
    expect(registered[0][0]).toBe("tab-a");
    set.focusPane("tab-a.2");
    await vi.waitFor(() => expect(second.status.current().phase).toBe("live"));
    emit(2, new Uint8Array([1]));
    await vi.waitFor(() => expect(registered[0][1].readBuffer()).toBe("OK"));
    registered[0][1].sendInput("x");
    await vi.waitFor(() => expect(writes).toEqual([{ session: 2, data: "x" }]));
  });

  it("observes only the focused pane's bytes under the view id and replays the cwd report on focus change", async () => {
    const { set, observed, emit, paneRoot } = setup();
    const first = set.openPane({ root: paneRoot() });
    const second = set.openPane({ root: paneRoot() });
    set.focusPane("tab-a.2");
    await vi.waitFor(() => expect(first.status.current().phase).toBe("live"));
    await vi.waitFor(() => expect(second.status.current().phase).toBe("live"));
    const report = "\x1b]7;file://host/work\x07";
    emit(1, new TextEncoder().encode(report));
    emit(2, new TextEncoder().encode("two"));
    expect(observed).toEqual([["tab-a", "two"]]);
    set.focusPane("tab-a.1");
    expect(observed).toEqual([["tab-a", "two"], ["tab-a", report]]);
    expect(first.cwd()).toBe("/work");
  });

  it("places status bar items under the view id only and follows the host cwd", () => {
    let cwdChanged: ((cwd: string) => void) | undefined;
    const { set, items, titles, paneRoot } = setup({
      terminal: {
        getCwd: () => "/one",
        onCwd: (_pane, callback) => { cwdChanged = callback; return { dispose() {} }; },
      },
    });
    set.openPane({ root: paneRoot() });
    set.openPane({ root: paneRoot() });
    expect(items.map((item) => item.id).sort()).toEqual(["cwd:tab-a", "kind:tab-a"]);
    expect(items.find((item) => item.id === "cwd:tab-a")).toMatchObject({ label: "/one" });
    expect(titles.at(-1)).toBe("one");
    cwdChanged!("/two/three");
    expect(items.at(-1)).toMatchObject({ id: "cwd:tab-a", label: "/two/three" });
    expect(titles.at(-1)).toBe("three");
    set.setTitle("tab-a.1", "build");
    expect(titles.at(-1)).toBe("build");
    expect(items.some((item) => item.id.includes("tab-a."))).toBe(false);
  });

  it("shows the focused pane's plugin and engine in the status bar", () => {
    const { set, items, paneRoot } = setup();
    set.openPane({ root: paneRoot() });
    set.openPane({ root: paneRoot(), engineId: "vt220" });
    expect(items.filter((item) => item.id === "kind:tab-a").at(-1)).toMatchObject({
      label: "Terminal · vt100",
    });

    set.focusPane("tab-a.2");

    expect(items.filter((item) => item.id === "kind:tab-a").at(-1)).toMatchObject({
      label: "Terminal · vt220",
    });
  });

  it("persists the next key and every pane, and seeds the next key from restore", () => {
    const { set, states, paneRoot } = setup({}, { next: 7 });
    expect(set.nextKey()).toBe("tab-a.7");
    set.openPane({ root: paneRoot(), key: "tab-a.9", engineId: "vt220", title: "nine" });
    set.openPane({ root: paneRoot(), cwd: "/seed" });
    expect(set.nextKey()).toBe("tab-a.11");
    expect(states.at(-1)).toEqual({
      version: 1, next: 11,
      panes: [
        { key: "tab-a.9", engineId: "vt220", title: "nine", cwd: null },
        { key: "tab-a.10", engineId: "vt100", title: null, cwd: "/seed" },
      ],
    });
    set.bindLayout(() => ({ focused: "tab-a.10", broadcast: true }));
    set.focusPane("tab-a.10");
    expect(states.at(-1)).toMatchObject({ version: 1, focused: "tab-a.10", broadcast: true, next: 11 });
    expect(() => set.openPane({ root: paneRoot(), key: "tab-b.1" })).toThrow("does not belong to view tab-a");
  });

  it("ends a closed pane's session and moves focus to a remaining one", async () => {
    const { set, binding, container, paneRoot } = setup();
    const first = set.openPane({ root: paneRoot() });
    set.openPane({ root: paneRoot() });
    await vi.waitFor(() => expect(first.status.current().phase).toBe("live"));
    expect(container.dataset.terminalPhase).toBe("live");
    expect(set.focused()?.key).toBe("tab-a.1");
    await expect(set.closePane("tab-a.1")).resolves.toBe(true);
    expect(binding.close).toHaveBeenCalledWith(1);
    expect(binding.detach).not.toHaveBeenCalled();
    expect(set.get("tab-a.1")).toBeUndefined();
    expect(set.focused()?.key).toBe("tab-a.2");
    await expect(set.closePane("tab-a.1")).resolves.toBe(false);
  });

  it("opens the PTY at the requested cwd with the caller pane in the environment", async () => {
    const { set, opens, paneRoot } = setup();
    set.openPane({ root: paneRoot(), cwd: "/work" });
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]).toMatchObject({
      paneId: "tab-a.1", options: { cwd: "/work", env: { SOKSAK_CALLER_PANE: "tab-a.1" } },
    });
  });
});

// A pane the caller closed is gone: its session ends with it, so nothing keeps a shell alive for a
// pane that will never be shown again.
describe("closing a pane", () => {
  it("ends the session rather than leaving it for a reattach", async () => {
    const { set, binding } = setup();
    const opened = await set.openPane({ key: "tab-a.1", root: document.createElement("div") });
    await vi.waitFor(() => expect(opened.status.current().phase).toBe("live"));
    await set.closePane("tab-a.1");
    expect(binding.close).toHaveBeenCalledTimes(1);
    expect(binding.detach).not.toHaveBeenCalled();
  });
  it("ends every session when the owning tab is permanently closed", async () => {
    const { set, binding, paneRoot } = setup();
    const first = set.openPane({ root: paneRoot() });
    const second = set.openPane({ root: paneRoot() });
    await vi.waitFor(() => expect(first.status.current().phase).toBe("live"));
    await vi.waitFor(() => expect(second.status.current().phase).toBe("live"));

    await set.dispose("close");
    expect(binding.close).toHaveBeenCalledTimes(2);
    expect(binding.detach).not.toHaveBeenCalled();
  });
});

describe("reloading a pane set", () => {
  it("does not open a replacement session until the previous generation detached", async () => {
    const barriers = new Map<string, Promise<void>>();
    const first = setup({}, null, barriers);
    const pane = first.set.openPane({ key: "tab-a.1", root: first.paneRoot() });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    let releaseDetach!: () => void;
    const detachPending = new Promise<void>((resolve) => { releaseDetach = resolve; });
    first.binding.detach = vi.fn(async () => detachPending);

    const disposing = first.set.dispose();
    const replacement = setup({}, null, barriers);
    replacement.set.openPane({ key: "tab-a.1", root: replacement.paneRoot() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement.opens).toEqual([]);

    releaseDetach();
    await disposing;
    await vi.waitFor(() => expect(replacement.opens).toHaveLength(1));
  });
});
