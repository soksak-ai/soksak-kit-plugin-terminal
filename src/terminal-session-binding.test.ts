import { describe, expect, it, vi } from "vitest";
import { createTerminalSessionBinding, type TerminalSidecarChannel } from "./terminal-session-binding";

describe("shared terminal session binding", () => {
  it("identifies a sidecar when a response has no error detail", async () => {
    const channel: TerminalSidecarChannel = {
      send: vi.fn(async () => ({ ok: false })),
      stream: vi.fn(),
    };
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async () => channel },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    await expect(binding.write(9, "x")).rejects.toThrow("sidecar refused request");
  });

  it("opens atomically, ACKs absolute coordinates, buffers first bytes, and injects only a key name", async () => {
    const sent: Record<string, unknown>[] = [];
    let onBytes: ((bytes: Uint8Array) => void) | undefined;
    const pty: TerminalSidecarChannel = {
      send: vi.fn(async (request) => {
        sent.push(request);
        const command = request.command;
        const data = command === "pty.open" ? { session: 9 } : command === "pty.pane" ? { held: true } : {};
        return { ok: true, result: { data } };
      }),
      stream: vi.fn(async (_request, handlers) => {
        onBytes = handlers.onBytes;
        return { answer: { ok: true, result: { data: { startSeq: 41 } } }, close: { dispose() {} } };
      }),
    };
    const provider: TerminalSidecarChannel = {
      send: vi.fn(async () => ({ ok: true, result: { data: {} } })),
      stream: vi.fn(),
    };
    const opens: unknown[] = [];
    const binding = createTerminalSessionBinding({
      windowLabel: () => "window-a",
      commands: { execute: async () => ({ data: { loginShell: "/bin/zsh" } }) },
      sidecar: { open: async (name, opts) => { opens.push([name, opts]); return name === "soksak-sidecar-pty" ? pty : provider; } },
    }, { ptySidecarId: "soksak-sidecar-pty", terminalSidecarId: "soksak-sidecar-terminal-vt100" });

    const session = await binding.open("pane-a", 80, 24, "none", "observer-a");
    onBytes!(new Uint8Array([65, 66, 67]));
    const received: number[] = [];
    binding.onData(session, (bytes) => received.push(...bytes));
    await binding.recoveryRequest({ op: "status" });
    await binding.diagnostics();
    await Promise.resolve();

    expect(received).toEqual([65, 66, 67]);
    expect(sent.find((value) => value.command === "pty.open"))
      .toMatchObject({ args: { request: { observerToken: "observer-a", shell: "/bin/zsh" } } });
    expect(sent.find((value) => value.command === "pty.ack"))
      .toMatchObject({ args: { request: { session: 9, throughSeq: 44 } } });
    expect(opens).toContainEqual(["soksak-sidecar-terminal-vt100", {
      generatedSecretEnv: {
        SOKSAK_TERMINAL_CHECKPOINT_KEY: { key: "terminal-checkpoint-key-v1", bytes: 32 },
      },
    }]);
  });
});
