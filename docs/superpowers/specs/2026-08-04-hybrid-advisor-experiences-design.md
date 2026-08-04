# Hybrid Advisor and Experiences Design

Date: 2026-08-04
Status: Approved conversational design; implementation not yet started

## Goal

Add an OMP-style persistent runtime Advisor to Pi Experiences and combine it with Experiences' approved-habit retrieval, compliance, and human-reviewed learning lifecycle.

The hybrid has three explicitly different outputs:

1. **Generic Advisor finding** — model judgment based on the current execution and optional reviewer instructions.
2. **Approved-habit violation** — a finding grounded in one exact human-approved `When` / `Do` record retrieved by Experiences.
3. **Advisor learning observation** — bounded evidence that may later contribute to a reviewed habit suggestion, but is never a habit or instruction by itself.

These outputs must remain distinct in authority, schema, rendering, persistence, and downstream behavior.

## Product decisions

The approved design decisions are:

- implement the hybrid rather than habit-only runtime supervision;
- use a separate long-lived Advisor agent;
- let the Advisor model inherit the habit-assessment model by default, with an optional separate override;
- keep Runtime Advisor and approved-habit guidance independently switchable;
- give Advisor isolated read-only `read`, `grep`, and `glob` tools;
- use OMP-like severity delivery and safe live steering for `concern` and `blocker`;
- never pre-execution-block a primary tool call;
- let accepted Advisor findings become learning evidence only when Learning from conversations is enabled;
- keep all existing Analyze repetition, review, and explicit-approval gates;
- replace the current fifteen-row setup home with a grouped setup home and focused subpanels;
- do not add a separate hybrid-mode switch or Advisor-learning switch.

## Existing Experiences behavior preserved

The current learning and approval lifecycle remains authoritative:

- capture and Analyze create review-only evidence and suggestions;
- a new or materially reworded habit requires explicit human approval;
- pending, rejected, disabled, superseded, archived, and invalid records are not active policy;
- local vectors retrieve and rank; they never decide applicability, violations, duplicate resolution, or approval;
- exact durable IDs never enter model prompts;
- stale, corrupt, missing, canceled, unauthenticated, unsupported, or malformed state fails closed;
- advice and reviewer findings cannot create, edit, approve, merge, replace, activate, disable, supersede, archive, or delete habits.

The existing pre-response selector remains a separate path. Its causal trigger is the current user request. It continues to retrieve approved habit conditions locally, run its strict applicability judge, render exact steering provenance, and inject transient provider guidance.

## Runtime architecture

### Separate Advisor agent

Experiences creates one long-lived `Agent` from `@earendil-works/pi-agent-core` for the current Pi session.

The Advisor has:

- its own model instance and model context;
- its own bounded transcript;
- its own abort controller and queue;
- isolated read-only workspace tools;
- no primary edit, write, shell, browser, memory, subagent, session, or yield capabilities;
- no direct access to the habit database;
- no habit mutation tools;
- no durable private transcript.

The Advisor model is resolved as:

1. explicit Advisor model override, when configured and available;
2. otherwise the configured habit-assessment model.

The Advisor model and primary model may name the same underlying provider/model, but they remain separate calls and contexts.

### Primary event stream

At each completed primary turn, Experiences captures one immutable bounded delta containing:

- finalized assistant text;
- assistant reasoning when available from the documented Pi message shape;
- tool-call intent;
- tool names and bounded sanitized arguments;
- bounded tool result status and content needed to assess the action;
- the current user request and minimal primary constraint context required to interpret the new turn.

The new turn is the causal event. Old context may resolve references but cannot independently generate a finding.

Primary Advisor messages and Experience intervention entries are filtered from future deltas. This prevents recursive self-review and evidence manufacture.

### Incremental context

The runtime tracks a cursor over the primary transcript and sends only new deltas after the first update. The Advisor retains its own review context across turns.

Compaction, session switch/resume, branch/fork history replacement, model rebuild, feature disablement, and session shutdown reset the Advisor epoch. Any late result from a prior epoch is discarded.

When enabled mid-session, the cursor seeds to the current primary transcript so old history is not replayed as a new event.

### Queue and catch-up

The runtime uses:

- a single-flight reviewer queue;
- immutable queued deltas;
- bounded backlog;
- bounded late-arrival coalescing;
- monotonically increasing cursor and epoch;
- cancellation before reset or shutdown;
- stale-result rejection after every await;
- failure handling that never permanently stalls the primary;
- one accepted emission per Advisor update.

The default favors asynchronous primary throughput. A bounded advanced config value may allow OMP-style catch-up thresholds, but this is not added to the normal setup UI.

