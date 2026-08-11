# Changelog

All notable user-facing changes to Pi Experiences are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

## [0.1.61] - 2026-08-11

### Fixed

- Replaced broad `sk`/`pk` substring matching with one shared format-specific secret-token detector used by both redaction and validation. Ordinary words and hyphenated prose no longer fail habit learning as false credentials, while recognized OpenAI-style, Stripe, GitHub, Slack, Google OAuth, and AWS key formats remain protected.
- Corrected the packed-install verifier's stale expected package version and stopped treating non-semantic directory timestamp changes from an active Pi session as live-state mutations; file metadata, hashes, directory identity/mode, and final tree contents remain checked.

### Validation

- Added redaction and typed-learning regressions for safe token lookalikes, recognized fake token formats, and the model-output content path that previously failed.

## [0.1.60] - 2026-08-11

### Fixed

- Included approved typed Experiences in **Manage habits** counts and **Review approved habits**, while excluding migrated copies of legacy habits so upgraded installations do not double-count or double-list them.
- Added a reviewed disable action for active typed Experiences in the approved-record panel.

### Validation

- Added setup regression coverage for distinct typed Experience counts, migrated-habit deduplication, approved-record visibility, and reviewed disabling.

## [0.1.59] - 2026-08-11

### Fixed

- Unified **Review suggested habits** across Pi and OMP so typed Experience candidates appear beside legacy habit candidates and can be approved or rejected through the same setup flow.

### Validation

- Added dual-host setup regression coverage for typed candidate visibility and approval.

## [0.1.58] - 2026-08-10

### Fixed

- Added trusted visible provenance for OMP-native habit guidance: Pi Experiences now contributes current-review opaque aliases with exact approved `When:` / `Do:` text, and patched OMP renders a distinct **Experience** card only after validating the cited alias. The validated correction tells the primary agent to follow the exact approved behavior unless higher-priority instructions or safety conflict.

### Validation

- Added a dual-host adapter regression proving OMP policy metadata contains exact approved wording without durable habit IDs.

## [0.1.57] - 2026-08-10

### Fixed

- Restricted OMP Advisor semantic retrieval to the latest user and assistant text so provider metadata cannot displace an applicable approved habit.
- Prioritized an applicable approved-habit violation over unrelated native Advisor findings so OMP's one-note gate delivers the Experience correction first.

### Validation

- Added regressions requiring text-only retrieval input and habit-first Advisor precedence.


## [0.1.56] - 2026-08-10

### Fixed

- Restored local semantic retrieval in Bun-compiled OMP builds by loading the tokenizer through an explicit installed-package URL and using the self-contained ONNX Runtime bundle. Pi's Node runtime is unchanged.
- Prioritized the current user request and latest assistant action in OMP Advisor retrieval so large tool transcripts cannot displace the approved habit that should supervise the turn.
- Clarified OMP Advisor precedence so a request matching an approved habit trigger activates that habit unless the user explicitly conflicts with or suspends its required behavior.

### Validation

- Added runtime-module resolution regressions and verified real multilingual embeddings in both Bun and the compiled OMP host.
- Added a noisy-transcript regression proving retrieval input stays compact while retaining the current request and latest assistant action.

## [0.1.55] - 2026-08-10

### Fixed

- Aligned the setup suggestion counter with **Review suggested habits**. Approved-but-waiting habits remain under **Review approved habits** and no longer inflate the actionable suggestion count.

### Validation

- Added a regression proving approved-but-waiting habits do not affect the suggested-habit count.



## [0.1.54] - 2026-08-09

### Fixed

- Kept internal legacy-migration quarantine records out of the suggested-habit review list, so the first actionable habit again renders its exact `When` and `Do` details. Quarantine records remain stored for integrity diagnostics.

### Validation

- Added a regression covering a legacy quarantine record ahead of a real habit candidate and verified the focused review panel renders the candidate details.


## [0.1.53] - 2026-08-09

### Fixed

- Added a runtime-neutral SQLite adapter so Pi continues using Node's `node:sqlite` while OMP uses Bun's `bun:sqlite`. Existing ledgers, schemas, and backup behavior remain shared across both hosts.
- Removed Pi-only visual-provenance steering from the OMP path; OMP now supplies approved Experience context exclusively through its native Advisor.

### Validation

- Added Node and Bun regression coverage for database creation, reopening, backup, integrity verification, host routing, and OMP-only native Advisor behavior.


## [0.1.52] - 2026-08-09


### Added

- Added first-class OMP package discovery and host detection. OMP now receives bounded, relevant, approved Experience context through its native Advisor; the package does not start a second Advisor or add another reviewer-model call.
- Kept `/experience setup` as the complete settings menu on both hosts, with OMP-specific Advisor context controls and OMP-owned native Advisor model/enablement.

### Changed

- Generalized approved Experience retrieval and conversational review tools beyond habits while preserving approval, revalidation, privacy, and exact-provenance gates.
- Pi keeps the existing Runtime Advisor and provider-guidance behavior unchanged; OMP uses only its native Advisor path.

### Validation

- Added phase 26–31 taxonomy, typed-learning, retrieval, review, dual-host adapter, and OMP-native Advisor retention gates.

