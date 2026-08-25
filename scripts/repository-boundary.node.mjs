import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");

test("repository owns public metadata", () => {
  assert.equal(existsSync(join(root, "README.md")), true);
  assert.equal(existsSync(join(root, "README.ko.md")), true);
  assert.equal(existsSync(join(root, "LICENSE")), true);
  assert.equal(existsSync(join(root, "Makefile")), true);
  const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    pkg.repository.url,
    "git+https://github.com/soksak-ai/soksak-kit-plugin-terminal.git",
  );
  const kit = JSON.parse(readFileSync(join(root, "kit.json"), "utf8"));
  assert.deepEqual(kit, { id: "soksak-kit-plugin-terminal", version: "0.0.21" });
  assert.equal(pkg.version, kit.version);
  assert.match(pkg.engines.node, /^\d+\.\d+\.\d+$/);
  assert.equal(nodeVersion, pkg.engines.node);
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal("pnpm" in pkg, false);
  assert.equal(pkg.peerDependencies["@soksak/soksak-contract-plugin-terminal"], "0.0.7");
  assert.equal(
    pkg.devDependencies["@soksak/soksak-contract-plugin-terminal"],
    "https://github.com/soksak-ai/soksak-contract-plugin-terminal/releases/download/v0.0.6/soksak-contract-plugin-terminal-0.0.6-any.tgz",
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
  assert.match(workflow, /node-version-file: component\/[.]node-version/);
  assert.match(workflow, /package_json_file: component\/package\.json/);
  assert.match(workflow, /inputs\.spec_url|inputs\.spec_sha256/);
  assert.match(workflow, /make verify/);
  assert.doesNotMatch(workflow, /soksak-ai-plugin-spec-\d+[.]\d+[.]\d+[.]tgz/);
  assert.doesNotMatch(workflow, /repository: soksak-ai\/soksak-spec/);
  assert.match(workflow, /immutable-releases.*enforced_by_owner/);
});

test("portable release includes the presentation status owner", () => {
  const releaseFiles = JSON.parse(readFileSync(join(root, "release-files.json"), "utf8"));
  assert.ok(releaseFiles.includes("src/terminal-presentation-status.ts"));
});

test("portable release includes every public source module", () => {
  const releaseFiles = new Set(JSON.parse(readFileSync(join(root, "release-files.json"), "utf8")));
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const modules = [...index.matchAll(/export \* from "[.]\/(.+)";/g)].map((match) => `src/${match[1]}.ts`);
  assert.deepEqual(modules.filter((module) => !releaseFiles.has(module)), []);
});

test("preflight judges the effective repository-selected pnpm", () => {
  const source = readFileSync(join(root, "scripts/check-build-environment.sh"), "utf8");
  assert.match(source, /pnpm_actual=.*pnpm --version/);
  assert.doesNotMatch(source, /pnpm_executable|pnpmExecutable/);
});
