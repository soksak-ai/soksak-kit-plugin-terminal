// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTerminalTheme } from "@soksak/soksak-contract-plugin-terminal";
import { createPaneSession, defaultTerminalPresenterFactory, type TerminalPresenter } from "./pane-session";
import type { ProviderFrameRun, ProviderFrame } from "./provider-frame-presenter";
import type { TerminalSessionBinding } from "./terminal-session-binding";
import { readTerminalThemeStatus } from "./terminal-theme";

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);
document.documentElement.dataset.themeMode = "dark";

const run = (text: string): ProviderFrameRun => ({ text, fg: "default", bg: "default", attrs: 0 });
const frameOf = (rows: string[], full = true): ProviderFrame => ({
  full, cols: 4, rows: rows.length, cursor: [0, 0], cursorVisible: false, altActive: false,
  lines: rows.map((text, y) => ({ y, wrapped: false, runs: [run(text)] })).filter((line) => line.runs[0].text !== ""),
});

interface FrameReply { ok: boolean; code?: string; data?: Record<string, unknown>; message?: string }

function fakeBinding(frames: () => FrameReply) {
  let nextSession = 0;
  const taken = new Map<number, number>();
  const readers = new Map<number, (bytes: Uint8Array, throughSeq: number) => void>();
  const enders = new Map<number, (reason: string) => void>();
  const recovery: Array<Record<string, unknown>> = [];
  const detached: number[] = [];
  const binding: TerminalSessionBinding = {
    open: vi.fn(async () => ++nextSession),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    detach: vi.fn(async (session: number) => { detached.push(session); }),
    onData: (session, callback) => { readers.set(session, callback); return { dispose: () => readers.delete(session) }; },
    onEnd: (session, callback) => { enders.set(session, callback); return { dispose: () => enders.delete(session) }; },
    paneAlive: vi.fn(async () => false),
    recoveryRequest: vi.fn(async (request: Record<string, unknown>) => {
      recovery.push(request);
      switch (request.op) {
        case "prepareSession": return { ok: true, code: "OK", data: { observerToken: "observer" } };
        case "archived": return { ok: false, code: "NOT_FOUND", message: "none" };
        case "frame": return { ...frames(), request } as Record<string, unknown>;
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
  const emitEnd = (session: number, reason: string) => enders.get(session)?.(reason);
  return { binding, recovery, detached, emit, emitEnd };
}

const mounted: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(mounted.splice(0).map((pane) => pane.stop()));
});

function mount(binding: TerminalSessionBinding, extra: Partial<Parameters<typeof createPaneSession>[0]> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const observed: Uint8Array[] = [];
  const pane = createPaneSession({
    key: "tab-a.2", viewId: "tab-a", engineId: "vt100", binding, root, nodeSuffix: "2",
    config: { pluginId: "plugin", engineId: "vt100" },
    observe: (bytes) => observed.push(bytes), publish: () => {},
    ...extra,
  });
  mounted.push(pane);
  return { pane, root, observed };
}

describe("pane session", () => {
  it("keeps a fresh pane input-blocked until the first PTY output event", async () => {
    const { binding, emit } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["prompt"]) } }));
    const renderer = {
      delivery: "bytes", rendererId: "test-bytes", rendererProfile: "web",
      create: (root: HTMLElement) => ({
        root, size: () => ({ cols: 80, rows: 24 }),
        writeOutput: async () => {}, applySnapshot: async () => {}, onRendered: () => ({ dispose() {} }),
        read: () => "", waitForText: async () => "", focus: () => true, dispose() {},
      }),
    } as never;
    const { pane } = mount(binding, { config: { pluginId: "plugin", engineId: "test", renderer } });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.writable).toBe(false);
    pane.sendInput("typed-too-early");
    expect(binding.write).not.toHaveBeenCalled();
    emit(1, new TextEncoder().encode("prompt "));
    await vi.waitFor(() => expect(pane.writable).toBe(true));
  });

  it("requests frames for its own subscriber after the exact sequence and applies full then delta frames", async () => {
    let served = 0;
    const { binding, recovery, emit } = fakeBinding(() => {
      served += 1;
      const request = recovery.at(-1)!;
      return { ok: true, data: { outputSequence: Number(request.afterSequence ?? 0), ...(served === 1 ? frameOf(["ab", "cd"]) : frameOf(["", "xy"], false)) } };
    });
    const { pane, root, observed } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    emit(1, new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(pane.presenter.read()).toBe("ab\ncd"));
    expect(recovery.find((request) => request.op === "frame")).toMatchObject({
      pane: "tab-a.2", subscriber: "tab-a.2#1", afterSequence: 3, offset: 0, timeoutMs: 2000,
    });
    emit(1, new Uint8Array([4]));
    await vi.waitFor(() => expect(pane.presenter.read()).toBe("ab\nxy"));
    expect(root.querySelector('[data-node="terminal-screen/2"]')).not.toBeNull();
    expect(observed.map((bytes) => [...bytes])).toEqual([[1, 2, 3], [4]]);
    expect(pane.renderedOutputSequence).toBe(4);
  });

  // Every frame request names the subscriber whose baseline it advances. A request without one is
  // refused, and the pane that made it stays blocked with nothing on screen.
  it("names the subscriber on the frame it asks for after a resize", async () => {
    const { binding, recovery } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab", "cd"]) } }));
    const { pane, root } = mount(binding, { hostPixels: () => ({ width: 400, height: 200 }) });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    pane.requestResize();
    await vi.waitFor(() => expect(recovery.some((request) => request.op === "waitSize")).toBe(true));
    await vi.waitFor(() => {
      const after = recovery.slice(recovery.findIndex((request) => request.op === "waitSize"));
      expect(after.some((request) => request.op === "frame")).toBe(true);
    });
    const resizeFrame = recovery.slice(recovery.findIndex((request) => request.op === "waitSize"))
      .find((request) => request.op === "frame")!;
    expect(resizeFrame.subscriber).toBe("tab-a.2#1");
    expect(root.querySelector('[data-node="terminal-screen/2"]')).not.toBeNull();
  });

  it("treats a timed-out frame poll as no frame and re-arms only while output is ahead", async () => {
    let served = 0;
    const { binding, recovery, emit } = fakeBinding(() => {
      served += 1;
      if (served === 1) return { ok: false, code: "TIMEOUT", message: "no output" };
      return { ok: true, data: { outputSequence: 2, ...frameOf(["ok"]) } };
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    emit(1, new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(pane.presenter.read()).toBe("ok"));
    expect(recovery.filter((request) => request.op === "frame")).toHaveLength(2);
    expect(pane.status.current()).toMatchObject({ phase: "live", failure: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recovery.filter((request) => request.op === "frame")).toHaveLength(2);
  });

  it("scrolls by lines, offset and edge, clamps to the last history size and keeps the reply's offset", async () => {
    const { binding, recovery, emit } = fakeBinding(() => {
      const request = recovery.at(-1)!;
      const asked = Number(request.offset ?? 0);
      return { ok: true, data: { outputSequence: Number(request.afterSequence ?? 1), offset: Math.min(asked, 40), historySize: 100, ...frameOf(["ab"]) } };
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    emit(1, new Uint8Array([1]));
    await vi.waitFor(() => expect(pane.historySize).toBe(100));
    await expect(pane.scroll({ lines: 10 })).resolves.toEqual({ pane: "tab-a.2", offset: 10, historySize: 100, followMode: "pinned" });
    const forced = recovery.filter((request) => request.op === "frame").at(-1)!;
    expect(forced).toMatchObject({ offset: 10 });
    expect(forced).not.toHaveProperty("afterSequence");
    await expect(pane.scroll({ offset: 500 })).resolves.toMatchObject({ offset: 40 });
    await expect(pane.scroll({ edge: "top" })).resolves.toMatchObject({ offset: 40 });
    await expect(pane.scroll({ edge: "bottom" })).resolves.toMatchObject({ offset: 0 });
    emit(1, new Uint8Array([2]));
    await vi.waitFor(() => expect(pane.renderedOutputSequence).toBe(2));
    expect(recovery.filter((request) => request.op === "frame").at(-1)).toMatchObject({ offset: 0, afterSequence: 2 });
  });

  it("publishes a frame status event only after its history and viewport state is current", async () => {
    const { binding, emit } = fakeBinding(() => ({
      ok: true,
      data: { outputSequence: 1, offset: 120, historySize: 120, ...frameOf(["marker"]) },
    }));
    const { pane, root } = mount(binding);
    await pane.status.wait(["live"], 1000);
    const published = new Promise<{ historySize: number; offset: number; followMode: string }>((resolve) => {
      root.addEventListener("soksak:terminal-status", () => resolve({
        historySize: pane.historySize,
        offset: pane.offset,
        followMode: pane.followMode,
      }), { once: true });
    });

    emit(1, new Uint8Array([1]));

    await expect(published).resolves.toEqual({
      historySize: 120,
      offset: 120,
      followMode: "pinned",
    });
  });

  it("routes a presenter's viewport request through the frame authority", async () => {
    let requestViewport: ((offset: number) => void) | undefined;
    const { binding, recovery, emit } = fakeBinding(() => {
      const request = recovery.at(-1)!;
      return {
        ok: true,
        data: {
          outputSequence: Number(request.afterSequence ?? 1),
          offset: Number(request.offset ?? 0), historySize: 100, ...frameOf(["ab"]),
        },
      };
    });
    const { pane } = mount(binding, {
      presenterFactory(root, send, options) {
        requestViewport = (options as typeof options & { requestViewport?: (offset: number) => void }).requestViewport;
        return defaultTerminalPresenterFactory(root, send, options);
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    emit(1, new Uint8Array([1]));
    await vi.waitFor(() => expect(pane.historySize).toBe(100));

    expect(requestViewport).toBeTypeOf("function");
    requestViewport!(30);
    await vi.waitFor(() => {
      expect(recovery.filter((request) => request.op === "frame").at(-1)).toMatchObject({ offset: 30 });
    });
    expect(pane.offset).toBe(30);
  });

  it("owns one suffixed restore-status notice per pane", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, data: {} }));
    (binding.recoveryRequest as ReturnType<typeof vi.fn>).mockImplementation(async (request: Record<string, unknown>) => {
      if (request.op === "archived") return { ok: false, code: "CHECKPOINT_CORRUPT", message: "missing cursor" };
      if (request.op === "prepareSession") return { ok: true, code: "OK", data: { observerToken: "observer" } };
      return { ok: true, code: "OK", data: {} };
    });
    const { pane, root } = mount(binding);
    const notice = root.querySelector<HTMLElement>('[data-node="terminal-restore-status/2"]')!;
    expect(notice).not.toBeNull();
    expect(root.querySelector('[data-node="terminal-restore-status"]')).toBeNull();
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("CHECKPOINT_REJECTED");
    expect(notice.style.pointerEvents).toBe("none");
  });

  it("tracks the last output time, resolves an idle wait, and keeps the last cwd report", async () => {
    const { binding, emit } = fakeBinding(() => ({ ok: true, data: { outputSequence: 1, ...frameOf(["a"]) } }));
    const { pane } = mount(binding, { cwd: "/start" });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.lastOutputAtUnixMs).toBeNull();
    expect(pane.cwd()).toBe("/start");
    emit(1, new TextEncoder().encode("\x1b]7;file://host/work/one\x07"));
    emit(1, new TextEncoder().encode("\x1b]7;file://host/work/two\x07 partial \x1b]7;file://host/x"));
    expect(pane.lastOutputAtUnixMs).not.toBeNull();
    expect(new TextDecoder().decode(pane.lastCwdReport()!)).toBe("\x1b]7;file://host/work/two\x07");
    expect(pane.cwd()).toBe("/work/two");
    let settled = false;
    const idle = pane.waitIdle(60, 1000).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    emit(1, new Uint8Array([1]));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    await idle;
    expect(settled).toBe(true);
    await expect(pane.waitIdle(1000, 20)).rejects.toThrow("idle wait timed out");
  });
});

// A renderer that takes bytes still mounts inside a pane, so it is told which pane's nodes it owns.
describe("a byte-delivery renderer", () => {
  it("is told the pane's node suffix and the pane's box", () => {
    const seen: Array<{ pane: string; options: unknown }> = [];
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane } = mount(binding, {
      config: {
        pluginId: "plugin", engineId: "vt100", containerGeneration: 17,
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement, key: string, _send: (text: string) => void, options: unknown) => {
            seen.push({ pane: key, options });
            const screen = root.ownerDocument.createElement("pre");
            root.append(screen);
            return {
              root, screen, input: root.ownerDocument.createElement("textarea"),
              read: () => "", size: () => ({ cols: 0, rows: 0 }), measure: () => ({ cols: 0, rows: 0 }),
              focus: () => true, dispose: () => {},
              writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
            } as never;
          },
        },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].pane).toBe("tab-a.2");
    expect(seen[0].options).toMatchObject({ nodeSuffix: "2", containerGeneration: 17 });
    expect(typeof (seen[0].options as { hostPixels: unknown }).hostPixels).toBe("function");
    void pane;
  });

  it("acknowledges capture preparation only while shown", async () => {
    const prepareCapture = vi.fn(async () => {});
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane, root } = mount(binding, {
      config: {
        pluginId: "plugin", engineId: "vt100",
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement) => ({
            root, read: () => "", size: () => ({ cols: 80, rows: 24 }),
            focus: () => true, dispose: () => {}, prepareCapture,
            writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
            waitForText: async () => "",
          } as never),
        },
      },
    });
    const waits: Promise<void>[] = [];
    const prepare = (scope: HTMLElement | Window) => scope.dispatchEvent(new CustomEvent("soksak:capture-prepare", {
      detail: { waitUntil: (promise: Promise<void>) => { waits.push(promise); } },
      bubbles: true,
    }));

    const unrelated = document.createElement("div");
    document.body.append(unrelated);
    prepare(unrelated);
    expect(prepareCapture).not.toHaveBeenCalled();

    const owner = document.createElement("div");
    owner.append(root);
    document.body.append(owner);
    prepare(owner);
    await Promise.all(waits.splice(0));
    expect(prepareCapture).toHaveBeenCalledOnce();

    pane.setHostPresentation(false, 0);
    prepare(owner);
    expect(prepareCapture).toHaveBeenCalledOnce();
  });
});

