#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$#" -eq 0 ] || { echo 'BUILD_DECLARATION_INVALID: usage: check-build-environment.sh' >&2; exit 78; }
node_expected=$(awk 'NF { value=$0; count++ } END { if (count == 1) print value; else exit 1 }' "$root/.node-version" 2>/dev/null || true)
node_declared=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.engines?.node??"")' "$root/package.json" 2>/dev/null || true)
package_manager=$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.packageManager??"")' "$root/package.json" 2>/dev/null || true)
case "$package_manager" in pnpm@*) pnpm_expected=${package_manager#pnpm@} ;; *) pnpm_expected= ;; esac
[ -n "$node_expected" ] && [ "$node_expected" = "$node_declared" ] && [ -n "$pnpm_expected" ] || { echo 'BUILD_DECLARATION_INVALID: Node and pnpm owners are not exact and aligned' >&2; exit 78; }
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin; arch=arm64 ;;
  Darwin-x86_64) if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then platform=darwin; arch=arm64; else platform=darwin; arch=x64; fi ;;
  Linux-aarch64|Linux-arm64) platform=linux; arch=arm64 ;;
  Linux-x86_64) platform=linux; arch=x64 ;;
  MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) platform=win32; arch=x64 ;;
  *) echo 'TOOLCHAIN_MISMATCH: unsupported host' >&2; exit 78 ;;
esac
node_actual=$(node --version 2>/dev/null || true); node_platform=$(node -p process.platform 2>/dev/null || true); node_arch=$(node -p process.arch 2>/dev/null || true)
pnpm_actual=$(cd "$root" && pnpm --version 2>/dev/null || true); pnpm_command=$(command -v pnpm 2>/dev/null || true)
pnpm_executable=$(node -e 'const f=require("fs"),p=require("path");let d;try{d=p.dirname(f.realpathSync(process.argv[1]))}catch{process.exit(2)}for(;;){const m=p.join(d,"package.json");if(f.existsSync(m)){try{const v=JSON.parse(f.readFileSync(m,"utf8"));if(v.name==="pnpm"){process.stdout.write(v.version);break}}catch{}}const q=p.dirname(d);if(q===d)process.exit(2);d=q}' "$pnpm_command" 2>/dev/null || true)
if [ "$node_actual" != "v$node_expected" ] || [ "$node_platform" != "$platform" ] || [ "$node_arch" != "$arch" ] || [ "$pnpm_actual" != "$pnpm_expected" ] || [ "$pnpm_executable" != "$pnpm_expected" ]; then
  printf 'TOOLCHAIN_MISMATCH: expected node=v%s pnpm=%s runtime=%s/%s; actual node=%s pnpm=%s pnpmExecutable=%s runtime=%s/%s\n' "$node_expected" "$pnpm_expected" "$platform" "$arch" "${node_actual:-missing}" "${pnpm_actual:-missing}" "${pnpm_executable:-unknown}" "${node_platform:-unknown}" "${node_arch:-unknown}" >&2; exit 78
fi
lock=$(shasum -a 256 "$root/pnpm-lock.yaml" | awk '{print $1}')
printf 'BUILD_ENVIRONMENT_READY node=%s pnpm=%s runtime=%s/%s lockSHA256=%s\n' "$node_actual" "$pnpm_actual" "$node_platform" "$node_arch" "$lock"