## [0.1.51] - 2026-08-05

### Fixed

- Made the Node.js 24 release check deterministic by using the Advisor sync-backlog test control instead of a zero-delay timer before lifecycle fallback validation. Runtime behavior is unchanged.

## [0.1.50] - 2026-08-05

### Added

- Added an opt-in Runtime Advisor that uses a separately configurable authenticated Pi model to review bounded incremental primary-turn updates only against exact approved habits. Reviewer reasoning and generic best practices cannot create standalone policy or advice; investigation remains workspace-confined and read-only, and Advisor never pre-execution-blocks primary tools.
- Added grouped setup for **Learning from conversations**, **Guidance and Advisor**, **Manage habits**, **Automation and privacy**, and **Status and help**. The Advisor model inherits the habit-assessment model by default and can be overridden independently.

### Safety and privacy

- Advisor findings steer only eligible active concern/blocker continuations; nits and unsafe/canceled/terminal/plan-mode/unsupported states append visibly without forcing another turn. Learning-off writes no Advisor observation, while Learning-on still requires repeated evidence, Analyze, human review, and explicit approval before any habit can change.
- Private Advisor transcript state, raw model output, candidate aliases, retrieval scores, tool investigations, queue state, and suppressed findings remain process-local and are never persisted.

### Validation

- Added phase 23–25 package gates, packed Advisor/setup allowlists and peer checks, a fresh isolated-package verifier, and real Pi PTY coverage for grouped setup plus collapsed/expanded approved-habit Advisor cards at wide and narrow widths.

## [0.1.49] - 2026-07-21

### Fixed

- One explicit manual Analyze action now processes every saved example waiting when the action starts through sequential bounded model calls. Per-call record/byte limits remain unchanged; later appends wait for the next run, successful batches commit atomically, later failure or cancellation reports preserved progress honestly, and the user receives one final summary instead of repeated-click batch instructions. Scheduled Analyze remains one bounded batch per run.

### Validation

- Added snapshot-bound range, multi-batch manual drain, post-start append exclusion, partial-failure/cancellation, watermark, notification, lock-release, and conflict-coverage regressions.

## [0.1.48] - 2026-07-21

### Fixed

- Approved-habit guidance is no longer serialized as a hidden custom message that providers interpret as user-authored text. After the triggering user message is rendered and applicability is assessed, guidance is added transiently to a verified system-instruction field for each entry in the package's explicit provider-payload allowlist. Unknown APIs, malformed payloads, conflicting guidance frames, and marker failures fail closed with no fallback to user content.

### Validation

- Added immutable/idempotent payload tests for every entry in the package's ten-entry provider-payload allowlist, plus lifecycle regressions for marker ordering, retries, tool continuations, stale state, unsupported APIs, and provenance failure.

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

[Unreleased]: https://github.com/misunders2d/pi-experiences/compare/v0.1.61...HEAD
[0.1.61]: https://github.com/misunders2d/pi-experiences/compare/v0.1.60...v0.1.61
[0.1.60]: https://github.com/misunders2d/pi-experiences/compare/v0.1.59...v0.1.60
[0.1.59]: https://github.com/misunders2d/pi-experiences/compare/v0.1.58...v0.1.59
[0.1.58]: https://github.com/misunders2d/pi-experiences/compare/v0.1.57...v0.1.58
[0.1.57]: https://github.com/misunders2d/pi-experiences/compare/v0.1.56...v0.1.57
[0.1.56]: https://github.com/misunders2d/pi-experiences/compare/v0.1.55...v0.1.56
[0.1.55]: https://github.com/misunders2d/pi-experiences/compare/v0.1.54...v0.1.55
[0.1.54]: https://github.com/misunders2d/pi-experiences/compare/v0.1.53...v0.1.54
[0.1.53]: https://github.com/misunders2d/pi-experiences/compare/v0.1.52...v0.1.53
[0.1.52]: https://github.com/misunders2d/pi-experiences/compare/v0.1.51...v0.1.52
[0.1.51]: https://github.com/misunders2d/pi-experiences/compare/v0.1.50...v0.1.51
[0.1.50]: https://github.com/misunders2d/pi-experiences/compare/v0.1.49...v0.1.50
[0.1.49]: https://github.com/misunders2d/pi-experiences/compare/v0.1.48...v0.1.49
[0.1.48]: https://github.com/misunders2d/pi-experiences/compare/v0.1.47...v0.1.48
[0.1.47]: https://github.com/misunders2d/pi-experiences/compare/v0.1.46...v0.1.47
[0.1.46]: https://github.com/misunders2d/pi-experiences/compare/v0.1.45...v0.1.46
[0.1.45]: https://github.com/misunders2d/pi-experiences/compare/v0.1.44...v0.1.45
[0.1.44]: https://github.com/misunders2d/pi-experiences/compare/v0.1.43...v0.1.44
[0.1.43]: https://github.com/misunders2d/pi-experiences/compare/v0.1.42...v0.1.43
[0.1.42]: https://github.com/misunders2d/pi-experiences/compare/v0.1.41...v0.1.42
[0.1.41]: https://github.com/misunders2d/pi-experiences/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/misunders2d/pi-experiences/compare/v0.1.39...v0.1.40
