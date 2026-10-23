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
2. During implementation, run checks appropriate to the change. Before handing off or pushing a verified development build, run `npm run verify:dev`: syntax, desktop SDK, complete Node regression with zero skips, six browser journeys, connection/office UI regression, rolling development build, packaged MCP/startup checks and artifact hashes. The same command runs in Windows CI on development-branch pushes and PRs. Do not substitute a build or test count for this gate. A missing browser, skipped test, incomplete journey or failed step must fail verification.
3. Use isolated test data and fixture provider configuration. Do not refresh personal account credentials, invoke real models, or operate personal client windows as part of routine tests.
4. Check `git diff --check` and inspect the staged files. Commit a coherent, verified change; push the tested development branch when authorized. Never force-push or merge the main branch implicitly.
5. Report what was actually checked. Registration, process discovery, room membership, and historical success do not prove a current external client can reply.

The six required journeys are listed in `scripts/core-flows.cjs` and exercised by `scripts/validate-core-flows.cjs`: first connection; existing member in a new room; task progress and correlated reply; disconnect/restart recovery; leave/delete isolation; night and narrow-window use. Use visible controls and production HTTP/MCP paths. Fixture setup may establish preconditions, but must not directly set the success state being tested. Keep the lockfile-pinned Playwright browser; no personal browser/channel or agent-runtime fallback. Inspect screenshots when changing layout. Keep failures and their logs under ignored `output/`; fix the behavior or a demonstrably outdated fixture, never weaken acceptance merely to pass.

## Compatibility and scope

- Preserve `AgentRoom.exe`, `agentroom_*`, `integrations/agentroom`, and the `.agentroom` runtime path where required for existing MCP and CLI compatibility. Renaming the checkout is not a reason to rewrite these contracts.
- Reuse valid member identities, credentials, and native session bindings; do not require new MCP configuration for a room change or normal software update.
- This is an unreleased local development project. Test data can be discarded; do not add user account infrastructure, production data migration, or retention systems without a concrete requirement. This does not authorize deleting personal files or existing runtime configuration.
- Keep credentials out of output. Use synthetic identifiers and tokens in regression tests.
- Ask for current computer availability before operating client windows, as required by the user's computer-use preference. Normal source and isolated command-line checks need no GUI.

## Connection UI rules

Member connection status reaches people through one projection, `src/member-connection.cjs`. Keep it that way.

- Five user states only: `not_connected`, `waiting`, `connected`, `auto`, `attention`. Internal onboarding stages are diagnostics; never branch UI copy on them directly. A new backend stage must map to one of the five (the exhaustive test in `tests/member-connection.test.cjs` reads stage literals from source and fails otherwise).
- One card shape everywhere (chat card, onboarding list, member dialog): one status line, one primary action, at most one secondary action, and a folded 详情 for errors and manual setup. Every non-final state has a primary action; a dead end is a bug.
- Desktop clients connect over MCP by default (copy config, then send one sentence). The debug-port route is only the optional automatic-wake add-on for connected Doubao/Qwen members and always asks before restarting a client.
- Copy rules (enforced by `tests/web-connection-assist.test.cjs` and `tests/member-connection.test.cjs`): no reassurance boilerplate (保留/沿用/没有自动重试/未宣称/不会生成), no internal terms (原生会话/本人对话/握手/兼容 MCP/群桥接) in headlines, buttons or connection-flow messages, and any button named in copy must be a label the panel actually shows.
- Connect-request cards are posted as Agent Office under the person's own message; the addressed agent only acknowledges them in one sentence.
- Prefer removing a branch over adding another explanation. A change that adds user-facing text should say what the person can do next, not what the system did not do.