// The scroll command answers the same way whichever renderer paints the pane: a renderer that owns
// its own scrollback is asked to move, and its own position is what the reply reports.
describe("scrolling a byte-delivery pane", () => {
  it("moves the renderer's own scrollback and reports its position", async () => {
    let offset = 0;
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane } = mount(binding, {
      config: {
        pluginId: "plugin", engineId: "vt100",
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement) => ({
            root, screen: root, input: root.ownerDocument.createElement("textarea"),
            read: () => "", size: () => ({ cols: 0, rows: 0 }), measure: () => ({ cols: 0, rows: 0 }),
            focus: () => true, dispose: () => {},
            writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
            scrollState: () => ({ offset, historySize: 120 }),
            scrollLines: async (lines: number) => {
              await Promise.resolve();
              offset = Math.max(0, Math.min(120, offset + lines));
            },
            scrollTo: async (next: number) => {
              await Promise.resolve();
              offset = Math.max(0, Math.min(120, next));
            },
          } as never),
        },
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect({ offset: pane.offset, historySize: pane.historySize }).toEqual({ offset: 0, historySize: 120 });
    await expect(pane.scroll({ lines: 40 })).resolves.toMatchObject({ offset: 40, historySize: 120, followMode: "pinned" });
    expect({ offset: pane.offset, historySize: pane.historySize }).toEqual({ offset: 40, historySize: 120 });
    await expect(pane.scroll({ edge: "top" })).resolves.toMatchObject({ offset: 120 });
    await expect(pane.scroll({ edge: "bottom" })).resolves.toMatchObject({ offset: 0, followMode: "follow" });
    await expect(pane.scroll({ offset: 500 })).resolves.toMatchObject({ offset: 120 });
  });

  it("sends an absolute offset to the renderer even before its history snapshot arrives", async () => {
    let state = { offset: 0, historySize: 0 };
    const requested: number[] = [];
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane } = mount(binding, {
      config: {
        pluginId: "plugin", engineId: "vt100",
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement) => ({
            root, screen: root, input: root.ownerDocument.createElement("textarea"),
            read: () => "", size: () => ({ cols: 0, rows: 0 }), measure: () => ({ cols: 0, rows: 0 }),
            focus: () => true, dispose: () => {},
            writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
            scrollState: () => state,
            scrollLines: async () => {},
            scrollTo: async (next: number) => {
              requested.push(next);
              state = { offset: Math.min(next, 52), historySize: 52 };
            },
          } as never),
        },
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await expect(pane.scroll({ offset: 10 })).resolves.toEqual({
      pane: "tab-a.2", offset: 10, historySize: 52, followMode: "pinned",
    });
    expect(requested).toEqual([10]);
  });
});

