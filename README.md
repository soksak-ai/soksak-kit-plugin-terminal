# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.12.

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

## Clipboard and file drops

Selection, copy, paste and drop are common Kit behavior. Copy and implicit paste use only the host
clipboard capability. Paste wraps text with bracketed-paste markers only when the active presenter
reports that engine mode. A file drop accepts opaque host grants; redemption supplies shell-quoted
text, so a command cannot inject a raw path as a grant. Inline mode runs only through a presenter
capability and never falls back to path input. The pane exposes `terminal-drop-target`, clipboard
permission, selection, bracketed-paste mode and the last accepted/refused drop in status, DOM data
and events.

## What a pane does when it loses its terminal

A pane is where a shell runs, and it keeps that true on its own.

- Closing a pane ends its session; unmounting one keeps the session so a remount reattaches to it.
- A write that fails, and a frame the engine has no mirror for, are a session that went away: the
  pane starts one again. The first try is immediate and every try after it waits, up to half a
  minute, so a pane waiting for something outside itself does not cost the whole application.
- A pane whose session ended shows what was archived and then starts a shell, rather than standing
  as a picture of one that ended. An engine that missed part of the output cannot rebuild the screen
  that was lost, so the pane attaches to the shell instead of failing on the gap.
- A pane is live when it has a session. Reporting live without one hands every later keystroke to a
  number nothing serves.
- A pane that came back clears the failure it recovered from. One it did not recover from — a
  rejected checkpoint — stays.
- A pane that is not live states the phase inside itself: a blank screen alone is a pane the reader
  cannot tell apart from an idle shell.

## What is not painted

A pane the layout hides, and every pane of a view the host is not showing, asks for no frames. The
sessions and their output are kept, and a frame is asked for again when the pane is shown. Measured
2026-08-26: a hidden pane went from 195 frames in 4 seconds to none, and the window's rendering
process from 92.7% to 32.3% of a core.
Host presentation is the only visibility authority; DOM position and `IntersectionObserver` are
not visibility signals. When shown again, a frame renderer requests the latest frame and a byte
renderer redraws its retained buffer once.

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
A frame presenter requests a viewport through `TerminalPresenterOptions.requestViewport`; the pane
session clamps it and asks the engine for that offset. Renderer-private DOM events never own or
silently absorb terminal history movement.

## Verification

`.node-version` owns the Node version. `package.json#engines.node` and
`package.json#devEngines.runtime` are aligned projections for package consumers and direct pnpm
entrypoints. A local environment and GitHub Actions select that version before calling the same
Make targets. A mismatched direct pnpm command fails before dependency resolution. pnpm also
refuses to repair an out-of-date dependency tree before a script; `make prepare` is the only
dependency-materialization entrypoint.
When an owned dependency declaration changes, `make lock` is the only lockfile-regeneration
entrypoint. It updates the lock without materializing packages; `make prepare` then installs that
exact frozen state.

The package depends on `@soksak/soksak-contract-plugin-terminal`, so every `make` invocation that
installs requires `REGISTRY` on the command line, `https://registry.npmjs.org` included once the
packages are published there. The Makefile reads the requirement from `package.json` and refuses
`REGISTRY required: this package depends on @soksak/...` when it is absent.

```sh
make lock REGISTRY=http://host:port/
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
pnpm publish "<tarball>" --registry "$(REGISTRY)" --@soksak:registry="$(REGISTRY)" --no-git-checks
```

`prepare` installs the consumed `@soksak` scope from `REGISTRY` with the release-age delay disabled,
so a version published to it moments ago resolves. A failed install exits with the
pnpm status. After a successful install `pnpm-workspace.yaml` must be unchanged; a change exits 65:

```sh
pnpm install --frozen-lockfile --@soksak:registry=$(REGISTRY) --config.minimum-release-age=0
```
