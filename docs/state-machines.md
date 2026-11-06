# Implicit state-machine audit

Scope: `action.yml`, `scripts/run.mjs`, tests, and repository workflows. Baseline:
`ac84c0b`. The action is a composite wrapper around the pinned nanoodle 0.4.0 CLI;
it has no server, database, deployment service, or durable job queue.

## State inventory

| Machine | States and transitions | Failure/retry contract |
| --- | --- | --- |
| Action setup | Checkout by caller → setup patched Node → invoke worker with explicit input environment | A failed setup prevents execution. No action-level retries. |
| Configuration | Read defaults → require graph/key → validate exact CLI version and bounded positive timeout → parse input/setting lines → prepare output directory | Invalid options fail before spawning npx. Graph and overrides are argv entries, not shell interpolation. |
| Graph reference | File path or share reference → pass unchanged to CLI → CLI loads/decodes graph | The wrapper logs the source category; it does not prefetch or stat share links. Share-link resolution belongs to nanoodle. |
| Child lifecycle | Spawn → running → closed; spawn → error; running → timeout/SIGINT/SIGTERM → termination → forced kill after five seconds if needed | Exactly one spawn attempt. On POSIX, signals target the npx process group, including the CLI. Cancellation cannot become success when a handler exits zero. |
| Result stream | UTF-8 chunks → complete stdout → parse JSON → require an object with an outputs object → persist current summary | Split Unicode characters are decoded across chunks. Empty/invalid summaries fail; earlier result JSON is removed before spawn. Valid partial summaries survive nonzero CLI exit. |
| Step outputs | Valid current summary → append out-dir/cost-usd/result-json to GITHUB_OUTPUT → exit status | No output file means local debug mode. Output write errors fail; they do not rerun the CLI. Multiline values use the Actions delimiter protocol. |
| Delegated graph execution | Load → upfront validation → node running → done/error/skipped → aggregate outputs/cost → save media → print summary | Owned by nanoodle, not this repository. Provider retries/polling and node scheduling remain delegated to its pinned version. A failed/cancelled graph can already have incurred cost. The wrapper never retries it. |
| CI and distribution | Branch push/PR → offline checks → merge → main checks → version tag and moving v1 tag | Consumers of `@v1` receive the tagged source, not automatically the latest main. Smoke tests must fail when pinned CLI resolution fails. The manual demo spends balance and is excluded from audit validation. |

## Verified issues and fixes

1. JSON primitives, arrays and objects without outputs were accepted as successful
   results. Six baseline regression cases failed; summaries now require the
   minimal documented object shape.
2. An empty failed run retained an earlier `nanoodle-result.json`. The baseline
   stale-file regression failed; a new attempt now clears only that known summary
   file, and invalid stdout does not recreate it.
3. SIGTERM killed the worker without reaching npx. The baseline cancellation
   regression failed. The worker now forwards SIGINT/SIGTERM to the POSIX process
   group, escalates stalled shutdown, and retains a failure exit status even if
   the CLI's signal handler exits zero.
4. `timeout-ms` only reached `Workflow.run`, leaving package resolution, graph
   loading and final media saving outside the timeout. The baseline preparation
   regression failed. The worker now enforces a child-lifecycle deadline and
   rejects invalid/overflowing timeout values before launching the CLI.
5. Separately decoding stdout buffers corrupted Unicode split across chunks:
   the baseline produced `����` instead of `🍜`. Stream UTF-8 decoding fixes it.
6. Floating CLI version inputs contradicted the pinned-version contract; they
   now fail before npx. The smoke workflow also uses a floating CLI and converts
   resolution failures into success with `echo pending-release`. That workflow
   correction is blocked: GitHub rejected the push because the existing OAuth
   token lacks workflow scope. The workflow is unchanged; release validation
   relies on the offline CI job and direct pinned CLI checks instead.
7. The real-CLI test requested 0.1.1 despite the installed/default 0.4.0, allowing
   an external fetch and testing a different version. It now uses installed 0.4.0
   against a loopback NanoGPT stub.

## Validation and boundaries

`npm ci --ignore-scripts` installs the lockfile dependency. `npm test` exercises
the actual 0.4.0 CLI against a local API stub plus a fake npx for lifecycle faults.
Coverage includes partial failure, one-attempt behavior, malformed summaries,
stale summary removal, missing executable, UTF-8 boundaries, CLI signal death,
cancellation reaching a descendant, zero-exit signal handlers, invalid options,
and forced shutdown when SIGTERM is ignored. No real NanoGPT request or paid demo
is needed.

Linux/POSIX process-group behavior is verified. Windows retains the existing
direct-child signal path and is not validated by this audit. Process termination
cannot undo a request already accepted by a provider. Media from prior runs is
retained intentionally; callers should use fresh output directories when needed.
Output persistence failures are terminal and do not trigger another paid run.
