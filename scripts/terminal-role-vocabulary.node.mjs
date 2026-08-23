import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("terminal sidecar API names the recovery responsibility", () => {
  const binding = readFileSync(new URL("../src/terminal-session-binding.ts", import.meta.url), "utf8");
  const plugin = readFileSync(new URL("../src/provider-terminal-plugin.ts", import.meta.url), "utf8");
  const source = binding + plugin;

  assert.match(source, /terminalSidecarId/);
  assert.match(source, /recoveryRequest/);
  assert.doesNotMatch(source, /providerSidecar/);
  assert.doesNotMatch(source, /providerRequest/);
});
