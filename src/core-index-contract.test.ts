// The names this kit calls are the ones the contract declares.
//
// Measured 2026-09-04: this kit called `session_attach` with `viewId` while the command it could run
// was `session.attach` with `view`. Either mismatch alone left the core's index empty, and neither
// raised: the runner answers `{ok:false}`, so a name nothing serves reads as a success to a caller
// that only catches. The contract names them once and each side grades itself against that file;
// this repository does not read the core's source.
import { SESSION_COMMANDS, sessionCommand } from "@soksak/soksak-contract-control";
import { describe, expect, it, vi } from "vitest";

import { coreIndex } from "./core-index";
import type { ProviderTerminalPluginHost } from "./provider-terminal-plugin";

const sent = () => {
  const calls: Array<{ command: string; params: Record<string, unknown> }> = [];
  const execute = vi.fn(async (command: string, params: Record<string, unknown>) => {
    calls.push({ command, params });
    return { ok: true };
  });
  const host = { commands: { execute } } as unknown as ProviderTerminalPluginHost;
  return { host, calls };
};

describe("the commands this kit calls", () => {
  it("spells the attach the contract declares, with its exact parameters", () => {
    const { host, calls } = sent();
    coreIndex(host, "an-owner").attach(7, "v1");
    const declared = sessionCommand("session.attach");
    expect(declared).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(declared!.command);
    expect(Object.keys(calls[0].params).sort()).toEqual([...declared!.params].sort());
  });

  it("spells the detach the contract declares, with its exact parameters", () => {
    const { host, calls } = sent();
    coreIndex(host, "an-owner").detach(7);
    const declared = sessionCommand("session.detach");
    expect(declared).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(declared!.command);
    expect(Object.keys(calls[0].params).sort()).toEqual([...declared!.params].sort());
  });

  it("calls no session command the contract does not declare", () => {
    const { host, calls } = sent();
    const index = coreIndex(host, "an-owner");
    index.attach(7, "v1");
    index.detach(7);
    for (const call of calls) {
      if (!call.command.startsWith("session.")) continue;
      expect(SESSION_COMMANDS.map((one) => one.command)).toContain(call.command);
    }
  });
});
