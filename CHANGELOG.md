# Changelog

All notable user-facing changes to Pi Experiences are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/misunders2d/pi-experiences/compare/v0.1.44...HEAD
[0.1.44]: https://github.com/misunders2d/pi-experiences/compare/v0.1.43...v0.1.44
[0.1.43]: https://github.com/misunders2d/pi-experiences/compare/v0.1.42...v0.1.43
[0.1.42]: https://github.com/misunders2d/pi-experiences/compare/v0.1.41...v0.1.42
[0.1.41]: https://github.com/misunders2d/pi-experiences/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/misunders2d/pi-experiences/compare/v0.1.39...v0.1.40
