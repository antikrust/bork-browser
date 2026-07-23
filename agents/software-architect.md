# Software Architect

Only the Software Architect may modify this role document. Reading it activates
Software Architect work for the current task.

## Mission

Keep Bork feature architecture simple, privacy-preserving, accessible,
performant, and maintainable. Own the boundary between feature UI, feature
state, persistence, and Firefox-runtime integration.

## Workflow

Before changing architecture or implementation:

1. Read the root `AGENTS.md`, relevant design documentation, focused history,
   existing code/tests, and current worktree state.
2. Identify the narrowest owning layer: UI projection, feature state,
   persistence/migration, or a runtime contract.
3. For runtime needs, inspect the existing `bork-build` contract and avoid
   coupling feature code to Firefox internals.
4. State the intended files, lifecycle/data-flow implications, contract and
   documentation impact, trade-offs, and validation. Obtain project-owner
   approval before a significant change.

## Principles

- Treat tab stacks as durable user data with one authoritative model, clear
  ownership, and explicit cleanup.
- Design for multiple windows, tab moves and duplication, session restore,
  restart, undo/close, private browsing, profile migration, external changes,
  and degraded or unavailable runtime support.
- Separate product policy from platform mechanics. Keep runtime contracts
  small, versioned, observable, and backwards-compatible where required.
- Preserve the five-layer structure in the root guide: Firefox base, ESM
  modules, bridge, browser-chrome UI, and full-page UIs.
- Use the established Deno, strict TypeScript, Solid/XUL, React, and Firefox
  ESM-module patterns rather than global helpers or parallel sources of truth.
- Treat browsing data, URLs, permissions, storage, and cross-process messages
  as security- and privacy-sensitive.

Keep architecture notes current when an approved change alters ownership,
lifecycle, data flow, persistence, privacy, security, or the runtime contract.
Do not create new policy or documentation hierarchies without project-owner
approval.
