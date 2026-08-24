// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalStatusController } from "./terminal-status-publication";
import { closedTerminalPresentation } from "./terminal-presentation-status";

const theme = {
  foreground: "#eeeeec", background: "#1e1e1e", cursor: "#ffffff",
  cursorAccent: "#1e1e1e", selectionBackground: "#555753",
};
import { waitForTerminalConditions } from "./terminal-condition-wait";

describe("terminal condition wait", () => {
  it("requires both the requested phase and screen text", async () => {
    const root = document.createElement("div");
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: vi.fn(),
      presentation: () => closedTerminalPresentation("frame", theme),
    });
    status.set("applying-snapshot", {
      recoveryOutcome: "continued", fidelity: "complete",
    });
    let settled = false;
    const waiting = waitForTerminalConditions({
      status, phase: "live", contains: "READY", timeoutMs: 1000,
      waitForText: async () => "READY",
    }).then((answer) => { settled = true; return answer; });

    await Promise.resolve();
    expect(settled).toBe(false);
    status.set("live", { recoveryOutcome: "continued", fidelity: "complete" });

    await expect(waiting).resolves.toMatchObject({ phase: "live", text: "READY" });
  });

  it("requires the requested terminal size as a separate event", async () => {
    const root = document.createElement("div");
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: vi.fn(),
      presentation: () => closedTerminalPresentation("frame", theme),
    });
    status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    let resolveSize!: (size: { cols: number; rows: number }) => void;
    const waiting = waitForTerminalConditions({
      status, phase: "live", timeoutMs: 1000,
      size: { colsLessThan: 90 },
      waitForText: vi.fn(),
      waitForSize: () => new Promise((resolve) => { resolveSize = resolve; }),
    });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveSize({ cols: 54, rows: 24 });
    await expect(waiting).resolves.toMatchObject({ phase: "live", cols: 54, rows: 24 });
  });

  it("requires cursor and focus readiness from status publication", async () => {
    const root = document.createElement("div");
    let presentation = closedTerminalPresentation("frame", theme);
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: vi.fn(), presentation: () => presentation,
    });
    status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    let settled = false;
    const waiting = waitForTerminalConditions({
      status, phase: "live", timeoutMs: 1000, waitForText: vi.fn(),
      presentation: { focusedInput: true, cursorVisible: true, cursorActive: true },
    }).then((answer) => { settled = true; return answer; });
    await Promise.resolve();
    expect(settled).toBe(false);
    presentation = {
      ...presentation, focusedInput: true, cursorVisible: true, cursorActive: true,
      cursorRow: 0, cursorColumn: 0,
    };
    status.refresh();
    await expect(waiting).resolves.toMatchObject({
      presentation: { focusedInput: true, cursorVisible: true, cursorActive: true },
    });
  });
});