// Detaching keeps a session for the pane to reattach to; closing ends it. A pane the caller closed
// is never coming back, so its session and its shell end with it.
describe("ending a pane", () => {
  it("detaches when the pane is only unmounted and closes when the pane is gone", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const first = mount(binding);
    await vi.waitFor(() => expect(first.pane.status.current().phase).toBe("live"));
    await first.pane.stop();
    expect(binding.detach).toHaveBeenCalledTimes(1);
    expect(binding.close).not.toHaveBeenCalled();

    const second = mount(binding);
    await vi.waitFor(() => expect(second.pane.status.current().phase).toBe("live"));
    await second.pane.stop("close");
    expect(binding.close).toHaveBeenCalledTimes(1);
    expect(binding.detach).toHaveBeenCalledTimes(1);
  });
});

// A pane that is not live states why inside itself. A blank screen with nothing written on it is a
// pane the reader cannot tell apart from an idle shell.
describe("a pane that is not live", () => {
  it("states the phase it is in, in the pane", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane, root } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    const notice = root.querySelector<HTMLElement>('[data-node="terminal-restore-status/2"]')!;
    expect(notice.hidden).toBe(true);

    pane.status.set("archived", { recoveryOutcome: "archived" });
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("archived");
  });
});

// Fitting the renderer to the pane is display, not session. A pane with no session still shows the
// whole box; a renderer left at its own default fills only the top of the pane.
describe("a pane with no session", () => {
  it("still fits its renderer to the pane box", async () => {
    const fits: number[] = [];
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => { throw new Error("no shell here"); });
    const { pane } = mount(binding, {
      hostPixels: () => ({ width: 800, height: 400 }),
      config: {
        pluginId: "plugin", engineId: "vt100",
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement) => ({
            root, screen: root, input: root.ownerDocument.createElement("textarea"),
            read: () => "", size: () => ({ cols: 0, rows: 0 }), measure: () => ({ cols: 100, rows: 25 }),
            fit: () => { fits.push(1); },
            focus: () => true, dispose: () => {},
            writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
          } as never),
        },
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("blocked"));
    await vi.waitFor(() => expect(fits.length).toBeGreaterThan(0));
  });
});

