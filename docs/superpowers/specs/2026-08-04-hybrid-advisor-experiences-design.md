# Approved-Habit Runtime Advisor Design

Status: corrected design. This document supersedes the earlier hybrid-policy draft.

## Purpose

Runtime Advisor gives Pi a second, private review plane. It inspects each new assistant/tool event and asks one narrow question: did this event violate an explicitly approved Experience habit supplied for this exact review?

The Advisor may reason about evidence, but it may not invent policy. Approved Experience habits are the complete runtime policy source.

## Authority

- Only active, current-law, confidence/freshness-eligible approved habits may be supplied.
- Pending, rejected, archived, malformed, stale-law, rewritten, or otherwise ineligible records never supervise.
- Candidate aliases are deterministic, process-local, and ephemeral.
- Similarity retrieves candidates only. A structured model judgment is mandatory.
- Full condition/action proposition must align. Shared keywords, verbs, quoted text, metalinguistic references, negation, hypotheticals, and historical discussion do not establish a violation.
- Direct current user instructions and configured law override habits. Conflict or ambiguity requires silence.

## Causality

Direct habit steering and Runtime Advisor are separate:

1. A current user message may select habits for the response before generation.
2. A new assistant/tool event may trigger one Advisor review after the event.
3. Older context may resolve the new event but may not independently cause a finding.
4. A repeated event fingerprint is suppressed; a genuinely new later event may report the same habit again.

Queue coalescing must bind review text, persistence-safe observation text, cursor, entry IDs, and fingerprint to the same merged causal batch.

## Emission contract

The private reviewer receives one emission tool:

- `report_habit_violation(habit_alias, severity)`

Allowed severity is `concern` or `blocker`. Plain model prose is not a finding. Missing aliases, aliases not supplied for the update, extra fields, unsupported severity, malformed output, duplicate output, and all non-habit attempts fail closed.

Before model-visible correction:

1. reload current configuration;
2. verify exact runtime/authority signature;
3. reopen storage read-only;
4. revalidate law, active status, exact approved identity, checksum, confidence, freshness, generation, cursor, epoch, and alias map;
5. construct the visible card only from exact approved `When:` / `Do:` wording;
6. append visible provenance before sending transient correction.

The transient correction uses an allowlisted system-instruction location. It is never a fake user message and never durable hidden session content.

## Delivery

- Safe active states may receive a non-triggering steer.
- Plan mode, ambiguous plan state, canceled/terminal turns, immunity windows, or unavailable steering defer to settled append or visible-only fallback.
- Runtime Advisor never pre-blocks a tool call, vetoes execution, forces continuation, or uses `followUp`/`nextTurn`.
- One review update has one assessment/intervention budget.

## Private reviewer lifecycle

The Advisor model is separate from the primary model. Its message/tool context is reset before every update and cleared after every review. Stale aliases, habits, workspace investigation, or tool output must not influence a later update.

Workspace investigation is optional and confined to bounded, redacted `read`, `grep`, and `glob` tools. No write, shell, delete, network, credential, or state-root access exists.

## Persistence and learning

The following never persist: prompts, current user request, transcript delta, vectors, scores, aliases/maps, raw reviewer output/errors, private reviewer messages, workspace investigation, tool arguments/results, thinking, credentials, or primary tool-result bytes.

When Learning is enabled and exact model-visible delivery succeeds, one bounded observation may contain only:

- visible assistant behavior (or static categorical tool activity);
- exact approved behavior;
- severity;
- causal event fingerprint;
- timestamp.

Learning-off, UI-only fallback, Advisor-caused generation, duplicate fingerprint, residual sensitive text, or any malformed state appends nothing. Analyze remains local and review-only; observations can propose candidates but never approve or activate habits.

## Configuration

Runtime Advisor is opt-in and disabled by default. `/experience setup` remains the normal-user control surface for Advisor state/model and approved-habit use. Installation does not activate Advisor, timers, capture, or model downloads.

## Verification gates

Release requires deterministic coverage for:

- strict habit-only emissions and malformed alternate-policy rejection;
- full-proposition applicability and exact alias coverage;
- active-habit revalidation and authority mutation revocation;
- direct-user/law precedence silence;
- per-update private model reset and alias reuse;
- no user-prompt sentinel in durable bytes or Analyze prompt;
- causal coalescing of review and observation evidence;
- cancellation, transition, settlement, duplicate, and stale-state behavior;
- collapsed/expanded approved-habit concern/blocker cards at wide and narrow widths;
- packed isolated installation with repository and live Experience state unchanged.
