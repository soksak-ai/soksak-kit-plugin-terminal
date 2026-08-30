# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.21.

The kit owns view registration, PTY and recovery lifecycle, resizing, public status, and every
command required by the terminal plugin contract. A plugin may supply a renderer adapter for engine
specific presentation, input, IME, focus, and snapshots; the adapter cannot replace lifecycle or
standard commands. Optional plugin commands are registered as explicit extensions.
Status reports host pixels, requested size, PTY observation, recovery observation and rendered size.
Layout updates consume both `ResizeObserver` and the host's post-commit `layout.reflow` event. Both
signals enter the same serial resize worker; no interval or retry path exists.
The standard `wait` command listens to that same status publication. In addition to lifecycle,
text, size, focus and cursor predicates, it can require the presented `themeMode` and
`effectiveBackground`, plus exact/minimum history size, exact viewport offset and `follow|pinned`
mode. Strict `acceptedInputSequenceGreaterThan` and `ptyWriteSequenceGreaterThan` thresholds expose
input admission and its later PTY write as separate publication edges. A frame commits history and
viewport state before publishing its render event, so an output marker cannot release a state wait
early. No wait path samples a presenter on an interval.
Presenter text reads may be synchronous or asynchronous. The standard `read` command awaits the
result and publishes only `{text:string}`; an IPC Promise never leaks into command status.
Selection reads follow the same boundary: `selection` and `copy` await a native presenter and
publish or copy only the resolved string. A rejected engine selection is not replaced with a stale
or empty success.

The kit is the browser-side owner of terminal theme publication. It reads the explicit host
`light|dark` mode and contract tokens, validates presenter state, and publishes `themeMode`,
`baseTheme`, `terminalOverrides` and `effectiveTheme` through status, DOM data and
`soksak:terminal-colors`. `terminal-screen` receives the effective semantic colors and all 256
indexed colors as CSS properties. A plugin does not keep a private theme map or infer override
presence by comparing effective colors.

A native surface presenter publishes engine-driven presentation changes through
`TerminalPresenter.onPresentationChanged` and exposes the same state through `themeStatus`. The
host's one `data-theme-epoch` mutation calls `setTheme`; the applied state then reaches status and
DOM at the presentation edge. No presenter polling or terminal-output parsing is used.

## Clipboard and file drops

Selection, copy, paste and drop are common Kit behavior. Copy and implicit paste use only the host
clipboard capability. Paste wraps text with bracketed-paste markers only when the active presenter
reports that engine mode. A file drop accepts opaque host grants. The host redeems a grant to its
raw authorized path, and this Kit quotes it for the login shell read from `app.environment`; Core
owns no shell syntax and a command cannot inject a raw path as a grant. Inline mode runs only through a presenter
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
Visibility has two named owners. The Workbench owns `intrinsicVisible` for its own split/maximize
layout; Core owns `hostVisible` and `dim` for workspace, tab, overlay, and focus presentation.
`effectiveVisible` is their conjunction and alone controls render work. A native presenter writes
only `intrinsicVisible` to `data-native-visible`; Core publishes host presentation through the
view-slot ancestor, so a pre-DOM compositor stage is never vetoed by a duplicate stale host value.
The four facts are exposed as `data-terminal-intrinsic-visible`, `data-terminal-host-visible`,
`data-terminal-effective-visible`, and `data-terminal-dim`. DOM position and
`IntersectionObserver` are not visibility signals. When effectively visible again, a frame
renderer requests the latest frame and a byte renderer redraws its retained buffer once.

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

`OUT` and `COMMIT` are accepted from the make command line only; a value from the environment is
refused. `OUT` must be an absolute directory and `COMMIT` the exact lowercase Git SHA. This kit is a
publishable portable component: its release is built by the canonical SDK/spec builder and published
as an immutable GitHub release asset. Its exact package bytes are also published to the declared
package registry so terminal plugins can resolve the kit by version.

```sh
make release COMMIT=<exact-git-sha> OUT=/absolute/dir REGISTRY=http://host:port/
make publish OUT=/absolute/dir REGISTRY=http://host:port/
```

`release` runs `verify` and delegates to the exact SDK:

```sh
soksak-sdk package --root <absolute-kit-root> --spec-root <absolute-spec-package> \\
  --commit <exact-git-sha> --out <absolute-release-directory>
```

`prepare` installs the consumed `@soksak` scope from `REGISTRY` with the release-age delay disabled,
so a version published to it moments ago resolves. A failed install exits with the
pnpm status. After a successful install `pnpm-workspace.yaml` must be unchanged; a change exits 65:

```sh
pnpm install --frozen-lockfile --@soksak:registry=$(REGISTRY) --config.minimum-release-age=0
```