### Hard runtime bounds

The initial implementation uses these limits:

- primary delta: 24,000 redacted characters;
- represented primary tool calls/results: 8 per update;
- approved-habit candidates: 8, with active request habits first;
- queued update batches: 5; later arrivals coalesce into the newest pending batch within the delta cap;
- Advisor update timeout: 60 seconds;
- read-only Advisor tool calls: 3 per update;
- generic accepted note: 1,200 characters;
- accepted emissions: 1 per update;
- persisted `advisor_finding` observation: 6,000 redacted characters;
- immune turns after interrupting delivery: 3;
- normalized session dedupe ring: 4,096 entries.

The Advisor context is maintained before it reaches 75% of the selected model's context window. Maintenance resets and re-primes from the current bounded primary context; it never replays abandoned pre-compaction history. Overflow, timeout, exhausted tool budget, and queue coalescing remain fail-open for the primary and fail-closed for new advice.

## Advisor tools and instructions

The Advisor receives isolated read-only `read`, `grep`, and `glob` tools rooted at the primary working directory.

Tool state is not shared with the primary agent. The Advisor cannot mutate files, execute commands, send messages directly, create subagents, or access Experiences storage.

Optional `WATCHDOG.md` instructions may specialize generic review priorities. They:

- are Advisor-only context;
- are untrusted relative to system safety rules;
- may support generic findings;
- cannot establish an approved-habit violation;
- cannot create learning authority or bypass Experiences review.

No WATCHDOG control is added to `/experience setup`; this remains a documented advanced file convention.

## Habit retrieval and compliance

Before each Advisor update, Experiences builds a bounded approved-habit candidate set from:

1. active habits selected by pre-response steering for the current request; and
2. additional active approved habits retrieved locally against the new behavior delta.

Runtime retrieval uses prepared condition and behavior vectors. Already-active habits occupy candidate slots first; additional candidates fill remaining slots in deterministic similarity order.

Only active, human-approved, integrity-valid, current-law habits may enter the Advisor update. Pending or changed records are excluded.

Candidates are rendered under deterministic process-local aliases such as `h1`, `h2`, and `h3`. Each candidate contains exact bounded `When` and `Do` wording. The Advisor never receives durable IDs, checksums, evidence, vector values, scores, source references, or audit data.

The Advisor has two emission tools:

```text
advise(note, severity)
report_habit_violation(habit_alias, severity)
```

`advise` records generic reviewer judgment. Its note is model-authored and visibly framed as advice to weigh rather than policy.

`report_habit_violation` accepts only an exact supplied alias and severity. The runtime maps the alias back and immediately revalidates:

- current user;
- active approved status;
- exact condition and behavior identity;
- checksum and approval identity;
- current law;
- response generation, cursor, and Advisor epoch.

The Advisor does not write habit correction prose. Experiences constructs habit guidance from the exact approved `Do` wording.

Unknown, missing, duplicate, rewritten, original-ID, stale, inactive, or changed aliases fail closed.

## Emission priority and guard

An Advisor update may attempt several tool calls, but at most one finding reaches the primary.

The runtime buffers attempted emissions until the update completes, then applies this priority:

1. valid approved-habit violation;
2. concrete generic `blocker`;
3. concrete generic `concern`;
4. concrete generic `nit`.

The emission guard:

- normalizes case, Unicode, punctuation, and whitespace;
- rejects empty and content-free phrases;
- rejects generic praise or completion chatter;
- deduplicates equivalent accepted notes within a bounded session ring;
- limits one accepted finding per update;
- suppresses an equal or lower-severity duplicate in the same causal episode;
- permits a genuinely new later violating event;
- resets safely on Advisor epoch reset.

Suppression is not exposed to the Advisor model, preventing paraphrase loops.

## Severity and delivery

Delivery follows the OMP Advisor model:

- `nit` — noninterrupting aside delivered at the next safe step boundary;
- `concern` — live steering when a material risk should affect ongoing work;
- `blocker` — live steering when continuing would clearly waste work or produce a broken or unsafe result.

There is no pre-execution tool blocking.

Safe-delivery rules:

- while the primary loop is active, a concern or blocker may enter through Pi's documented steering channel;
- a user-interrupted or canceled run is never unexpectedly restarted;
- a late terminal-answer concern is preserved visibly instead of forcing a restatement;
- a blocker may resume nonterminal yielded work when Pi's current mode/client safely supports agent-initiated continuation;
- plan mode and clients that cannot represent agent-initiated turns preserve visible findings rather than steering;
- immune turns limit repeated interrupting delivery after a successful steer;
- unavailable delivery degrades to a visible preserved card, never a fake user message or hidden session mutation.

