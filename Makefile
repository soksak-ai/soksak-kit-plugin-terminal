SHELL := /bin/sh
.PHONY: preflight guard prepare build verify require-out require-registry release publish
# pnpm pack names the tarball <name without @, / as ->-<version>.tgz.
tarball = $(OUT)/$(shell node -p 'const p=require("$(CURDIR)/package.json");p.name.replace("@","").replace("/","-")+"-"+p.version+".tgz"')
registry_flags = --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
publish_flags = --registry "$(REGISTRY)" --@soksak:registry="$(REGISTRY)" --@soksak-ai:registry="$(REGISTRY)" --no-git-checks
# OUT and REGISTRY are accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.
preflight:
	@scripts/check-build-environment.sh
# A package that depends on @soksak/* or @soksak-ai/* requires REGISTRY for every install, the public registry included.
guard:
	@case "$(origin OUT)" in undefined|"command line") ;; *) echo 'OUT from the $(origin OUT) is refused: make release OUT=/absolute/dir' >&2; exit 64 ;; esac
	@case "$(origin OUT):$(OUT)" in undefined:|"command line:/"*) ;; *) echo 'OUT must be an absolute directory: make release OUT=/absolute/dir' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY)" in undefined|"command line") ;; *) echo 'REGISTRY from the $(origin REGISTRY) is refused: make publish OUT=/absolute/dir REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY):$(REGISTRY)" in undefined:|"command line:http://"*|"command line:https://"*) ;; *) echo 'REGISTRY must be an absolute URL: make publish OUT=/absolute/dir REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@dependency=$$(node -p 'const p=require("$(CURDIR)/package.json");Object.keys({...p.dependencies,...p.devDependencies,...p.peerDependencies}).find((name)=>/^@soksak(-ai)?\//.test(name))??""') || exit $$?; test -z "$$dependency" || test "$(origin REGISTRY)" = "command line" || { echo "REGISTRY required: this package depends on $$dependency: make verify REGISTRY=http://host:port/" >&2; exit 64; }
# A failed install exits with the pnpm status; the pnpm-workspace.yaml digest is compared only after a successful install.
prepare: guard preflight
	@before=$$(shasum -a 256 pnpm-workspace.yaml); CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags)) || exit $$?; test "$$before" = "$$(shasum -a 256 pnpm-workspace.yaml)" || { echo 'pnpm install rewrote pnpm-workspace.yaml' >&2; exit 65; }
build: prepare
	@pnpm build
verify: prepare
	@pnpm test
	@pnpm typecheck
require-out: guard
	@test "$(origin OUT)" = "command line" || { echo 'OUT must be given on the make command line: make release OUT=/absolute/dir' >&2; exit 64; }
require-registry: guard
	@test "$(origin REGISTRY)" = "command line" || { echo 'REGISTRY must be given on the make command line: make publish OUT=/absolute/dir REGISTRY=http://host:port/' >&2; exit 64; }
# gzip bytes vary between zlib builds; the tar-stream digest is the reproducibility reference.
release: require-out verify
	@mkdir -p "$(OUT)"
	@pnpm pack --pack-destination "$(OUT)"
	@shasum -a 256 "$(tarball)" | tee "$(tarball).sha256"
	@gunzip -c "$(tarball)" | shasum -a 256 | sed 's|-$$|$(tarball).tar|' | tee "$(tarball).tar.sha256"
publish: require-registry release
	@pnpm publish "$(tarball)" $(publish_flags)
