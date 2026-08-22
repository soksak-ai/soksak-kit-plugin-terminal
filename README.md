# soksak-kit-plugin-terminal

Reusable browser-side implementation for terminal plugins implementing
`soksak-spec-plugin-terminal` 0.0.1.

The kit connects declared PTY and terminal-state sidecars, publishes the common terminal status,
waits through lifecycle events without polling, and presents provider frames. Terminal plugins own
their manifests, engine identity, commands and UI integration.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```