## Primary transcript and persistence

Accepted generic advice and habit violations are visible primary-session artifacts because the main agent and user must be able to observe them.

Generic Advisor message:

```text
◇ Advisor · concern
  <model-authored concrete note>
```

Habit violation:

```text
◇ Experience · habit violation · blocker
  When: <exact approved condition>
  Do: <exact approved behavior>
  Next step: <exact approved behavior>
```

Generic advice is injected with explicit “weigh, do not blindly obey” framing. Habit correction is exact approved behavior and carries stronger provenance.

The following remain process-local and are never persisted:

- Advisor system prompt and private transcript;
- raw primary deltas and request context;
- reasoning not already in the primary transcript;
- retrieved candidate lists and aliases;
- vectors and similarity scores;
- suppressed findings;
- raw Advisor model output;
- tool investigation results not surfaced in an accepted finding;
- queue, cursor, epoch, cooldown, and dedupe internals.

Visible entries contain no durable habit IDs, aliases, vector data, scores, checksums, provider credentials, private paths, or raw reviewer state.

## Learning from Advisor findings

When Learning from conversations is OFF, accepted Advisor findings are ephemeral review/delivery only and create no Experience observation.

When Learning from conversations is ON, one accepted finding may create one bounded redacted `advisor_finding` observation containing:

- the bounded current user request;
- the bounded primary behavior that caused the finding;
- finding kind (`generic_advice` or `habit_violation`);
- accepted severity;
- sanitized accepted note or exact approved behavior;
- timestamp and non-sensitive origin metadata;
- a stable event fingerprint for duplicate suppression.

It does not contain Advisor reasoning, tool investigation transcripts, aliases, vectors, scores, model/provider identity, habit IDs, or raw primary transcript.

Advisor findings do not directly create suggestions. Existing Analyze processing must:

- require distinct observation evidence;
- preserve the existing repetition and day thresholds;
- distinguish Advisor-origin evidence from user-origin examples;
- avoid counting replays or repeated advice on the same causal episode;
- create review-only suggestions;
- require explicit human approval of exact `When` / `Do` wording.

Advisor findings generated in response to prior Advisor messages are excluded from learning evidence.

## Configuration

New configuration is bounded to Advisor runtime needs:

- `advisor_enabled: boolean` — default `false`;
- `advisor_model: string` — empty means inherit `selector_model`;
- `advisor_timeout_ms: number` — default `60000`, clamped to `5000..120000`;
- `advisor_sync_backlog: "off" | 1 | 3 | 5` — advanced config, default `"off"`;
- `advisor_immune_turns: number` — default `3`, clamped to `0..10`.

No separate hybrid-mode, habit-compliance, Advisor-learning, or Advisor-tools toggle is added.

Existing `selector_enabled` independently controls:

- direct pre-response approved-habit steering; and
- approved-habit candidates and violation authority inside Advisor updates.

When Advisor is on and approved habits are off, Advisor performs generic review only.

When approved habits are on and Advisor is off, existing direct steering continues unchanged.

When both are on, the hybrid path is active.

## Simplified `/experience setup`

### Grouped home

Replace the current fifteen-row flat setup with:

```text
Agent Experience setup

Learning from conversations       OFF
Guidance and Advisor              Advisor OFF · habits OFF
Manage habits                     12 approved · 2 waiting
Automation and privacy            Manual · 7-day retention
Status and help
Turn everything off
Done
```

The custom TUI and fallback select menu expose the same grouping and ordering.

### Learning from conversations

```text
Learn from conversations          OFF
Habit-learning model              openai-codex/gpt-5.5
Analyze waiting examples          14 waiting
Review suggested habits           2 waiting
Back
```

Turning learning on enables bounded local conversation capture and Advisor-finding observations. The disclosure states that no suggestion is auto-approved.

### Guidance and Advisor

```text
Runtime Advisor                   OFF
Advisor model                     Same as habit assessment
Use approved habits               OFF
Habit-assessment model            openai-codex/gpt-5.4-mini
Back
```

Runtime Advisor and approved habits are independent switches.

The Advisor model picker uses the existing authenticated searchable model chooser and adds **Same as habit assessment**.

Enabling Advisor requires:

- a resolvable authenticated Advisor model;
- one concise disclosure covering the separate model, incremental transcript review, read-only workspace tools, visible steering, bounded local state, and possible learning evidence when Learning is on;
- explicit confirmation.

Enabling approved habits preserves the current law check, local-vector preparation, provider disclosure, and explicit confirmation.

No third hybrid control appears; turning on both features composes them automatically.

### Manage habits

