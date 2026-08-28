// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  emptyTerminalThemeOverrides, resolveTerminalTheme, TERMINAL_ANSI_PALETTE, TERMINAL_THEME_EVENT,
} from "@soksak/soksak-contract-plugin-terminal";

import { createTerminalPresentationStatus } from "./terminal-presentation-status";

const baseTheme = {
  foreground: "#eeeeec", background: "#1e1e1e", cursor: "#ffffff",
  cursorAccent: "#1e1e1e", selectionBackground: "#555753", ansi: [...TERMINAL_ANSI_PALETTE],
};
const terminalOverrides = emptyTerminalThemeOverrides();
const theme = {
  themeMode: "dark" as const, baseTheme, terminalOverrides,
  effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
};

describe("terminal presentation status", () => {
  it("publishes the resolved terminal theme through status", () => {
    const root = document.createElement("div");
    const status = createTerminalPresentationStatus(root, "frame", () => theme, () => 100);
    expect(status.current()).toMatchObject(theme);
  });

  it("publishes one DOM event per changed theme state", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.dataset.node = "terminal-screen";
    root.append(screen);
    const events: unknown[] = [];
    root.addEventListener(TERMINAL_THEME_EVENT, (event) => events.push((event as CustomEvent).detail));
    const status = createTerminalPresentationStatus(root, "surface", () => theme, () => 100, null, "tab-a.1");
    status.current();
    status.current();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ pane: "tab-a.1", themeMode: "dark" });
    expect(screen.dataset.effectiveTheme).toBe(JSON.stringify(theme.effectiveTheme));
  });

  it("measures render and accepted-input latency on separate axes", () => {
    let wall = 100;
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.dataset.node = "terminal-screen";
    screen.dataset.cursorVisible = "true";
    screen.dataset.cursorActive = "false";
    screen.dataset.cursorShape = "bar";
    screen.dataset.cursorBlinking = "true";
    screen.dataset.cursorAnimationIntervalMs = "750";
    screen.dataset.cursorAnimationPhase = "off";
    screen.dataset.cursorRow = "2";
    screen.dataset.cursorColumn = "3";
    const input = document.createElement("textarea");
    input.dataset.node = "terminal-input";
    root.append(screen, input);
    const status = createTerminalPresentationStatus(root, "frame", () => theme, () => wall);

    status.markRendered(4);
    status.markRendered(7);
    status.markInputAccepted();
    wall = 112;
    status.markPtyWrite();

    expect(status.current()).toMatchObject({
      renderSequence: 2,
      lastRenderDurationMs: 7,
      maxRenderDurationMs: 7,
      lastInputToPtyWriteMs: 12,
      cursorVisible: true,
      cursorShape: "bar",
      cursorBlinking: true,
      cursorAnimation: { intervalMs: 750, phase: "off" },
      cursorRow: 2,
      cursorColumn: 3,
    });
  });

  it("records the exact focus acquisition edge", () => {
    let wall = 200;
    const root = document.createElement("div");
    const input = document.createElement("textarea");
    input.dataset.node = "terminal-input";
    root.append(input);
    document.body.append(root);
    const status = createTerminalPresentationStatus(root, "frame", () => theme, () => wall) as ReturnType<typeof createTerminalPresentationStatus> & {
      markFocused(focused: boolean): void;
    };

    expect(typeof status.markFocused).toBe("function");
    input.focus();
    wall = 207;
    status.markFocused(true);
    expect(status.current()).toMatchObject({
      focusedInput: true,
      focusSequence: 1,
      lastFocusedAtUnixMs: 207,
    });
  });
  it("reads the suffixed instance nodes of one pane", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.dataset.node = "terminal-screen/2";
    screen.dataset.cursorVisible = "true";
    screen.dataset.cursorRow = "4";
    screen.dataset.cursorColumn = "1";
    const input = document.createElement("textarea");
    input.dataset.node = "terminal-input/2";
    root.append(screen, input);
    document.body.append(root);
    input.focus();
    const status = createTerminalPresentationStatus(root, "frame", () => theme, () => 100, "2");
    expect(status.current()).toMatchObject({ focusedInput: true, cursorVisible: true, cursorRow: 4, cursorColumn: 1 });
    expect(createTerminalPresentationStatus(root, "frame", () => theme, () => 100).current())
      .toMatchObject({ focusedInput: false, cursorVisible: false, cursorRow: null });
  });
});
