// The core's index is written by the one place that knows both halves.
import { describe, expect, it, vi } from "vitest";

import { coreIndex } from "./core-index";
import type { ProviderTerminalPluginHost } from "./provider-terminal-plugin";

const host = (execute?: unknown) =>
  ({ commands: execute ? { execute } : undefined }) as unknown as ProviderTerminalPluginHost;

describe("writing the index", () => {
  it("calls execute on the commands surface, not through a reference taken out of it", async () => {
    // Measured in a running application: every object call in this kit reached the core and the one
    // destructured call reached nothing — no entry, no refusal, no rejection. A surface whose
    // execute reads its own object is enough to tell the two apart.
    const sent: unknown[] = [];
    const commands = {
      name: "the surface",
      async execute(this: { name?: string }, command: string, params: unknown) {
        if (this?.name !== "the surface") throw new Error("execute lost its surface");
        sent.push([command, params]);
        return { ok: true };
      },
    };
    const host = { commands } as unknown as ProviderTerminalPluginHost;
    coreIndex(host, "an-owner").attach(7, "v1");
    await Promise.resolve();
    expect(sent).toEqual([["session.attach", { session: "7", owner: "an-owner", view: "v1" }]]);
  });

  it("reads the host at each call, so a surface that arrives after the writer is built is used", async () => {
    // The writer is built when a view mounts and used when a session opens. Reading the host once at
    // construction makes every later attach report an absent surface for the life of the pane.
    const host = {} as { commands?: unknown } as ProviderTerminalPluginHost;
    const index = coreIndex(host, "an-owner");
    const execute = vi.fn(async () => ({ ok: true }));
    (host as { commands?: unknown }).commands = { execute };
    index.attach(7, "v1");
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith("session.attach", {
      session: "7", owner: "an-owner", view: "v1",
    });
  });

  it("records the session and the view it is shown on", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").attach(7, "v1");
    expect(execute).toHaveBeenCalledWith("session.attach", {
      session: "7",
      owner: "an-owner",
      view: "v1",
    });
  });

  it("sends the id as text", () => {
    // A session id is the owner's to shape. As a number it goes through a JSON parser that is exact
    // only to 2^53, and an id above that comes back as a different session.
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").attach(3606797633324619, "v1");
    expect(execute).toHaveBeenCalledWith("session.attach", {
      session: "3606797633324619",
      owner: "an-owner",
      view: "v1",
    });
  });

  it("takes the coordinate off a session that is still running", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "an-owner").detach(7);
    expect(execute).toHaveBeenCalledWith("session.detach", { session: "7" });
  });

  it("does nothing when the host serves no index", () => {
    expect(() => coreIndex(host(undefined), "an-owner").attach(7, "v1")).not.toThrow();
  });

  it("does nothing when the manifest names no owner", () => {
    const execute = vi.fn(async () => ({ ok: true }));
    coreIndex(host(execute), "").attach(7, "v1");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a command the core will not serve", async () => {
    // The runner answers rather than rejecting — every call resolves to {ok:true} or {ok:false} —
    // so a name it does not serve looks exactly like a success to a caller that only catches.
    // Measured: an attach under the wrong name produced no log and no entry, and this file was
    // green over it because it asserted the payload rather than the answer.
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const execute = vi.fn(async () => ({ ok: false, code: "UNKNOWN_COMMAND", message: "no such" }));
    coreIndex(host(execute), "an-owner").attach(7, "v1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toHaveBeenCalled();
    reported.mockRestore();
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
