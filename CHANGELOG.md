# Changelog

All notable user-facing changes to Pi Experiences are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

## [0.1.47] - 2026-07-21

### Changed

- Approved-habit steering now isolates each candidate judgment. A single low-confidence or below-threshold judgment no longer discards the whole batch, so one ambiguous candidate can no longer suppress otherwise confident, applicable habits. Structurally malformed judge output still fails closed.
- Steering keeps working as an approved-habit collection grows past 100 habits. Reply-time retrieval now deterministically uses the top 100 eligible habits by confidence instead of permanently disabling all guidance. Preparation guarantees the current-law top 100 and adds a best-effort buffer up to 500 for law changes; a future law that exposes habits beyond the buffer fails closed (no injection) until vectors are re-prepared, rather than misbehaving silently.
- Capture no longer drops tool-heavy turns. It captures every assistant message in the run, including runs whose final message is only a tool call, and keeps the tail (where corrections and conclusions live) with a truncation marker when a run is oversized. Because Pi emits several agent_end events for one prompt across its automatic retry boundary, persistence is deferred to the settle boundary and keeps the last non-empty run's answer. A run that terminates in error, aborted, or truncation is dropped in full, so partial, error, or truncated output is never saved, and an exhausted sequence of failed runs captures nothing.
- Habit learning now reasons causally over each batch: it locates friction (corrections, complaints, repeated requests, forced clarifications) — treating adjacency as a bounded heuristic the model is instructed to corroborate rather than a pipeline-enforced guarantee (attributing pushback to a prior response only when the content plausibly refers to it and the timestamps are close, since concurrent sessions can interleave and pairs can be dropped) — infers the behavioral change that would have prevented it, and formulates a generalized When/Do habit rather than clustering superficially similar messages. Friction-derived candidates are the primary, higher-confidence signal; stable positive preferences still qualify with cleaner repetition and lower confidence.
- Habit learning also includes a clear habit-versus-fact-versus-skill-versus-one-off rubric with examples and a stronger instruction to reuse existing habit wording, so repeated patterns accumulate evidence on one habit instead of spawning paraphrased near-duplicates. Analyze retries once on a transient model failure.

### Fixed

- Raised the bounded applicability judge's output budget, reducing the risk that a full set of per-candidate judgments is truncated into total guidance loss (truncation is less likely, not impossible).

## [0.1.46] - 2026-07-18

### Fixed

- Oversized optional follow-up context can no longer invalidate the current-request embedding and silently suppress an otherwise applicable approved habit.
- Contextual retrieval now uses a compact current-first, newest-context-first query within the local model's bounded input budget. Any non-cancellation dual-batch failure retries current-only embedding exactly once; cancellation and current-only failures remain fail-closed, and the model judge remains mandatory.
- Increased the default bounded selector timeout from 5 to 20 seconds while preserving explicit user configuration.
- The applicability judge now receives deterministic short candidate aliases instead of long internal habit IDs, preventing otherwise valid judgments from failing when a model rewrites an identifier. Exact complete alias coverage remains mandatory, and unknown, missing, duplicate, or original-ID output still fails closed.

### Privacy and audit

- Selector failures now create sanitized audit rows containing only closed reason/stage/mode/model/retrieval-mode values. Prompt/context text, derivatives, vectors, similarities, raw errors, judge rationale, and transient guidance remain excluded.
- Candidate aliases and their exact original-ID map are process-local and ephemeral. Accepted aliases are mapped back before state revalidation, guidance construction, returned results, and selected/skipped audit handling.

### Validation

- Added compact-query ordering/Unicode/byte-bound, one-retry, cancellation, mandatory-judge, current-only failure, sanitized-diagnostic, and real pinned-tokenizer/worker regressions, including the reproduced over-128-token contextual failure.
- Added long-ID aliasing, exact alias-copy, original-ID rejection, downstream restoration, skip-log identity, latency-probe, and copied-state judge regressions.

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

[Unreleased]: https://github.com/misunders2d/pi-experiences/compare/v0.1.47...HEAD
[0.1.47]: https://github.com/misunders2d/pi-experiences/compare/v0.1.46...v0.1.47
[0.1.46]: https://github.com/misunders2d/pi-experiences/compare/v0.1.45...v0.1.46
[0.1.45]: https://github.com/misunders2d/pi-experiences/compare/v0.1.44...v0.1.45
[0.1.44]: https://github.com/misunders2d/pi-experiences/compare/v0.1.43...v0.1.44
[0.1.43]: https://github.com/misunders2d/pi-experiences/compare/v0.1.42...v0.1.43
[0.1.42]: https://github.com/misunders2d/pi-experiences/compare/v0.1.41...v0.1.42
[0.1.41]: https://github.com/misunders2d/pi-experiences/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/misunders2d/pi-experiences/compare/v0.1.39...v0.1.40
