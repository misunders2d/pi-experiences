# Changelog

All notable user-facing changes to Pi Experiences are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/misunders2d/pi-experiences/compare/v0.1.41...HEAD
[0.1.41]: https://github.com/misunders2d/pi-experiences/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/misunders2d/pi-experiences/compare/v0.1.39...v0.1.40
