# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.3.

The kit connects declared PTY and terminal-state sidecars, publishes the common terminal status,
waits through lifecycle events without polling, and presents provider frames. Terminal plugins own
their manifests, engine identity, commands and UI integration.
Status reports host pixels, requested size, PTY observation, recovery observation and rendered size.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```
