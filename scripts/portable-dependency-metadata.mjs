import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dependencyFields = new Set([
  "dependencies", "devDependencies", "optionalDependencies",
  "peerDependencies", "overrides", "resolutions",
]);

function scalar(value) {
  const trimmed = value.trim().replace(/,$/, "");
  if ((trimmed.startsWith('\"') && trimmed.endsWith('\"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function localLocator(value) {
  if (typeof value !== "string") return false;
  const locator = scalar(value);
  return /^(?:file:|link:|workspace:)/i.test(locator) ||
    /^(?:\.\.\/|\.\.\\|\/|[A-Za-z]:[\\/])/.test(locator);
}

function packageLocators(document) {
  const found = [];
  const visit = (value, path, dependencyContext) => {
    if (typeof value === "string") {
      if (dependencyContext && localLocator(value)) found.push(path + "=" + value);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      visit(child, path ? path + "." + key : key, dependencyContext || dependencyFields.has(key));
    }
  };
  visit(document, "", false);
  return found;
}

function lockLocators(text) {
  const found = [];
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = source.trim();
    if (line === "" || line.startsWith("#")) continue;
    const pair = line.match(/^(specifier|version|tarball):\s*(.+)$/);
    if (pair && localLocator(pair[2])) found.push("line " + (index + 1) + " " + pair[1] + "=" + scalar(pair[2]));
    const packageKey = line.match(/^(['\"]?)(.+)\1:\s*$/);
    if (packageKey && /@(?:file:|link:|workspace:)/i.test(packageKey[2])) {
      found.push("line " + (index + 1) + " package=" + packageKey[2]);
    }
    const tarball = line.match(/(?:^|[{,]\s*)tarball:\s*([^,}]+)/);
    if (tarball && localLocator(tarball[1])) found.push("line " + (index + 1) + " tarball=" + scalar(tarball[1]));
  }
  return found;
}

function reject(findings, owner) {
  assert.equal(findings.length, 0, owner + " contains external local dependency topology:\n" + findings.join("\n"));
}

export function assertPortableDependencyMetadata(root, overrides = {}) {
  const packageText = overrides.packageText ?? readFileSync(join(root, "package.json"), "utf8");
  const lockText = overrides.lockText ?? readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  let manifest;
  try {
    manifest = JSON.parse(packageText);
  } catch (error) {
    throw new Error("package.json is invalid: " + error.message);
  }
  reject(packageLocators(manifest), "package.json");
  reject(lockLocators(lockText), "pnpm-lock.yaml");
}

function archiveEntries(archive) {
  const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (listed.status !== 0) throw new Error("cannot list " + archive + ": " + listed.stderr.trim());
  return listed.stdout.split(/\r?\n/).filter((entry) => {
    const name = basename(entry);
    return name === "package.json" || name === "pnpm-lock.yaml";
  });
}

function archiveText(archive, entry) {
  const read = spawnSync("tar", ["-xOzf", archive, entry], { encoding: "utf8" });
  if (read.status !== 0) throw new Error("cannot read " + entry + " from " + archive + ": " + read.stderr.trim());
  return read.stdout;
}

export function assertPortableDependencyArchive(archive) {
  const entries = archiveEntries(archive);
  const packages = entries.filter((entry) => basename(entry) === "package.json");
  const locks = entries.filter((entry) => basename(entry) === "pnpm-lock.yaml");
  assert.equal(packages.length, 1, archive + " must contain exactly one package.json");
  assert.equal(locks.length, 1, archive + " must contain exactly one pnpm-lock.yaml");
  assertPortableDependencyMetadata("", {
    packageText: archiveText(archive, packages[0]),
    lockText: archiveText(archive, locks[0]),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const archives = process.argv.slice(2);
  assert.ok(archives.length > 0, "at least one portable archive is required");
  assertPortableDependencyMetadata(join(import.meta.dirname, ".."));
  for (const archive of archives) assertPortableDependencyArchive(archive);
}
