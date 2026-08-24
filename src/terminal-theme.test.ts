// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { observeTerminalTheme, readTerminalTheme } from "./terminal-theme";

function host(tokens: Record<string, string>): HTMLElement {
  const root = document.documentElement;
  for (const [slot, value] of Object.entries(tokens)) root.style.setProperty(`--${slot}`, value);
  return root;
}

describe("terminal theme", () => {
  it("resolves every semantic role from its contract-owned host token", () => {
    const root = host({ card: "#0b0d10", fg: "#d7e0ea", acc: "#ff9f6e", fg3: "#7d8795" });
    expect(readTerminalTheme(root)).toEqual({
      background: "#0b0d10", foreground: "#d7e0ea", cursor: "#ff9f6e",
      cursorAccent: "#0b0d10", selectionBackground: "#7d8795",
    });
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
