import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  assert.deepEqual(kit, { id: "soksak-kit-plugin-terminal", version: "0.0.87" });
  assert.equal(pkg.version, kit.version);
  assert.equal(pkg.private, true);
  assert.match(pkg.engines.node, /^\d+\.\d+\.\d+$/);
  assert.equal(nodeVersion, pkg.engines.node);
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal("pnpm" in pkg, false);
  assert.equal(pkg.peerDependencies["@soksak/soksak-contract-plugin-terminal"], "0.0.17");
  assert.equal(pkg.devDependencies["@soksak/soksak-contract-plugin-terminal"], "0.0.17");
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
  assert.ok(releaseFiles.includes("src/bounded-output-tail.ts"));
  const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /node-version-file: component\/[.]node-version/);
  assert.match(workflow, /package_json_file: component\/package\.json/);
  assert.match(workflow, /inputs\.spec_url|inputs\.spec_sha256/);
  assert.match(workflow, /make verify/);
  assert.doesNotMatch(workflow, /soksak-ai-plugin-spec-\d+[.]\d+[.]\d+[.]tgz/);
  assert.doesNotMatch(workflow, /repository: soksak-ai\/soksak-spec/);
  assert.match(workflow, /immutable-releases.*enforced_by_owner/);
});

test("package is a private portable component", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal("publishConfig" in pkg, false);
  assert.deepEqual(pkg.files, ["dist", "kit.json", "src", "!src/**/*.test.ts", "LICENSE", "README*"]);
  assert.deepEqual(pkg.exports, { ".": { types: "./src/index.ts", default: "./dist/index.js" } });
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith("@soksak/")) assert.match(spec, /^\d+\.\d+\.\d+$/, `${section}.${name}`);
    }
  }
});

const makefile = readFileSync(join(root, "Makefile"), "utf8");
const makeVariable = (name) => {
  const match = makefile.match(new RegExp(`^${name} = (.+)$`, "m"));
  assert.ok(match, name);
  return match[1];
};
// A parent make exports OUT, REGISTRY, and MAKEFLAGS to recipe processes; a bare PATH keeps them out.
const run = (args, env = {}, cwd = root) =>
  spawnSync("make", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const refused = (result, message) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /BUILD_ENVIRONMENT_READY/);
};
// A package.json ahead of pnpm-lock.yaml fails `pnpm install --frozen-lockfile` before any registry request.
const copyWithOutdatedLockfile = () => {
  const copy = mkdtempSync(join(tmpdir(), "soksak-kit-plugin-terminal-"));
  mkdirSync(join(copy, "scripts"));
  for (const name of ["Makefile", ".node-version", "pnpm-lock.yaml", "pnpm-workspace.yaml", "scripts/check-build-environment.sh"]) {
    copyFileSync(join(root, name), join(copy, name));
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  pkg.devDependencies["left-pad"] = "1.3.0";
  writeFileSync(join(copy, "package.json"), JSON.stringify(pkg));
  return copy;
};

test("Makefile delegates release to the canonical SDK", () => {
  assert.doesNotMatch(makefile, /\bnpm (pack|publish)\b/);
  assert.doesNotMatch(makefile, /PUBLISH_FLAGS/);
  assert.equal(
    makeVariable("registry_flags"),
    "--@soksak:registry=$(REGISTRY) --config.minimum-release-age=0",
  );
  assert.match(makefile, /^prepare: guard preflight$/m);
  assert.match(makefile, /pnpm install --frozen-lockfile \$\(if \$\(findstring command line,\$\(origin REGISTRY\)\),\$\(registry_flags\)\)/);
  assert.match(makefile, /shasum -a 256 pnpm-workspace\.yaml/);
  // pnpm 11 re-runs a bare install before `pnpm <script>` when the workspace state disagrees with the
  // current settings; every script invocation repeats the install environment and registry flags.
  for (const script of ["build", "test", "typecheck"]) {
    assert.match(makefile, new RegExp(`^\t@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm \\$\\(if \\$\\(findstring command line,\\$\\(origin REGISTRY\\)\\),\\$\\(registry_flags\\)\\) ${script}$`, "m"), script);
  }
  assert.doesNotMatch(makefile, /^\t@pnpm (build|test|typecheck)$/m);
  assert.match(makefile, /^release: require-out verify$/m);
  assert.match(makefile, /soksak-sdk package --root/);
  refused(run(["release", "REGISTRY=http://127.0.0.1:4873"]), /OUT/);
  refused(run(["release", "OUT=out"]), /OUT/);
  refused(run(["release", "OUT="]), /OUT/);
  refused(run(["release"], { OUT: "/nonexistent/out" }), /OUT.*environment/);
  refused(run(["prepare"], { REGISTRY: "http://127.0.0.1:4873" }), /REGISTRY.*environment/);
  refused(run(["verify"], { OUT: "/nonexistent/out" }), /OUT.*environment/);
});

test("Makefile owns deterministic lockfile regeneration", () => {
  assert.match(makefile, /^lock: guard preflight$/m);
  assert.match(makefile, /pnpm install --lockfile-only \$\(if \$\(findstring command line,\$\(origin REGISTRY\)\),\$\(registry_flags\)\)/);
  for (const name of ["README.md", "README.ko.md"]) {
    assert.match(readFileSync(join(root, name), "utf8"), /^make lock REGISTRY=http:\/\/host:port\/$/m, name);
  }
  refused(run(["lock"]), /REGISTRY required/);
  refused(run(["lock"], { REGISTRY: "http://127.0.0.1:4873" }), /REGISTRY.*environment/);
});

test("the package configures only the npm scope it consumes", () => {
  for (const name of ["Makefile", "README.md", "README.ko.md", "package.json", "pnpm-lock.yaml"]) {
    assert.doesNotMatch(readFileSync(join(root, name), "utf8"), /@soksak-ai/);
  }
});

test("Makefile requires REGISTRY on the command line because the package depends on @soksak", () => {
  const dependency = /REGISTRY required: this package depends on @soksak\/soksak-contract-plugin-terminal/;
  refused(run(["prepare"]), dependency);
  refused(run(["build"]), dependency);
  refused(run(["verify"]), dependency);
  refused(run(["release", "OUT=/nonexistent/out"]), dependency);
  assert.match(makefile, /node -p '[^']*dependencies[^']*devDependencies[^']*peerDependencies/);
});

