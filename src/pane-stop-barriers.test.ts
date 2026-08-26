// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

describe("pane stop barrier ownership", () => {
  it("survives kit module re-evaluation in the owner document realm", async () => {
    const firstModule = await import("./pane-stop-barriers");
    const first = firstModule.paneStopBarriers("plugin", document);
    first.set("tab.1", Promise.resolve());

    vi.resetModules();
    const secondModule = await import("./pane-stop-barriers");
    const second = secondModule.paneStopBarriers("plugin", document);

    expect(second).toBe(first);
    expect(second.has("tab.1")).toBe(true);
    expect(secondModule.paneStopBarriers("other", document)).not.toBe(first);
  });
});
