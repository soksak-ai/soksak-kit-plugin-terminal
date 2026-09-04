SHELL := /bin/sh
.PHONY: version preflight guard lock prepare build verify require-tooling require-out require-registry release attest publish
SDK_VERSION := 0.0.20
registry_flags = --@soksak:registry=$(REGISTRY) --config.minimum-release-age=0
publish_flags = --registry "$(REGISTRY)" --@soksak:registry="$(REGISTRY)" --no-git-checks
# OUT and REGISTRY are accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.
# The version is one value in two files: kit.json is the component manifest and package.json is what
# npm packs. A verify gate refuses a disagreement, so both are written by one command rather than by
# hand twice. VERSION is a command-line input.
version:
	@case "$(origin VERSION)" in "command line") ;; *) echo 'VERSION must be an exact command-line input: make version VERSION=0.0.116' >&2; exit 64 ;; esac
	@node -e 'const {writeFileSync,readFileSync}=require("fs"); const v=process.argv[1]; if(!/^\d+\.\d+\.\d+$$/.test(v)) {console.error("VERSION must be major.minor.patch"); process.exit(64);} for (const f of ["kit.json","package.json"]) { const d=JSON.parse(readFileSync(f,"utf8")); d.version=v; writeFileSync(f, JSON.stringify(d,null,2)+"\n"); } console.log("VERSION_WRITTEN "+v);' "$(VERSION)"

preflight:
	@scripts/check-build-environment.sh
# A package that depends on @soksak/* requires REGISTRY for every install, the public registry included.
guard:
	@case "$(origin OUT)" in undefined|"command line") ;; *) echo 'OUT from the $(origin OUT) is refused: make release OUT=/absolute/dir' >&2; exit 64 ;; esac
	@case "$(origin OUT):$(OUT)" in undefined:|"command line:/"*) ;; *) echo 'OUT must be an absolute directory: make release OUT=/absolute/dir' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY)" in undefined|"command line") ;; *) echo 'REGISTRY from the $(origin REGISTRY) is refused: make publish OUT=/absolute/dir REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY):$(REGISTRY)" in undefined:|"command line:http://"*|"command line:https://"*) ;; *) echo 'REGISTRY must be an absolute URL: make publish OUT=/absolute/dir REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@dependency=$$(node -p 'const p=require("$(CURDIR)/package.json");Object.keys({...p.dependencies,...p.devDependencies,...p.peerDependencies}).find((name)=>name.startsWith("@soksak/"))??""') || exit $$?; test -z "$$dependency" || test "$(origin REGISTRY)" = "command line" || { echo "REGISTRY required: this package depends on $$dependency: make verify REGISTRY=http://host:port/" >&2; exit 64; }
# Lock regeneration is an explicit owner operation. Normal preparation never rewrites dependency intent.
lock: guard preflight
	@before=$$(shasum -a 256 pnpm-workspace.yaml); CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --lockfile-only $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) || exit $$?; test "$$before" = "$$(shasum -a 256 pnpm-workspace.yaml)" || { echo 'pnpm install rewrote pnpm-workspace.yaml' >&2; exit 65; }
# A failed install exits with the pnpm status; the pnpm-workspace.yaml digest is compared only after a successful install.
prepare: guard preflight
	@before=$$(shasum -a 256 pnpm-workspace.yaml); CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) || exit $$?; test "$$before" = "$$(shasum -a 256 pnpm-workspace.yaml)" || { echo 'pnpm install rewrote pnpm-workspace.yaml' >&2; exit 65; }
build: prepare
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) build
verify: prepare
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) test
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) typecheck
require-tooling:
	@tool="$$(command -v soksak-sdk)" || { echo 'soksak-sdk is not selected by PATH' >&2; exit 78; }; \
		case "$$tool" in /*) ;; *) echo 'soksak-sdk PATH entry must be absolute' >&2; exit 78 ;; esac; \
		root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		test -f "$$tool" && test ! -L "$$tool" && test -f "$$root/release.json" && test ! -L "$$root/release.json" && test -d "$$root/.dependencies/soksak-spec" || { echo 'soksak-sdk PATH entry is not a prepared release' >&2; exit 78; }; \
		package_version="$$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$$root/package.json")"; \
		release_version="$$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$$root/release.json")"; \
		test "$$package_version" = "$(SDK_VERSION)" && test "$$release_version" = "$(SDK_VERSION)" || { echo "TOOLCHAIN_MISMATCH soksak-sdk required=$(SDK_VERSION) package=$$package_version release=$$release_version" >&2; exit 78; }
require-out: guard
	@test "$(origin OUT)" = "command line" || { echo 'OUT must be given on the make command line: make release OUT=/absolute/dir' >&2; exit 64; }
# Registry is a transport argument, never an ambient setting.
require-registry: guard
	@test "$(origin REGISTRY)" = "command line" || { echo 'REGISTRY must be given on the make command line: make publish REGISTRY=http://host:port/' >&2; exit 64; }
# Portable releases are owned by the exact SDK/spec builder. This kit is publishable; the builder
# emits release.json and the immutable release asset used by the local release store.
release: require-tooling require-out verify
	@test "$(origin COMMIT)" = "command line" || { echo 'COMMIT must be given on the make command line' >&2; exit 64; }
	@node -e 'if (!/^[a-f0-9]{40}$$/.test(process.argv[1])) process.exit(64)' "$(COMMIT)"
	@tool="$$(command -v soksak-sdk)"; tooling_root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		soksak-sdk package --root "$(CURDIR)" --spec-root "$$tooling_root/.dependencies/soksak-spec" --commit "$(COMMIT)" --out "$(OUT)"

attest: require-tooling require-out release
	@tool="$$(command -v soksak-sdk)"; tooling_root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		platform="$$(node -p 'process.platform')"; architecture="$$(node -p 'process.arch')"; \
		soksak-sdk attest --release-dir "$(OUT)" \
		--spec-root "$$tooling_root/.dependencies/soksak-spec" --tooling-release "$$tooling_root/release.json" \
		--mode native --platform "$$platform" --architecture "$$architecture" \
		--tool "node=$$(node -p 'process.versions.node')" --tool "pnpm=$$(pnpm --version)"

publish: require-registry require-out attest
	@archive="$$(find "$(OUT)" -maxdepth 1 -type f -name '*.tgz' -print -quit)"; test -n "$$archive" || { echo 'release produced no package archive' >&2; exit 65; }; \
		CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm publish "$$archive" $(publish_flags)