```text
Review approved habits            12
Resolve possible duplicates       1 waiting
Prevent duplicate habits          ON
Back
```

### Automation and privacy

```text
Keep analyzed source examples     7 days
Automatic Analyze schedule        OFF
Review prompts after Analyze      OFF
Local semantic files              Ready
Back
```

Local semantic files are shared by approved-habit retrieval and duplicate prevention. Required preparation occurs contextually when a dependent feature is enabled. The row supports explanation, verification, and explicit removal without presenting embedding implementation details.

### Status and help

One focused panel shows:

- Learning status, model, and waiting observations/suggestions;
- Advisor enabled/model/inheritance, runtime status, and bounded queue health;
- approved-habit guidance status and assessment model;
- active/disabled/pending/duplicate counts;
- retention, schedule, review-prompt, and semantic-file status;
- concise grouped explanations.

### Setup simplification rules

- model, retention, schedule, duplicate, break-in, and local-file controls do not appear on the home screen;
- direct typed setup subcommands remain backward-compatible maintainer shortcuts but are not advertised as normal workflow;
- opening setup remains read-only;
- no installation or update enables a feature;
- **Turn everything off** disables capture, Advisor, direct habit steering, schedule, and break-in gates while preserving habits, observations, audit, and local files;
- turning off one grouped feature does not silently disable unrelated features.

## Privacy and diagnostics

Existing redaction and secret detection apply before any primary delta, context, Advisor observation, or habit candidate reaches an external model.

Redaction is heuristic and setup disclosures state this accurately.

Diagnostics and metrics use only allowlisted static stages, reasons, states, and counts. They contain no prompts, transcript text, habit IDs, event fingerprints, vectors, scores, corrections, model output, provider payloads, session identifiers, or raw errors.

## Validation

Add focused deterministic coverage for:

1. Advisor disabled produces no runtime or model work;
2. inherited and explicit Advisor model resolution;
3. incremental delta cursor and bounded formatting;
4. reasoning/tool intent/tool result inclusion and redaction;
5. Advisor-message recursion exclusion;
6. read-only tool isolation and absence of mutating tools;
7. generic compliant silence;
8. concrete nit, concern, and blocker emission;
9. content-free, duplicate, and over-budget emission suppression;
10. OMP-like safe steering, preservation, cooldown, user-interrupt, terminal-answer, plan-mode, and unsupported-client behavior;
11. active request habit union with behavior-retrieved habits;
12. pending, rejected, disabled, superseded, archived, stale, and invalid habit exclusion;
13. exact alias mapping and unknown/duplicate/rewritten/original-ID rejection;
14. full `When` / `Do` proposition grounding and false-positive rejection;
15. habit violation priority over generic advice;
16. exact approved behavior correction and visible provenance;
17. changed habit/law/generation/cursor/epoch rejection before emission;
18. compaction, branch/session transition, cancellation, model change, disable, and shutdown reset;
19. timeout, auth, quota, malformed output, tool failure, and repeated failure never stall the primary;
20. no private Advisor transcript or raw finding persistence;
21. Learning OFF creates no Advisor observations;
22. Learning ON creates one bounded deduplicated `advisor_finding` observation;
23. Advisor observations cannot directly create or approve habits;
24. repeated findings enter existing Analyze thresholds and human review;
25. existing request selector, capture, Analyze, review, duplicate, schedule, break-in, storage, and provider-guidance tests remain passing;
26. grouped setup home and every focused subpanel;
27. setup custom and fallback menu parity;
28. Advisor model inheritance/override and explicit enable disclosure;
29. all-off and independent-switch behavior;
30. narrow/wide grouped setup and Advisor/Experience card screenshots.

Run focused tests, the complete `npm run check`, `npm audit --omit=dev`, `git diff --check`, generated CLI checks, and `node scripts/verify-packed-install.mjs`.

Use isolated temporary state only. Do not touch the installed Experience state.

Update existing README, extension README, validation guide, public skill, and Unreleased changelog to match verified behavior.

## Stop gates

This design authorizes implementation and isolated validation only.

Do not:

- install or update the live extension;
- reload Pi;
- change timers;
- bump package version;
- create a release or tag;
- merge or push;
- stage or publish npm artifacts.

## Success criteria

The implementation succeeds when a separate persistent Advisor can review the main agent incrementally, investigate with isolated read-only tools, deliver OMP-like generic advice, enforce exact retrieved approved habits with stronger provenance, and contribute bounded findings to the existing human-reviewed learning pipeline.

It must preserve Experiences' approval authority, embedding retrieval, privacy, stale-state discipline, direct selector behavior, and fail-closed guarantees while making `/experience setup` materially simpler than the current flat control panel.
