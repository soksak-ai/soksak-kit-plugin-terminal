// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaneSession } from "./pane-session";
import type { ProviderFrameRun, ProviderFrame } from "./provider-frame-presenter";
import type { TerminalSessionBinding } from "./terminal-session-binding";

for (const [name, value] of Object.entries({
  fg: "#eeeeec", card: "#1e1e1e", acc: "#ffffff", fg3: "#555753",
})) document.documentElement.style.setProperty(`--${name}`, value);

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
  const recovery: Array<Record<string, unknown>> = [];
  const detached: number[] = [];
  const binding: TerminalSessionBinding = {
    open: vi.fn(async () => ++nextSession),
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    detach: vi.fn(async (session: number) => { detached.push(session); }),
    onData: (session, callback) => { readers.set(session, callback); return { dispose: () => readers.delete(session) }; },
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
  };
  const emit = (session: number, bytes: Uint8Array) => {
    const throughSeq = (taken.get(session) ?? 0) + bytes.length;
    taken.set(session, throughSeq);
    readers.get(session)?.(bytes, throughSeq);
  };
  return { binding, recovery, detached, emit };
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
    await expect(pane.scroll({ lines: 10 })).resolves.toEqual({ pane: "tab-a.2", offset: 10, historySize: 100 });
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
        pluginId: "plugin", engineId: "vt100",
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
    expect(seen[0].options).toMatchObject({ nodeSuffix: "2" });
    expect(typeof (seen[0].options as { hostPixels: unknown }).hostPixels).toBe("function");
    void pane;
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
            scrollLines: (lines: number) => { offset = Math.max(0, Math.min(120, offset + lines)); },
            scrollTo: (next: number) => { offset = Math.max(0, Math.min(120, next)); },
          } as never),
        },
      },
    });
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    await expect(pane.scroll({ lines: 40 })).resolves.toMatchObject({ offset: 40, historySize: 120 });
    await expect(pane.scroll({ edge: "top" })).resolves.toMatchObject({ offset: 120 });
    await expect(pane.scroll({ edge: "bottom" })).resolves.toMatchObject({ offset: 0 });
    await expect(pane.scroll({ offset: 500 })).resolves.toMatchObject({ offset: 120 });
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

    pane.setShown(false);
    const asked = recovery.filter((r) => r.op === "frame").length;
    emit(1, new Uint8Array([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recovery.filter((r) => r.op === "frame").length).toBe(asked);

    pane.setShown(true);
    await vi.waitFor(() => expect(recovery.filter((r) => r.op === "frame").length).toBeGreaterThan(asked));
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
});

// A frame the engine has no mirror for is a session that is gone. The pane starts one again.
describe("a pane whose mirror is gone", () => {
  it("starts a session again rather than standing blocked", async () => {
    let sessions = 0;
    let missing = false;
    const { binding, emit } = fakeBinding(() => (missing
      ? { ok: false, code: "NOT_FOUND", message: "no live terminal-state mirror for this key" }
      : { ok: true, data: { outputSequence: 9, ...frameOf(["ab"]) } }));
    binding.open = vi.fn(async () => ++sessions);
    const { pane } = mount(binding);
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("live"));
    expect(sessions).toBe(1);

    missing = true;
    emit(1, new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(sessions).toBeGreaterThan(1));
    // A pane that never gets a frame back stops starting over: the reason is what it shows.
    await vi.waitFor(() => expect(pane.status.current().phase).toBe("blocked"));
    const spent = sessions;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sessions).toBe(spent);
    expect(pane.status.current().failure?.code).toBe("FRAME_FAILED");
  });
});
