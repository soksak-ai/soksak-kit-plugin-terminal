import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

test("repository owns public metadata", () => {
  assert.equal(existsSync(join(root, "README.md")), true);
  assert.equal(existsSync(join(root, "README.ko.md")), true);
  assert.equal(existsSync(join(root, "LICENSE")), true);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.repository.url,
    "git+https://github.com/soksak-ai/soksak-kit-plugin-terminal.git",
  );
  const kit = JSON.parse(readFileSync(join(root, "kit.json"), "utf8"));
  assert.deepEqual(kit, { id: "soksak-kit-plugin-terminal", version: "0.0.6" });
  assert.equal(pkg.version, kit.version);
  const releaseFiles = JSON.parse(readFileSync(join(root, "release-files.json"), "utf8"));
  assert.ok(releaseFiles.includes("kit.json"));
  assert.ok(releaseFiles.includes("src/index.ts"));
  assert.ok(releaseFiles.includes("src/terminal-size-wait.ts"));
  assert.ok(releaseFiles.includes("src/terminal-resize-worker.ts"));
  assert.ok(releaseFiles.includes("src/terminal-resize-status.ts"));
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /soksak-spec\n\s+ref: 418d6064fcdc5885be1ff73fd898fd7a0f778a0f/);
  assert.match(workflow, /owner-enforced immutable releases must be enabled/);
});