test("prepare exits with the pnpm install status and no workspace message when the install fails", () => {
  const copy = copyWithOutdatedLockfile();
  try {
    const result = run(["prepare", "REGISTRY=http://127.0.0.1:9"], {}, copy);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /BUILD_ENVIRONMENT_READY/);
    assert.match(result.stdout + result.stderr, /ERR_PNPM_OUTDATED_LOCKFILE/);
    assert.match(result.stderr, /^make: \*\*\* \[prepare\] Error 1$/m);
    assert.doesNotMatch(result.stderr, /Error 65/);
    assert.doesNotMatch(result.stdout + result.stderr, /rewrote pnpm-workspace\.yaml/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  assert.doesNotMatch(makefile, /pnpm install[^\n]* && /);
});

test("README documents the Makefile release commands verbatim", () => {
  const install = `pnpm install --frozen-lockfile ${makeVariable("registry_flags")}`;
  for (const name of ["README.md","README.ko.md"]) {
    const readme = readFileSync(join(root, name), "utf8");
    assert.ok(readme.includes("make verify REGISTRY=http://host:port/"), name);
    assert.ok(readme.includes("make release COMMIT=<exact-git-sha> OUT=/absolute/dir REGISTRY=http://host:port/"), name);
    assert.ok(readme.includes(install), name);
    assert.ok(readme.includes("soksak-sdk package --root"), name);
    assert.doesNotMatch(readme, /^make (prepare|build|verify|release)\b(?!.*(?:REGISTRY=|COMMIT=))/m, name);
  }
});

test("README states the local and Actions toolchain boundary", () => {
  const english = readFileSync(join(root, "README.md"), "utf8");
  const korean = readFileSync(join(root, "README.ko.md"), "utf8");
  for (const text of [english, korean]) {
    assert.match(text, /[.]node-version/);
    assert.match(text, /devEngines[.]runtime/);
    assert.match(text, /GitHub Actions/);
    assert.match(text, /make prepare/);
    assert.match(text, /direct pnpm/);
  }
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

test("direct pnpm entrypoints fail closed before dependency mutation", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const nodeVersion = readFileSync(join(root, ".node-version"), "utf8").trim();
  assert.deepEqual(pkg.devEngines, {
    runtime: { name: "node", version: nodeVersion, onFail: "error" },
  });
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  for (const rule of ["engineStrict: true", "pmOnFail: error", "verifyDepsBeforeRun: error"]) {
    assert.match(workspace, new RegExp(`^${rule}$`, "m"));
  }

  const fixture = mkdtempSync(join(tmpdir(), "soksak-kit-toolchain-policy-"));
  try {
    writeFileSync(join(fixture, "package.json"), JSON.stringify({
      name: "soksak-toolchain-policy-fixture", version: "0.0.0",
      packageManager: pkg.packageManager,
      devEngines: { runtime: { name: "node", version: "0.0.1", onFail: "error" } },
    }));
    writeFileSync(join(fixture, "pnpm-workspace.yaml"), workspace);
    const result = spawnSync("pnpm", ["install"], {
      cwd: fixture, encoding: "utf8",
      env: { PATH: process.env.PATH, CI: "1", PNPM_DISABLE_SELF_UPDATE_CHECK: "1" },
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /This project requires Node[.]js 0[.]0[.]1[.] Your current Node[.]js is v\d+[.]\d+[.]\d+/);
    assert.doesNotMatch(output, /Progress:|Packages:/);
    assert.equal(existsSync(join(fixture, "node_modules")), false);
    assert.equal(existsSync(join(fixture, "pnpm-lock.yaml")), false);

    writeFileSync(join(fixture, "package.json"), JSON.stringify({
      name: "soksak-dependency-policy-fixture", version: "0.0.0",
      packageManager: pkg.packageManager,
      devEngines: { runtime: { name: "node", version: process.versions.node, onFail: "error" } },
      scripts: { probe: "node --version" }, dependencies: { "left-pad": "1.3.0" },
    }));
    const stale = spawnSync("pnpm", ["run", "probe"], {
      cwd: fixture, encoding: "utf8",
      env: { PATH: process.env.PATH, CI: "1", PNPM_DISABLE_SELF_UPDATE_CHECK: "1" },
    });
    assert.notEqual(stale.status, 0);
    assert.match(stale.stdout + stale.stderr, /VERIFY_DEPS_BEFORE_RUN|Run "pnpm install"/);
    assert.equal(existsSync(join(fixture, "node_modules")), false);
    assert.equal(existsSync(join(fixture, "pnpm-lock.yaml")), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
