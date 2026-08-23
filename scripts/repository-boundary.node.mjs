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
  assert.deepEqual(kit, { id: "soksak-kit-plugin-terminal", version: "0.0.14" });
  assert.equal(pkg.version, kit.version);
  assert.match(pkg.engines.node, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal("pnpm" in pkg, false);
  assert.match(pkg.peerDependencies["@soksak/soksak-contract-plugin-terminal"], /^\d+\.\d+\.\d+$/);
  assert.match(
    pkg.devDependencies["@soksak/soksak-contract-plugin-terminal"],
    new RegExp("^https://codeload[.]github[.]com/soksak-ai/soksak-contract-plugin-terminal/tar[.]gz/refs/tags/v[0-9]+[.][0-9]+[.][0-9]+$"),
  );
  assert.equal(pkg.dependencies, undefined);
  assert.match(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"), /allowBuilds:\n  esbuild: true/);
  const releaseFiles = JSON.parse(readFileSync(join(root, "release-files.json"), "utf8"));
  assert.ok(releaseFiles.includes("kit.json"));
  assert.ok(releaseFiles.includes("src/index.ts"));
  assert.ok(releaseFiles.includes("dist/index.js"));
  assert.ok(releaseFiles.includes("src/terminal-size-wait.ts"));
  assert.ok(releaseFiles.includes("src/terminal-resize-worker.ts"));
  assert.ok(releaseFiles.includes("src/terminal-resize-status.ts"));
  assert.ok(releaseFiles.includes("src/terminal-layout-observer.ts"));
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /node-version-file: component\/package\.json/);
  assert.match(workflow, /package_json_file: component\/package\.json/);
  assert.match(workflow, /v0\.0\.22\/soksak-ai-plugin-spec-0\.0\.22\.tgz/);
  assert.match(workflow, /7142e0c4efe28b5a6335b3e192a2d1db2f04518f3d5cf907af23ab05ea74e638/);
  assert.doesNotMatch(workflow, /repository: soksak-ai\/soksak-spec/);
  assert.match(workflow, /owner-enforced immutable releases must be enabled/);
});
