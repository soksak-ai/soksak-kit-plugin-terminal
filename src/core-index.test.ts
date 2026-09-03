// The core's index is written by the one place that knows both halves.
import { describe, expect, it, vi } from "vitest";

import { coreIndex } from "./core-index";
import type { ProviderTerminalPluginHost } from "./provider-terminal-plugin";

const host = (execute?: unknown) =>
  ({ commands: execute ? { execute } : undefined }) as unknown as ProviderTerminalPluginHost;

describe("writing the index", () => {
  it("records the session and the view it is shown on", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").attach(7, "v1");
    expect(execute).toHaveBeenCalledWith("session_attach", {
      session: "7",
      owner: "an-owner",
      viewId: "v1",
    });
  });

  it("sends the id as text", () => {
    // A session id is the owner's to shape. As a number it goes through a JSON parser that is exact
    // only to 2^53, and an id above that comes back as a different session.
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").attach(3606797633324619, "v1");
    expect(execute).toHaveBeenCalledWith("session_attach", {
      session: "3606797633324619",
      owner: "an-owner",
      viewId: "v1",
    });
  });

  it("takes the coordinate off a session that is still running", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").detach(7);
    expect(execute).toHaveBeenCalledWith("session_detach", { session: "7" });
  });

  it("does nothing when the host serves no index", () => {
    expect(() => coreIndex(host(undefined), "an-owner").attach(7, "v1")).not.toThrow();
  });

  it("does nothing when the manifest names no owner", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "").attach(7, "v1");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a refusal and leaves the session running", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => {
      throw new Error("the index refused");
    });
    expect(() => coreIndex(host(execute), "an-owner").attach(7, "v1")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
  });
});
