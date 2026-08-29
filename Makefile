SHELL := /bin/sh
.PHONY: preflight guard lock prepare build verify require-out release publish
registry_flags = --@soksak:registry=$(REGISTRY) --config.minimum-release-age=0
# OUT and REGISTRY are accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.
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
require-out: guard
	@test "$(origin OUT)" = "command line" || { echo 'OUT must be given on the make command line: make release OUT=/absolute/dir' >&2; exit 64; }
# Portable releases are owned by the exact SDK/spec builder. The package is also published to the
# declared registry so consumers resolve its name and version through their lockfile.
release: require-out verify
	@test "$(origin COMMIT)" = "command line" || { echo 'COMMIT must be given on the make command line' >&2; exit 64; }
	@node -e 'if (!/^[a-f0-9]{40}$$/.test(process.argv[1])) process.exit(64)' "$(COMMIT)"
	@tool="$$(command -v soksak-sdk)"; tooling_root="$$(cd "$$(dirname "$$tool")/.." && pwd -P)"; \
		soksak-sdk package --root "$(CURDIR)" --spec-root "$$tooling_root/.dependencies/soksak-spec" --commit "$(COMMIT)" --out "$(OUT)"

publish: guard release
	@archive="$$(find "$(OUT)" -maxdepth 1 -type f -name '*.tgz' -print -quit)"; test -n "$$archive" || { echo 'release produced no package archive' >&2; exit 65; }; \
		CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm publish "$$archive" --registry "$(REGISTRY)" --@soksak:registry "$(REGISTRY)" --no-git-checks
