// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { emptyTerminalThemeOverrides, resolveTerminalTheme, TERMINAL_ANSI_PALETTE } from "@soksak/soksak-contract-plugin-terminal";
import { createTerminalStatusController } from "./terminal-status-publication";
import { closedTerminalPresentation } from "./terminal-presentation-status";

const baseTheme = {
  foreground: "#eeeeec", background: "#1e1e1e", cursor: "#ffffff",
  cursorAccent: "#1e1e1e", selectionBackground: "#555753", ansi: [...TERMINAL_ANSI_PALETTE],
};
const terminalOverrides = emptyTerminalThemeOverrides();
const theme = {
  themeMode: "dark" as const, baseTheme, terminalOverrides,
  effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
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

  it("waits for presented theme mode and effective background publication", async () => {
    const root = document.createElement("div");
    let presentation = closedTerminalPresentation("surface", theme);
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "native-surface", publish: vi.fn(), presentation: () => presentation,
    });
    status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    let settled = false;
    const waiting = waitForTerminalConditions({
      status, phase: "live", timeoutMs: 1000, waitForText: vi.fn(),
      theme: { themeMode: "light", effectiveBackground: "#f0f0f0" },
    }).then((answer) => { settled = true; return answer; });

    await Promise.resolve();
    expect(settled).toBe(false);
    const lightBase = { ...baseTheme, background: "#f0f0f0" };
    presentation = {
      ...presentation,
      themeMode: "light",
      baseTheme: lightBase,
      effectiveTheme: resolveTerminalTheme(lightBase, terminalOverrides),
    };
    status.refresh();

    await expect(waiting).resolves.toMatchObject({
      presentation: { themeMode: "light", effectiveTheme: { background: "#f0f0f0" } },
    });
  });

  it("waits for monotonic input admission and PTY write sequence publication", async () => {
    const root = document.createElement("div");
    let presentation = {
      ...closedTerminalPresentation("surface", theme),
      acceptedInputSequence: 2,
      ptyWriteSequence: 1,
    };
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "native-surface", publish: vi.fn(), presentation: () => presentation,
    });
    status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    let settled = false;
    const waiting = waitForTerminalConditions({
      status, phase: "live", timeoutMs: 1000, waitForText: vi.fn(),
      presentation: {
        acceptedInputSequenceGreaterThan: 1,
        ptyWriteSequenceGreaterThan: 1,
      },
    }).then((answer) => { settled = true; return answer; });

    await Promise.resolve();
    expect(settled).toBe(false);
    presentation = { ...presentation, ptyWriteSequence: 2 };
    status.refresh();

    await expect(waiting).resolves.toMatchObject({
      presentation: { acceptedInputSequence: 2, ptyWriteSequence: 2 },
    });
  });

  it("waits for history and viewport state only at a status publication edge", async () => {
    const root = document.createElement("div");
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: vi.fn(),
      presentation: () => closedTerminalPresentation("frame", theme),
    });
    status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
    let viewport: { historySize: number; offset: number; followMode: "follow" | "pinned" } = {
      historySize: 0, offset: 0, followMode: "follow",
    };
    let settled = false;
    const waiting = waitForTerminalConditions({
      status, phase: "live", timeoutMs: 1000, waitForText: vi.fn(),
      viewport: { historySize: 120, minHistorySize: 100, offset: 120, followMode: "pinned" },
      readViewport: () => viewport,
    }).then((answer) => { settled = true; return answer; });

    await Promise.resolve();
    expect(settled).toBe(false);
    viewport = { historySize: 120, offset: 120, followMode: "pinned" };
    await Promise.resolve();
    expect(settled).toBe(false);
    status.refresh();

    await expect(waiting).resolves.toMatchObject({
      historySize: 120, offset: 120, followMode: "pinned",
    });
  });
});
