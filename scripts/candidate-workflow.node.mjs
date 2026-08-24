import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("kit owner composes and seals exact spec and contract candidate inputs", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/candidate.yml"), "utf8");
  for (const required of [
    "workflow_call:", "source_ref:",
    "spec_artifact_name:", "spec_artifact_digest:", "spec_candidate_manifest_sha256:", "spec_source_commit:",
    "contract_artifact_name:", "contract_artifact_digest:", "contract_candidate_manifest_sha256:", "contract_source_commit:",
    "github.workflow_ref", "git -C source rev-parse HEAD",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    "verify-candidate-artifact.mjs", "write-candidate-input-receipt.mjs",
    "stage-node-candidate.mjs", "build-node-candidate.mjs",
    "--kind portable", "--generated dist",
    "seal-candidate-artifact.mjs", "make verify",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "if-no-files-found: error",
  ]) assert.match(workflow, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const forbidden of [
    "repository: soksak-ai/soksak-kit-plugin-terminal",
    "repository: soksak-ai/soksak-contract-plugin-terminal",
    "repository: soksak-ai/soksak-spec",
    "contents: write", "create-github-app-token", "publish-canonical-release", "gh release", "gh api",
  ]) assert.doesNotMatch(workflow, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("preflight judges the effective repository-selected pnpm", () => {
  const source = fs.readFileSync(path.join(root, "scripts/check-build-environment.sh"), "utf8");
  assert.match(source, /pnpm_actual=.*pnpm --version/);
  assert.doesNotMatch(source, /pnpm_executable|pnpmExecutable/);
});
