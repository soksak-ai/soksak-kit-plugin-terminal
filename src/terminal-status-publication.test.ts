// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalStatusController } from "./terminal-status-publication";

const presentation = () => ({
  delivery: "frame" as const, mountSequence: 1, readySequence: null, renderSequence: 0, focusSequence: 0,
  acceptedInputSequence: 0, ptyWriteSequence: 0, focusedInput: false,
  bracketedPaste: false, selection: { active: false, text: "" },
  clipboardPermission: { read: false, write: false },
  drop: { fileGrantState: "unavailable" as const, last: null },
  cursorVisible: false, cursorActive: false, cursorRow: null, cursorColumn: null,
  mountedAtUnixMs: 1, firstVisibleFrameAtUnixMs: null, firstFocusableInputAtUnixMs: null,
  lastRenderedAtUnixMs: null, lastFocusedAtUnixMs: null, lastInputAtUnixMs: null, lastPtyWriteAtUnixMs: null,
  lastRenderDurationMs: null, maxRenderDurationMs: null, lastInputToPtyWriteMs: null,
  theme: {
    foreground: "#eeeeec", background: "#1e1e1e", cursor: "#ffffff",
    cursorAccent: "#1e1e1e", selectionBackground: "#555753",
  },
});

describe("terminal status publication", () => {
  it("publishes lifecycle state to status and observable DOM fields", () => {
    const root = document.createElement("div");
    const publish = vi.fn();
    const events: string[] = [];
    root.addEventListener("soksak:terminal-status", (event) => {
      events.push((event as CustomEvent<{ phase: string }>).detail.phase);
    });
    const controller = createTerminalStatusController({
      root, pluginId: "soksak-plugin-terminal-xterm", engineId: "vt100",
      rendererId: "xterm", rendererProfile: "web", publish, presentation,
    });
    controller.set("preparing-recovery");
    controller.set("live", { recoveryOutcome: "continued", fidelity: "complete" });
    expect(root.dataset).toMatchObject({
      terminalPhase: "live", terminalRecovery: "continued", terminalFidelity: "complete",
    });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "live" }));
    expect(controller.current()).toMatchObject({
      hostPixels: { width: 0, height: 0 }, requested: null, pty: null, recovery: null,
      rendered: null, operation: "initializing",
    });
    expect(events).toEqual(["initializing", "preparing-recovery", "live"]);
  });

  it("publishes a typed failure and clears it on recovery", () => {
    const root = document.createElement("div");
    const controller = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: () => undefined, presentation,
    });
    controller.set("blocked", {
      recoveryOutcome: "blocked", fidelity: "unavailable",
      failure: { code: "PROVIDER_UNAVAILABLE", message: "provider unavailable" },
    });
    expect(root.dataset.terminalFailure).toBe("PROVIDER_UNAVAILABLE");
    controller.set("live", { recoveryOutcome: "fresh", fidelity: "complete", failure: null });
    expect(root.dataset.terminalFailure).toBeUndefined();
  });

  it("waits on status publication without polling", async () => {
    const controller = createTerminalStatusController({
      root: document.createElement("div"), pluginId: "plugin", engineId: "engine",
      rendererId: "renderer", rendererProfile: "web", publish: () => undefined, presentation,
    });
    const reached = controller.wait(["live", "archived", "blocked"], 100);
    controller.set("preparing-recovery");
    controller.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    await expect(reached).resolves.toMatchObject({ phase: "live", fidelity: "complete" });
  });
});
