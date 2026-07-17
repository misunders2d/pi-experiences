# Changelog

All notable user-facing changes to Pi Experiences are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

### Fixed

- Oversized optional follow-up context can no longer invalidate the current-request embedding and silently suppress an otherwise applicable approved habit.
- Contextual retrieval now uses a compact current-first, newest-context-first query within the local model's bounded input budget. Any non-cancellation dual-batch failure retries current-only embedding exactly once; cancellation and current-only failures remain fail-closed, and the model judge remains mandatory.
- Increased the default bounded selector timeout from 5 to 20 seconds while preserving explicit user configuration.

### Privacy and audit

- Selector failures now create sanitized audit rows containing only closed reason/stage/mode/model/retrieval-mode values. Prompt/context text, derivatives, vectors, similarities, raw errors, judge rationale, and transient guidance remain excluded.

### Validation

- Added compact-query ordering/Unicode/byte-bound, one-retry, cancellation, mandatory-judge, current-only failure, sanitized-diagnostic, and real pinned-tokenizer/worker regressions, including the reproduced over-128-token contextual failure.

## [0.1.45] - 2026-07-17

### Changed

- Approved-habit steering can now resolve bounded follow-ups such as “yes, do that” and “make it two weeks” from up to four prior visible user/assistant messages in the current active branch.
- Current-only and current-plus-context retrieval queries share one local embedding batch; current-only candidates retain priority and contextual retrieval only appends deduplicated candidates.
- Habit assessment now uses strict schema v3 with `context_only_applicability`; the current user message remains the sole causal trigger, while prior context may only resolve an explicit reference, confirmation, continuation, modification, or rejection.

### Privacy and safety

- Context is role-filtered, redacted, capped at 300 characters per message and 1,200 total, snapshotted once per response, and never persisted with its vectors, hashes, similarities, rationale, or transient guidance.
- System, developer, custom, tool, tool-result, thinking, tool-call, image-only, hidden, and stale-branch content cannot supply steering context. Invalid or sensitive context degrades to the unchanged current-only path.
- Assistant text cannot independently trigger a habit; context-only relevance, topic changes, negation, ambiguity, malformed output, timeout, cancellation, and post-judge drift remain fail-closed.
- Setup now discloses the exact prior-message caps, configured-provider exposure, current-message-only causality, heuristic redaction limit, and context non-persistence before reminder enablement.

### Validation

- Added phase-20 extraction, dual-batch retrieval, deterministic union, assistant-reference, user-continuation, context-only rejection, empty-context parity, degradation, non-persistence, and payload-bound regressions.
- Extended host lifecycle coverage to prove context is extracted once and tool-loop callbacks cannot re-embed, rejudge, or replace the snapshotted context.

## [0.1.44] - 2026-07-17

### Fixed

- Scheduled Analyze summaries now use durable TUI-only transcript entries instead of temporary notifications, so results remain visible after reload/startup without entering model context.
- Receipts remain pending unless the durable entry renderer is registered and the transcript append succeeds; stable delivery keys prevent retained receipts from accumulating duplicate transcript notices.

### Validation

- Added durable-entry lifecycle, idempotent retry, unreadable-receipt deduplication, stale-session, missing-renderer, append-failure, and real installed-TUI visibility regressions.

## [0.1.43] - 2026-07-17

### Fixed

- Scheduled Analyze receipts are no longer consumed inside Pi's `session_start` reload/startup hook, where the TUI can redraw over the notification. Receipt checks now wait for a post-render idle boundary or the next settled turn before showing and deleting the summary.

### Validation

- Added a regression requiring reload/startup to preserve pending receipts until a visible post-start lifecycle boundary.

## [0.1.42] - 2026-07-17

### Fixed

- Scheduled Analyze now supports the current Pi runtime API while retaining compatibility with the previous standalone runtime interface.
- Scheduled success and failure receipts are checked throughout an open private TUI session and after settled turns, closing the boot catch-up race where a receipt could arrive just after session startup and remain unseen.
- Background runtime incompatibility is classified and explained separately instead of appearing as a generic model-call failure.

### Validation

- Added current-runtime and legacy-runtime compatibility regressions, late-receipt lifecycle coverage, and a real standalone authenticated model-call probe.

## [0.1.41] - 2026-07-14

### Fixed

- Habit assessment now distinguishes a request made now about a future-dated subject from a condition mentioned only as a possible later trigger. For example, “plan my vacation for next summer” is current applicability, while “if I ask you to plan a trip next month…” remains hypothetical/future.
- Clarified broad `When I mention or ask about X` conditions so present paraphrased requests to discuss, plan, compare, schedule, or decide X can apply without weakening mention, quotation, negation, ambiguity, strict-schema, or fail-closed gates.

### Validation

- Added production-prompt assertions and positive/negative vector-selector regressions for the future-subject boundary.
- Verified the configured assessment model selects the future-dated current request and rejects the possible later trigger; provider timeout still fails closed with no fallback.

## [0.1.40] - 2026-07-14

### Changed

- User messages now render immediately after submission; local embedding and bounded habit assessment run at the first provider-context boundary instead of blocking message display.
- Tool loops and retries reuse one response-specific assessment without duplicate markers or model calls.

### Fixed

- Preserved exact visible order: triggering user message → selected habit marker → assistant response.
- No-selection and provenance failures retain transient no-guidance state so the same response cannot retry assessment or steer invisibly.

### Validation

- Added synchronous submission-hook checks, deferred embedding/model assertions, and a packed Pi TUI smoke requiring submitted-message rendering within 1.5 seconds.

[Unreleased]: https://github.com/misunders2d/pi-experiences/compare/v0.1.45...HEAD
[0.1.45]: https://github.com/misunders2d/pi-experiences/compare/v0.1.44...v0.1.45
[0.1.44]: https://github.com/misunders2d/pi-experiences/compare/v0.1.43...v0.1.44
[0.1.43]: https://github.com/misunders2d/pi-experiences/compare/v0.1.42...v0.1.43
[0.1.42]: https://github.com/misunders2d/pi-experiences/compare/v0.1.41...v0.1.42
[0.1.41]: https://github.com/misunders2d/pi-experiences/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/misunders2d/pi-experiences/compare/v0.1.39...v0.1.40
