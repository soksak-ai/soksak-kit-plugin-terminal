// @vitest-environment jsdom
// The core's index is written from the one place that knows both halves.
import { describe, expect, it, vi } from "vitest";

import { createPaneSet, type PaneSetHost } from "./pane-set";
import type { CoreIndex } from "./core-index";
import type { TerminalSessionBinding } from "./terminal-session-binding";

// The presenter reads the theme off the document, as it does in a real window.
for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.dataset.themeMode = "dark";

function harness() {
  let nextSession = 0;
  const frame = {
    cols: 2, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, full: true,
    lines: [{ y: 0, wrapped: false, runs: [{ text: "OK", fg: "default", bg: "default", attrs: 0, n: 2 }] }],
  };
  const binding = {
    open: vi.fn(async () => ++nextSession),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
    onData: () => ({ dispose() {} }),
    onEnd: () => ({ dispose() {} }),
    paneAlive: vi.fn(async () => false),
    recoveryRequest: vi.fn(async (request: Record<string, unknown>) => {
      switch (request.op) {
        case "prepareSession": return { ok: true, code: "OK", data: { observerToken: "observer" } };
        case "archived": return { ok: false, code: "NOT_FOUND", message: "none" };
        case "frame": return { ok: true, code: "OK", data: { outputSequence: 0, ...frame } };
        case "waitSize": return { ok: true, code: "OK", data: { cols: request.cols, rows: request.rows } };
        default: return { ok: true, code: "OK", data: {} };
      }
    }),
    diagnostics: async () => ({ pty: {}, recovery: {} }),
    closeWindow: async () => {},
    dispose: async () => {},
  } as unknown as TerminalSessionBinding;

  const attached: Array<{ session: number; viewId: string }> = [];
  const detached: number[] = [];
  const index: CoreIndex = {
    attach: (session, viewId) => attached.push({ session, viewId }),
    detach: (session) => detached.push(session),
  };

  const container = document.createElement("div");
  document.body.append(container);
  const host: PaneSetHost = {
    windowLabel: () => "window",
    sidecar: { open: vi.fn() },
    locale: () => "en",
    ui: { statusBarItem: () => ({ dispose() {} }) },
    terminal: { observe: () => {} },
  };
  const set = createPaneSet(host, {
    viewId: "tab-a",
    container,
    context: { setRestoreState: () => {}, setTitle: () => {} },
    config: { pluginId: "plugin", engineId: "vt100", label: { en: "Terminal", ko: "터미널" } },
    engineFor: () => ({ engineId: "vt100", binding }),
    index,
  });
  const paneRoot = () => {
    const root = document.createElement("div");
    container.append(root);
    return root;
  };
  return { set, attached, detached, paneRoot };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("the core index", () => {
  it("is told which session a view holds, as soon as the pane has one", async () => {
    // Nothing else can write this. The owner issues the id and the view knows the coordinate, and
    // only the moment they meet has both — so without this the index is empty in a running
    // application and the session listing answers nothing about a session that is running.
    const { set, attached, paneRoot } = harness();
    set.openPane({ key: "tab-a.1", root: paneRoot() });
    await settle();

    expect(attached).toEqual([{ session: 1, viewId: "tab-a" }]);
  });

  it("is told the coordinate is gone when nothing draws the session any more", async () => {
    // Detached, never closed. The shell is still running and closing it is an explicit act on the
    // session (S7), so what changes is where it is shown.
    const { set, detached, paneRoot } = harness();
    set.openPane({ key: "tab-a.1", root: paneRoot() });
    await settle();
    await set.closePane("tab-a.1");
    await settle();

    expect(detached).toEqual([1]);
  });
});
