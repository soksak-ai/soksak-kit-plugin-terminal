// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  emptyTerminalThemeOverrides,
  resolveTerminalTheme,
  TERMINAL_ANSI_PALETTE,
  TERMINAL_THEME_EVENT,
} from "@soksak/soksak-contract-plugin-terminal";

import {
  observeTerminalTheme,
  publishTerminalThemeStatus,
  readTerminalTheme,
  readTerminalThemeStatus,
} from "./terminal-theme";

function host(tokens: Record<string, string>): HTMLElement {
  const root = document.documentElement;
  for (const [slot, value] of Object.entries(tokens)) root.style.setProperty(`--${slot}`, value);
  return root;
}

describe("terminal theme", () => {
  it("resolves every semantic role from its contract-owned host token", () => {
    const root = host({ card: "#0b0d10", fg: "#d7e0ea", acc: "#ff9f6e", fg3: "#7d8795" });
    expect(readTerminalTheme(root)).toMatchObject({
      background: "#0b0d10", foreground: "#d7e0ea", cursor: "#ff9f6e",
      cursorAccent: "#0b0d10", selectionBackground: "#7d8795",
    });
    expect(readTerminalTheme(root).ansi).toEqual(TERMINAL_ANSI_PALETTE);
  });

  it("reads the explicit host mode and publishes all four theme axes", () => {
    const root = host({ card: "#0b0d10", fg: "#d7e0ea", acc: "#ff9f6e", fg3: "#7d8795" });
    root.dataset.themeMode = "dark";
    expect(readTerminalThemeStatus(root)).toMatchObject({
      themeMode: "dark",
      baseTheme: { background: "#0b0d10", foreground: "#d7e0ea" },
      terminalOverrides: { foreground: null, background: null, cursor: null },
      effectiveTheme: { background: "#0b0d10", foreground: "#d7e0ea" },
    });
  });

  it("publishes validated theme state to DOM and the contract event", () => {
    const root = document.createElement("div");
    const screen = document.createElement("div");
    const baseTheme = {
      foreground: "#111111", background: "#222222", cursor: "#333333",
      cursorAccent: "#444444", selectionBackground: "#555555",
      ansi: [...TERMINAL_ANSI_PALETTE],
    };
    const terminalOverrides = emptyTerminalThemeOverrides();
    terminalOverrides.foreground = "#abcdef";
    const status = {
      themeMode: "dark" as const,
      baseTheme,
      terminalOverrides,
      effectiveTheme: resolveTerminalTheme(baseTheme, terminalOverrides),
    };
    const events: unknown[] = [];
    root.addEventListener(TERMINAL_THEME_EVENT, (event) => events.push((event as CustomEvent).detail));
    publishTerminalThemeStatus(root, screen, "tab-a.1", status);
    expect(root.dataset.themeMode).toBe("dark");
    expect(JSON.parse(screen.dataset.terminalOverrides ?? "null").foreground).toBe("#abcdef");
    expect(screen.style.color).toBe("rgb(171, 205, 239)");
    expect(events).toEqual([{ ...status, pane: "tab-a.1" }]);
  });

  it("rejects an incomplete host theme instead of inventing a fallback", () => {
    document.documentElement.style.removeProperty("--fg");
    expect(() => readTerminalTheme(document.documentElement)).toThrow("terminal theme token --fg is empty");
  });

  it("reports only the declared theme epoch event", async () => {
    const root = document.documentElement;
    root.dataset.themeEpoch = "1";
    const seen: string[] = [];
    const stop = observeTerminalTheme(root, () => seen.push(root.dataset.themeEpoch ?? ""));
    root.style.setProperty("--app-font-size", "15px");
    await Promise.resolve();
    root.dataset.themeEpoch = "2";
    await Promise.resolve();
    stop();
    expect(seen).toEqual(["2"]);
  });
});
