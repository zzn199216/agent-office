# Prompt for Codex: release automation (English)

Implementation note (2026-10-15): this plan has been implemented with explicit user authorization. Read docs/RELEASE.md and docs/HANDOFF.md for the current commands and verification. Do not recreate the pipeline. Missing-thread requests now receive an explicit rejection; the other product and identity decisions remain unchanged.

Work in the repository root. Read docs/RELEASE_AUTOMATION_PLAN.md first for the background (Chinese). Do the steps one at a time. After each step: run the full test suite and `node scripts/check.cjs`, commit only when everything passes, and do not push. Do not touch the user's data directory (~/.agentroom), older release directories, real model calls, or personal client configurations. Do not deploy or restart anything that is not part of this task.

## Step 1: scripts/release.cjs

Create a non-interactive release pipeline: check -> full tests -> scripts/build.cjs -> scripts/validate-packaged-mcp.cjs -> scripts/package-smoke.cjs -> verify artifacts. Stop at the first failure with a non-zero exit code. Flags: --skip-tests, --skip-build (validation only), --json (write output/release-<version>.json with per-step status, duration, log path, git HEAD, whether the tree is clean, and artifact sha256 and sizes). On a platform other than win32 x64, print a clear message and exit; do not attempt cross-building. No prompts, no `pause`. The repository lives on a slow network drive, so avoid recursive scans of node_modules or release, and keep temporary data on the local temp directory.
Acceptance: unit tests for argument parsing and result aggregation without really building; a deliberate failing step yields the right exit code and JSON; one real run on the Windows host produces a complete JSON.

## Step 2: scripts/release-runner.cjs

A headless trigger so a remote session can request a release by writing files into the shared project folder. Requests: output/release-requests/<id>.json containing only id, created, steps (an allowlisted enum) and expected_version. Never accept commands or paths. Status: output/release-status/<id>.json with queued/running/ok/failed/rejected, log path and result path. Single-flight execution, a 20 minute timeout, ignore requests older than 10 minutes, reject when expected_version differs from package.json. Provide user-level (no administrator) install and uninstall scripts for a scheduled task, and document how to verify and disable it.
Acceptance: tests with a fake executor for queueing, the single-flight lock, timeout and rejection; document a manual check on the host.

## Step 3 (optional): built-in CLI self-check

Add `agentoffice selftest --json` (exercise approvals, permission reviews, secretary assignment and room deletion with fake clients in a temporary directory and print structured results) and a read-only `agentoffice approvals --json` listing pending approvals and review records. Do not duplicate the existing front-end vm fixture tests.

## Do not change without asking the user

1. approvalsReviewer: 'auto_review' semantics for writable projects.
2. workspaceOwner legacy_home strictness.
3. The extra refresh triggered while the secretary is not ready.
4. Codex approval handling when threadId is missing: propose logging or an explicit rejection response, and wait for confirmation.

At the end of each step, update docs/HANDOFF.md with what changed, what was verified, and what was not verified.
