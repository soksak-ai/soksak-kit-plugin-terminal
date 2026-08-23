# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.3.

The kit owns view registration, PTY and recovery lifecycle, resizing, public status, and every
command required by the terminal plugin contract. A plugin may supply a renderer adapter for engine
specific presentation, input, IME, focus, and snapshots; the adapter cannot replace lifecycle or
standard commands. Optional plugin commands are registered as explicit extensions.
Status reports host pixels, requested size, PTY observation, recovery observation and rendered size.
Layout updates consume both `ResizeObserver` and the host's post-commit `layout.reflow` event. Both
signals enter the same serial resize worker; no interval or retry path exists.

## Stream sequence rule

PTY output is ordered by one absolute source sequence. A stream attachment establishes its
`startSeq` before any delivered byte may advance or acknowledge that sequence. Bytes received by
the transport before the attachment answer are retained, then delivered once in arrival order from
that exact `startSeq`. Sequence rollback, relative acknowledgements, retries, and provider-specific
stream paths are forbidden.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```
