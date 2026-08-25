# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.7.

The kit owns view registration, PTY and recovery lifecycle, resizing, public status, and every
command required by the terminal plugin contract. A plugin may supply a renderer adapter for engine
specific presentation, input, IME, focus, and snapshots; the adapter cannot replace lifecycle or
standard commands. Optional plugin commands are registered as explicit extensions.
Status reports host pixels, requested size, PTY observation, recovery observation and rendered size.
Layout updates consume both `ResizeObserver` and the host's post-commit `layout.reflow` event. Both
signals enter the same serial resize worker; no interval or retry path exists.

The kit is also the only browser-side owner of terminal theme resolution. It maps the contract's
five semantic roles from the host's public tokens, applies them to `terminal-screen`, publishes the
resolved values through `presentation.theme`, and exposes cursor, cursor-accent, and selection as
the contract-declared CSS properties. Frame renderers and byte-renderer adapters consume this same
implementation; a plugin must not keep a private terminal theme map.
The public screen also carries all 256 contract palette entries as indexed CSS custom properties,
allowing installed-product parity checks to read computed style without treating screenshots as an
automated oracle.

## Stream sequence rule

PTY output is ordered by one absolute source sequence. A stream attachment establishes its
`startSeq` before any delivered byte may advance or acknowledge that sequence. Bytes received by
the transport before the attachment answer are retained, then delivered once in arrival order from
that exact `startSeq`. Sequence rollback, relative acknowledgements, retries, and provider-specific
stream paths are forbidden.
Public status carries the same absolute output coordinate across PTY production, recovery mirror
application, and completed renderer application. A byte renderer completes output only after its
parser callback; a frame renderer uses the sequence returned atomically with the frame.
One pane owns one renderer generation. Unmount closes the exact byte stream, awaits the Core close
receipt, explicitly detaches that PTY generation, and only then lets a replacement mount start. A
stale async mount cannot open or attach after it was stopped.

## Verification

The package depends on `@soksak/soksak-contract-plugin-terminal`, so every `make` invocation that
installs requires `REGISTRY` on the command line, `https://registry.npmjs.org` included once the
packages are published there. The Makefile reads the requirement from `package.json` and refuses
`REGISTRY required: this package depends on @soksak/...` when it is absent.

```sh
make verify REGISTRY=http://host:port/
```

## Release

`OUT` and `REGISTRY` are accepted from the make command line only; a value from the environment is
refused. `OUT` must be an absolute directory and `REGISTRY` an absolute `http://` or `https://` URL.
OUT and REGISTRY are accepted from the make command line only; a value from the environment is refused
by name. GNU make's own environment channels (`MAKEFLAGS`, `GNUMAKEFLAGS`, `MAKEFILES`, `-e`) are
outside the Makefile's control and are not refused; setting them is a deliberate act of the caller.

```sh
make release OUT=/absolute/dir REGISTRY=http://host:port/
make publish OUT=/absolute/dir REGISTRY=http://host:port/
```

`release` runs `verify`, packs, and prints two digests:

```sh
pnpm pack --pack-destination "$(OUT)"
shasum -a 256 "<tarball>"
gunzip -c "<tarball>" | shasum -a 256
```

gzip bytes differ between zlib builds, so reproducibility of a tarball is judged on the digest of
the decompressed tar stream. The tarball digest identifies the exact file uploaded. The tarball
bytes in the registry are the release identity for consumers.

`publish` runs `release`, then uploads that exact tarball:

```sh
pnpm publish "<tarball>" --registry "$(REGISTRY)" --@soksak:registry="$(REGISTRY)" --@soksak-ai:registry="$(REGISTRY)" --no-git-checks
```

`prepare` installs both `@soksak` and `@soksak-ai` scopes from `REGISTRY` with the release-age
delay disabled, so a version published to it moments ago resolves. A failed install exits with the
pnpm status. After a successful install `pnpm-workspace.yaml` must be unchanged; a change exits 65:

```sh
pnpm install --frozen-lockfile --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
```