// A pane nobody can see is a pane nothing has to be painted for. It keeps its session and its
// output, and it asks for a frame again when it is shown.
describe("a pane that is not shown", () => {
  it("stops asking for frames until it is shown again", async () => {
    let served = 0;
    const { binding, recovery, emit } = fakeBinding(() => {
      served += 1;
      return { ok: true, data: { outputSequence: served + 1, ...frameOf(["ab"]) } };
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    emit(1, new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(recovery.filter((r) => r.op === "frame").length).toBeGreaterThan(0));

    pane.setHostPresentation(false, 0);
    const asked = recovery.filter((r) => r.op === "frame").length;
    emit(1, new Uint8Array([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recovery.filter((r) => r.op === "frame").length).toBe(asked);

    pane.setHostPresentation(true, 0);
    await vi.waitFor(() => expect(recovery.filter((r) => r.op === "frame").length).toBeGreaterThan(asked));
  });

  it("refreshes a byte renderer when it is shown again", async () => {
    const refresh = vi.fn();
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane } = mount(binding, {
      config: {
        pluginId: "plugin", engineId: "vt100",
        renderer: {
          delivery: "bytes" as const, rendererId: "probe",
          create: (root: HTMLElement) => ({
            root, read: () => "", size: () => ({ cols: 80, rows: 24 }),
            focus: () => true, refresh, dispose: () => {},
            writeOutput: () => {}, applySnapshot: () => {}, onRendered: () => ({ dispose: () => {} }),
            waitForText: async () => "",
          } as never),
        },
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    pane.setHostPresentation(false, 0);
    pane.setHostPresentation(true, 0);

    expect(refresh).toHaveBeenCalledOnce();
  });
});

// A terminal pane is where a shell runs. An archive is what the last one left on screen, and the
// pane shows it and then starts a shell, so the pane can be typed into again.
describe("a pane whose session ended", () => {
  it("shows what was archived and starts a shell", async () => {
    const { binding, recovery } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.paneAlive = vi.fn(async () => false);
    const original = binding.recoveryRequest;
    binding.recoveryRequest = vi.fn(async (request: Record<string, unknown>) => {
      if (request.op === "archived") {
        recovery.push(request);
        return { ok: true, code: "OK", data: { uptoSeq: 4, frame: frameOf(["old"]) } };
      }
      return original(request);
    }) as never;
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.status.current().recoveryOutcome).toBe("archived");
    expect(pane.writable).toBe(true);
    expect(binding.open).toHaveBeenCalled();
  });
});

// A write that fails has lost the input and the session with it. The pane starts a session again
// rather than standing blocked until something remounts it.
describe("a pane whose write failed", () => {
  it("starts a session again and takes input", async () => {
    let sessions = 0;
    let refuse = false;
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    binding.write = vi.fn(async () => {
      if (refuse) throw new Error("no session 1 in this daemon");
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(sessions).toBe(1);

    refuse = true;
    pane.sendInput("a");
    await vi.waitFor(() => expect(sessions).toBe(2));
    refuse = false;
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.writable).toBe(true);
  });
  it("restarts after a public pane write fails", async () => {
    let sessions = 0;
    let refuse = false;
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    binding.write = vi.fn(async () => { if (refuse) throw new Error("no session 1 in this daemon"); });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    refuse = true;
    await expect(pane.write("a")).rejects.toThrow("no session 1");
    await vi.waitFor(() => expect(sessions).toBe(2));
  });
});

describe("a pane whose PTY stream ended", () => {
  it("restarts without waiting for another input", async () => {
    let sessions = 0;
    const { binding, emitEnd } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    emitEnd(1, "PTY sidecar ended");
    await vi.waitFor(() => expect(sessions).toBe(2));
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.status.current().failure).toBeNull();
  });
  it("renders the new session when its output sequence starts below the ended session", async () => {
    let outputSequence = 0;
    let text = "old";
    const { binding, emit, emitEnd } = fakeBinding(() => ({
      ok: true, data: { outputSequence, ...frameOf([text]) },
    }));
    const open = binding.open;
    binding.open = vi.fn(async (...args: Parameters<typeof open>) => {
      const session = await open(...args);
      if (session === 2) outputSequence = 0;
      return session;
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    outputSequence = 4;
    emit(1, new Uint8Array([1, 2, 3, 4]));
    await vi.waitFor(() => expect(pane.presenter.read()).toBe("old"));
    emitEnd(1, "PTY sidecar ended");
    await vi.waitFor(() => expect(binding.open).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    outputSequence = 1;
    text = "new";
    emit(2, new Uint8Array([9]));
    await vi.waitFor(() => expect(pane.presenter.read()).toBe("new"));
    expect(pane.renderedOutputSequence).toBe(1);
  });
});

// A frame the engine has no mirror for is a session that is gone. The pane starts one again.
describe("a pane whose mirror is gone", () => {
  it("starts a session again rather than standing blocked", async () => {
    let sessions = 0;
    let missing = false;
    const { binding, detached, emit } = fakeBinding(() => (missing
      ? { ok: false, code: "NOT_FOUND", message: "no live terminal-state mirror for this key" }
      : { ok: true, data: { outputSequence: 9, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => {
      sessions += 1;
      if (sessions === 2) missing = false;
      return sessions;
    });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(sessions).toBe(1);

    missing = true;
    emit(1, new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(sessions).toBeGreaterThan(1), { timeout: 4000 });
    await vi.waitFor(() => expect(detached).toContain(1));
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.status.current().failure).toBeNull();
    expect(pane.presenter.size()).toEqual({ cols: 4, rows: 1 });
    // The pane waits between tries rather than starting over as fast as it can.
    const spent = sessions;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sessions).toBe(spent);
  });

  it("does not request another frame while the failed session detaches", async () => {
    let missing = false;
    let frameRequests = 0;
    const { binding, emit } = fakeBinding(() => {
      frameRequests += 1;
      return missing
        ? { ok: false, code: "NOT_FOUND", message: "no live terminal-state mirror for this key" }
        : { ok: true, data: { outputSequence: 1, ...frameOf(["ab"]) } };
    });
    let releaseDetach!: () => void;
    const detaching = new Promise<void>((resolve) => { releaseDetach = resolve; });
    binding.detach = vi.fn(async () => detaching);
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    const before = frameRequests;

    missing = true;
    emit(1, new Uint8Array([1]));
    await vi.waitFor(() => expect(binding.detach).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(frameRequests).toBe(before + 1);
    releaseDetach();
  });
});

describe("a pane before its first frame", () => {
  it("does not publish live until the renderer has nonzero dimensions", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    const { pane } = mount(binding, { hostPixels: () => ({ width: 400, height: 200 }) });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.presenter.size()).toEqual({ cols: 4, rows: 1 });
  });
});

// A pane is live when it has a session. Reporting live without one hands every later write to a
// number nothing serves, and the pane looks ready while nothing it is typed into arrives.
describe("a pane opened without a session", () => {
  it("is blocked with the reason rather than reported live", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => Number.NaN);
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("blocked"));
    expect(pane.status.current().failure?.code).toBe("START_FAILED");
    expect(String(pane.status.current().failure?.message)).toContain("session");
  });
});

// A pane that came back carries no reason to be worried about. The failure that took it down is
// what it showed while it was down, and it goes when the pane is live again.
describe("a pane that came back", () => {
  it("clears the failure it was showing", async () => {
    let sessions = 0;
    let refuse = false;
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    binding.write = vi.fn(async () => { if (refuse) throw new Error("no session 1 in this daemon"); });
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    refuse = true;
    pane.sendInput("a");
    await vi.waitFor(() => expect(sessions).toBe(2));
    refuse = false;
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await vi.waitFor(() => expect(pane.status.current().failure).toBeNull());
  });
});

// A pane that cannot reach its terminal keeps trying. Giving up leaves a tab nothing can bring back,
// and the thing it waits for — a daemon coming back — is exactly what happens a moment later.
describe("a pane that cannot reach its terminal", () => {
  it("keeps trying and comes back when it can", async () => {
    let sessions = 0;
    let broken = true;
    const { binding, emit } = fakeBinding(() => (broken
      ? { ok: false, code: "NOT_FOUND", message: "no live terminal-state mirror for this key" }
      : { ok: true, data: { outputSequence: 12, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    broken = false;
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));

    broken = true;
    emit(1, new Uint8Array([1, 2, 3]));
    const gaveUp = sessions;
    // The pane is still trying while it is down.
    await vi.waitFor(() => expect(sessions).toBeGreaterThan(gaveUp), { timeout: 8000 });

    broken = false;
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"), { timeout: 8000 });
    expect(pane.status.current().failure).toBeNull();
  }, 20000);
});

// A pane whose engine missed part of the output cannot be shown as it was. The screen it lost is
// lost; the shell behind it is not, so the pane attaches to that shell instead of failing forever.
describe("a pane whose engine missed output", () => {
  it("attaches to the shell instead of failing on the gap", async () => {
    let sessions = 0;
    const { binding } = fakeBinding(() => ({ ok: true, data: { outputSequence: 0, ...frameOf(["ab"]) } }));
    binding.paneAlive = vi.fn(async () => true);
    binding.open = vi.fn(async () => ++sessions);
    const original = binding.recoveryRequest;
    binding.recoveryRequest = vi.fn(async (request: Record<string, unknown>) => {
      if (request.op === "rehydrate") {
        return { ok: false, code: "SOURCE_GAP", message: "the terminal-state observer missed source events" };
      }
      return original(request);
    }) as never;
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("degraded-tail"));
    expect(pane.writable).toBe(true);
    expect(sessions).toBe(1);
    expect(pane.status.current()).toMatchObject({
      recoveryOutcome: "degraded-tail",
      fidelity: "unavailable",
      failure: { code: "SOURCE_GAP" },
    });
  });
});

// A surface renderer draws outside the webview: the sidecar paints and the app composes. The pane
// keeps the split, the restore state and the commands, and it opens no session, polls no frame and
// writes no byte itself — every one of those is the surface owner's.
describe("surface delivery", () => {
  function surfacePresenter(root: HTMLElement, ready: Promise<void> = Promise.resolve()) {
    const sent: string[] = [];
    const state = { offset: 0, historySize: 100, disposed: false, rendered: 42 };
    const screen = root.ownerDocument.createElement("div");
    screen.dataset.node = "terminal-screen";
    root.append(screen);
    let presentationChanged: (() => void) | null = null;
    let themeStatus = readTerminalThemeStatus(document.documentElement);
    const themeUpdates: typeof themeStatus[] = [];
    const presenter = {
      root,
      size: () => ({ cols: 80, rows: 24 }),
      fit: undefined as TerminalPresenter["fit"],
      read: () => "surface",
      waitForText: async () => "surface",
      ready: () => ready,
      focus: () => true,
      sendText: async (data: string) => { sent.push(data); },
      renderedOutputSequence: () => state.rendered,
      scrollState: () => ({ offset: state.offset, historySize: state.historySize }),
      scrollLines: (lines: number) => {
        state.offset = Math.max(0, Math.min(state.historySize, state.offset + lines));
      },
      scrollTo: (offset: number) => { state.offset = offset; },
      onPresentationChanged: (callback: () => void) => {
        presentationChanged = callback;
        return { dispose: () => { presentationChanged = null; } };
      },
      themeStatus: () => themeStatus,
      setTheme: (next: typeof themeStatus) => {
        themeStatus = next;
        themeUpdates.push(next);
      },
      refresh: () => {},
      dispose: () => { state.disposed = true; },
    };
    return {
      presenter, sent, state, screen, themeUpdates,
      presentationChanged: () => presentationChanged?.(),
      overrideForeground(foreground: string) {
        const terminalOverrides = { ...themeStatus.terminalOverrides, foreground };
        themeStatus = {
          ...themeStatus,
          terminalOverrides,
          effectiveTheme: resolveTerminalTheme(themeStatus.baseTheme, terminalOverrides),
        };
      },
    };
  }
  const surfaceAdapter = (ready: Promise<void> = Promise.resolve()) => {
    let last: ReturnType<typeof surfacePresenter> | null = null;
    let receivedOptions: Record<string, unknown> | null = null;
    const adapter = {
      delivery: "surface",
      rendererId: "vision-surface",
      rendererProfile: "native-surface",
      create: (root: HTMLElement, _pane: string, _send: (text: string) => void, options: Record<string, unknown>) => {
        receivedOptions = options;
        last = surfacePresenter(root, ready);
        return last.presenter;
      },
    } as never;
    return { adapter, created: () => last!, options: () => receivedOptions };
  };
  const surfaceMount = (adapter: never, extra: Partial<Parameters<typeof createPaneSession>[0]> = {}) => {
    const { binding, recovery } = fakeBinding(() => ({ ok: true, data: {} }));
    const view = mount(binding, {
      config: { pluginId: "plugin", engineId: "vt100", renderer: adapter }, ...extra,
    });
    return { ...view, binding, recovery };
  };

  it("gives the surface owner the pane's declared initial cwd", () => {
    const { adapter, options } = surfaceAdapter();
    surfaceMount(adapter, { cwd: "/workspace/project" });
    expect(options()).toMatchObject({ cwd: "/workspace/project" });
  });

  it("opens no session and polls no frame", async () => {
    const { adapter } = surfaceAdapter();
    const { pane, binding, recovery } = surfaceMount(adapter);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(binding.open).not.toHaveBeenCalled();
    expect(recovery).toEqual([]);
    expect(pane.status.current().rendererProfile).toBe("native-surface");
    expect(pane.status.current().presentation.delivery).toBe("surface");
    expect(pane.root.dataset.terminalOperation).toBe("ready");
  });

  it("records the exact size returned by an asynchronous surface fit", async () => {
    const { adapter, created } = surfaceAdapter();
    const { pane } = surfaceMount(adapter, { hostPixels: () => ({ width: 739, height: 468 }) });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    created().presenter.fit = vi.fn(async () => ({ cols: 94, rows: 30 }));
    pane.requestResize();
    await vi.waitFor(() => expect(pane.requestedSize).toEqual({ cols: 94, rows: 30 }));
  });

  it("does not publish live or writable before the surface owner is ready", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const { adapter } = surfaceAdapter(ready);
    const { pane } = surfaceMount(adapter);
    await Promise.resolve();
    expect(pane.status.current().phase).not.toBe("live");
    expect(pane.writable).toBe(false);
    release();
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.writable).toBe(true);
  });

  it("routes input through the presenter and never the pty", async () => {
    const { adapter, created } = surfaceAdapter();
    const { pane, binding } = surfaceMount(adapter);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await pane.write("ls\r");
    pane.sendInput("x");
    await vi.waitFor(() => expect(created().sent).toEqual(["ls\r", "x"]));
    expect(binding.write).not.toHaveBeenCalled();
  });

  it("reports the presenter's rendered sequence and scroll state", async () => {
    const { adapter, created } = surfaceAdapter();
    const { pane } = surfaceMount(adapter);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(pane.renderedOutputSequence).toBe(42);
    const moved = await pane.scroll({ lines: 10 });
    expect(moved).toEqual({ pane: "tab-a.2", offset: 10, historySize: 100, followMode: "pinned" });
    expect(created().state.offset).toBe(10);
  });

  it("publishes a surface presenter's engine-driven presentation changes", async () => {
    const published: Array<Record<string, unknown>> = [];
    const { adapter, created } = surfaceAdapter();
    const { binding } = fakeBinding(() => ({ ok: true, data: {} }));
    const { pane } = mount(binding, {
      config: { pluginId: "plugin", engineId: "vt100", renderer: adapter },
      publish: (value) => published.push(value as unknown as Record<string, unknown>),
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    const before = published.length;
    created().screen.dataset.cursorShape = "bar";
    created().screen.dataset.cursorBlinking = "true";
    created().overrideForeground("#abcdef");
    created().presentationChanged();
    expect(published).toHaveLength(before + 1);
    expect(published.at(-1)).toMatchObject({
      presentation: {
        cursorShape: "bar", cursorBlinking: true,
        terminalOverrides: { foreground: "#abcdef" },
        effectiveTheme: { foreground: "#abcdef" },
      },
    });
  });

  it("delivers one declared host theme update at the theme epoch edge", async () => {
    const { adapter, created } = surfaceAdapter();
    const { pane } = surfaceMount(adapter);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    const root = document.documentElement;
    root.dataset.themeMode = "light";
    root.style.setProperty("--card", "#f0f0f0");
    root.style.setProperty("--fg", "#202020");
    root.dataset.themeEpoch = String(Number(root.dataset.themeEpoch ?? "0") + 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(created().themeUpdates).toHaveLength(1);
    expect(pane.status.current().presentation).toMatchObject({
      themeMode: "light",
      baseTheme: { background: "#f0f0f0", foreground: "#202020" },
      effectiveTheme: { background: "#f0f0f0", foreground: "#202020" },
    });
    root.dataset.themeMode = "dark";
    root.style.setProperty("--card", "#1e1e1e");
    root.style.setProperty("--fg", "#eeeeec");
    await pane.stop();
  });

  it("refuses a surface renderer with no input path by name", () => {
    const { adapter } = surfaceAdapter();
    const broken = {
      ...(adapter as Record<string, unknown>),
      create: (root: HTMLElement) => {
        const { presenter } = surfacePresenter(root);
        return { ...presenter, sendText: undefined };
      },
    } as never;
    const root = document.createElement("div");
    document.body.append(root);
    expect(() => createPaneSession({
      key: "tab-a.2", viewId: "tab-a", engineId: "vt100",
      binding: fakeBinding(() => ({ ok: true })).binding, root, nodeSuffix: "2",
      config: { pluginId: "plugin", engineId: "vt100", renderer: broken },
      observe: () => {}, publish: () => {},
    })).toThrow(/sendText/);
  });

  it("stops without touching a pty session", async () => {
    const { adapter, created } = surfaceAdapter();
    const { pane, binding } = surfaceMount(adapter);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await pane.stop("close");
    expect(binding.close).not.toHaveBeenCalled();
    expect(binding.detach).not.toHaveBeenCalled();
    expect(created().state.disposed).toBe(true);
  });
});

describe("visibility state and the presenter", () => {
  it("hands intrinsic pane visibility to a presenter without rewriting host visibility", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, code: "OK", data: { full: true, cols: 4, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, lines: [] } }));
    const states: Array<{ intrinsicVisible: boolean; hostVisible: boolean }> = [];
    const { pane } = mount(binding, {
      presenterFactory: (root, send, options) => {
        const presenter = defaultTerminalPresenterFactory(root, send, options);
        return { ...presenter, setVisibility: (value) => { states.push(value); } };
      },
    });
    states.length = 0;
    pane.setIntrinsicVisible(false);
    pane.setIntrinsicVisible(true);
    expect(states).toEqual([
      expect.objectContaining({ intrinsicVisible: false, hostVisible: true }),
      expect.objectContaining({ intrinsicVisible: true, hostVisible: true }),
    ]);
  });

  it("keeps host presentation and intrinsic pane visibility as separate status axes", async () => {
    const { binding } = fakeBinding(() => ({ ok: true, code: "OK", data: { full: true, cols: 4, rows: 1, cursor: [0, 0], cursorVisible: false, altActive: false, lines: [] } }));
    const states: Array<{ intrinsicVisible: boolean; hostVisible: boolean; effectiveVisible: boolean; dim: number }> = [];
    const { pane } = mount(binding, {
      presenterFactory: (root, send, options) => {
        const presenter = defaultTerminalPresenterFactory(root, send, options);
        return { ...presenter, setVisibility: (value) => { states.push(value); } };
      },
    });
    states.length = 0;
    pane.setHostPresentation(false, 0.5);
    pane.setIntrinsicVisible(false);
    expect(states).toEqual([
      { intrinsicVisible: true, hostVisible: false, effectiveVisible: false, dim: 0.5 },
      { intrinsicVisible: false, hostVisible: false, effectiveVisible: false, dim: 0.5 },
    ]);
    expect(pane.visibility).toEqual(states.at(-1));
  });
});
