// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createTerminalPresentationStatus } from "./terminal-presentation-status";

const theme = {
  foreground: "#eeeeec", background: "#1e1e1e", cursor: "#ffffff",
  cursorAccent: "#1e1e1e", selectionBackground: "#555753",
};

describe("terminal presentation status", () => {
  it("publishes the resolved terminal theme through status", () => {
    const root = document.createElement("div");
    const status = createTerminalPresentationStatus(root, "frame", () => theme, () => 100);
    expect(status.current().theme).toEqual(theme);
  });

  it("measures render and accepted-input latency on separate axes", () => {
    let wall = 100;
    const root = document.createElement("div");
    const screen = document.createElement("div");
    screen.dataset.node = "terminal-screen";
    screen.dataset.cursorVisible = "true";
    screen.dataset.cursorActive = "false";
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
});
