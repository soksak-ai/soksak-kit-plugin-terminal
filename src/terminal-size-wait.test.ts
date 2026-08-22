// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { waitForTerminalSize } from "./terminal-size-wait";

describe("terminal size wait", () => {
  it("ignores old sizes and resolves on the requested event", async () => {
    const root = document.createElement("div");
    const waiting = waitForTerminalSize(root, { colsLessThan: 90, rows: 24 }, 1000);
    root.dispatchEvent(new CustomEvent("soksak:terminal-size", { detail: { cols: 90, rows: 24 } }));
    root.dispatchEvent(new CustomEvent("soksak:terminal-size", { detail: { cols: 54, rows: 24 } }));
    await expect(waiting).resolves.toEqual({ cols: 54, rows: 24 });
  });
});
