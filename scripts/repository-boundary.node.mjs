import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertPortableDependencyArchive,
  assertPortableDependencyMetadata,
} from "./portable-dependency-metadata.mjs";

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
  assert.deepEqual(kit, { id: "soksak-kit-plugin-terminal", version: "0.0.18" });
  assert.equal(pkg.version, kit.version);
  assert.match(pkg.engines.node, /^\d+\.\d+\.\d+$/);
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal("pnpm" in pkg, false);
  assert.equal(pkg.peerDependencies["@soksak/soksak-contract-plugin-terminal"], "0.0.6");
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
  assert.match(workflow, /node-version-file: component\/package\.json/);
  assert.match(workflow, /package_json_file: component\/package\.json/);
  assert.match(workflow, /releases\/download\/v0\.0\.29\/soksak-ai-plugin-spec-0\.0\.29[.]tgz/);
  assert.match(workflow, /f3311f6e20069667486e753e8669e7f7787f197f47e4a94e14207a066c2db32c/);
  assert.doesNotMatch(workflow, /repository: soksak-ai\/soksak-spec/);
  assert.match(workflow, /owner-enforced immutable releases must be enabled/);
  assert.match(
    workflow,
    /portable-dependency-metadata[.]mjs[^\n]*artifacts/,
    "release workflow does not reject local dependency metadata inside its archives",
  );
});

test("portable release includes the presentation status owner", () => {
  const releaseFiles = JSON.parse(readFileSync(join(root, "release-files.json"), "utf8"));
  assert.ok(releaseFiles.includes("src/terminal-presentation-status.ts"));
});

test("source metadata refuses external local dependency topology", () => {
  assert.doesNotThrow(() => assertPortableDependencyMetadata(root));
  assert.throws(
    () => assertPortableDependencyMetadata(root, {
      packageText: JSON.stringify({ dependencies: { contract: "file:/tmp/contract.tgz" } }),
      lockText: "lockfileVersion: '9.0'\n",
    }),
    /external local dependency/,
  );
  assert.throws(
    () => assertPortableDependencyMetadata(root, {
      packageText: JSON.stringify({ devDependencies: { contract: "file:../../../../../contract.tgz" } }),
      lockText: "lockfileVersion: '9.0'\n",
    }),
    /external local dependency/,
  );
});

test("portable archive refuses embedded local dependency topology", () => {
  const archive = process.env.SOKSAK_TEST_PORTABLE_ARCHIVE;
  if (archive) assert.doesNotThrow(() => assertPortableDependencyArchive(archive));
});
