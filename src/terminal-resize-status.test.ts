import { describe, expect, it } from "vitest";
import { terminalResizeStatus } from "./terminal-resize-status";

describe("terminal resize status", () => {
  it("selects one pane across PTY, recovery, and rendered boundaries", () => {
    expect(terminalResizeStatus({
      pane: "pane-a", session: 7, hostPixels: { width: 432, height: 384 },
      requested: { cols: 54, rows: 24 }, rendered: { cols: 54, rows: 24 }, operation: "ready",
      diagnostics: {
        pty: { sessions: [
          { session: 8, paneId: "pane-b", cols: 90, rows: 24, eventSequence: 2 },
          { session: 7, paneId: "pane-a", cols: 54, rows: 24, eventSequence: 3 },
        ] },
        recovery: { sessions: [
          { pane: "pane-b", cols: 90, rows: 24, eventSequence: 2 },
          { pane: "pane-a", cols: 54, rows: 24, eventSequence: 3 },
        ] },
      },
    })).toEqual({
      hostPixels: { width: 432, height: 384 }, requested: { cols: 54, rows: 24 },
      pty: { cols: 54, rows: 24, eventSequence: 3 },
      recovery: { cols: 54, rows: 24, eventSequence: 3 },
      rendered: { cols: 54, rows: 24 }, operation: "ready",
    });
  });

  it("reports unavailable boundaries as null", () => {
    expect(terminalResizeStatus({
      pane: "pane", session: 0, hostPixels: { width: 0, height: 0 }, requested: null,
      rendered: null, operation: "closed", diagnostics: { pty: {}, recovery: {} },
    })).toEqual({
      hostPixels: { width: 0, height: 0 }, requested: null, pty: null, recovery: null,
      rendered: null, operation: "closed",
    });
  });
});
