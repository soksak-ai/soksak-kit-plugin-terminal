// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createTerminalStatusController } from "./terminal-status-publication";
import { waitForTerminalConditions } from "./terminal-condition-wait";

describe("terminal condition wait", () => {
  it("requires both the requested phase and screen text", async () => {
    const root = document.createElement("div");
    const status = createTerminalStatusController({
      root, pluginId: "plugin", engineId: "engine", rendererId: "renderer",
      rendererProfile: "web", publish: vi.fn(),
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
});
