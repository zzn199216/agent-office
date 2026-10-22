# Working on Agent Office

Work from this checkout. Resolve project paths from the repository root; never hardcode a developer's drive, home directory, or former checkout. Do not modify the old AgentRoom checkout as part of normal development here.

## Keep the checkout small

- Track source, tests, runtime assets, build scripts, lockfiles, licenses, and useful current documentation.
- Run `npm ci` to regenerate dependencies. Do not copy caches from another checkout.
- `npm run build` / `npm run build:dev` updates the single ignored `dev/` build. Test by opening `dev/AgentOffice.exe` directly.
- Create versioned archives only for an explicitly requested distribution using `npm run build:release` or the documented release pipeline.
- Keep runtime databases, entry cards, tokens, personal configuration, logs, generated packages, screenshots, and validation evidence out of Git. Never include them in a commit or a public artifact.
- Use Git commits to retain source history; avoid additional historical source copies or package folders.

## Validate and publish coherent changes

1. Inspect the relevant implementation and existing tests before changing behavior.
2. Run `npm run check` and tests appropriate to the change. Before a complete Windows regression run, execute `node scripts/build-desktop.cjs` so desktop tests do not silently skip missing SDK dependencies.
3. Use isolated test data and fixture provider configuration. Do not refresh personal account credentials, invoke real models, or operate personal client windows as part of routine tests.
4. Check `git diff --check` and inspect the staged files. Commit a coherent, verified change; push the tested development branch when authorized. Never force-push or merge the main branch implicitly.
5. Report what was actually checked. Registration, process discovery, room membership, and historical success do not prove a current external client can reply.

## Compatibility and scope

- Preserve `AgentRoom.exe`, `agentroom_*`, `integrations/agentroom`, and the `.agentroom` runtime path where required for existing MCP and CLI compatibility. Renaming the checkout is not a reason to rewrite these contracts.
- Reuse valid member identities, credentials, and native session bindings; do not require new MCP configuration for a room change or normal software update.
- This is an unreleased local development project. Test data can be discarded; do not add user account infrastructure, production data migration, or retention systems without a concrete requirement. This does not authorize deleting personal files or existing runtime configuration.
- Keep credentials out of output. Use synthetic identifiers and tokens in regression tests.
- Ask for current computer availability before operating client windows, as required by the user's computer-use preference. Normal source and isolated command-line checks need no GUI.
