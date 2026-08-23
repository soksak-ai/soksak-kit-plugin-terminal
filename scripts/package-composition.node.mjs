import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");

test("the installed contract, kit, and plugin entry bundle as one graph", async () => {
  const result = await build({
    stdin: {
      contents: 'import { activateProviderTerminalPlugin } from "./dist/index.js"; export { activateProviderTerminalPlugin };',
      resolveDir: root,
      sourcefile: "composition-entry.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const output = result.outputFiles[0]?.text ?? "";
  assert.match(output, /terminal-root/);
  assert.match(output, /recovery-status/);
  const binding = readFileSync(join(root, "src/terminal-session-binding.ts"), "utf8");
  assert.doesNotMatch(binding, /providerSidecar|providerRequest/);
});
