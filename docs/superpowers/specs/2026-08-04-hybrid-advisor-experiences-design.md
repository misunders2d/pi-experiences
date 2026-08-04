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

This approved hybrid decision explicitly supersedes the earlier handoff's habit-only runtime scope and prohibition on generic Advisor/WATCHDOG findings. It does **not** supersede that handoff's approval, provenance, privacy, stale-state, fail-closed, or no-policy-invention constraints: generic findings remain disclosed model judgment, never approved policy.

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

At each completed primary turn, Experiences captures one immutable bounded envelope stamped at event time with the exact session scope, Advisor epoch, response generation, current user-entry identity, ordered assistant/tool-result entry identities, cursor, and causal-episode identity. The redacted delta contains:

- finalized assistant text;
- assistant reasoning when available from the documented Pi message shape;
- tool-call intent;
- tool names and bounded sanitized arguments;
- bounded tool result status and content needed to assess the action;
- the current user request and minimal primary constraint context required to interpret the new turn.

The new causal episode is the sole trigger. Stable session-entry identities distinguish a later identical action from replay of the same event. Old context may resolve references but cannot independently generate a finding.

Advisor custom messages are tracked through `message_start`/`message_end`. Any assistant/tool turn causally triggered by Advisor steering is marked process-locally and excluded in full from subsequent review and learning; filtering only the custom block is insufficient.

### Incremental context

The runtime tracks a cursor over the primary transcript and sends only new deltas after the first update. The Advisor retains its own review context across turns.

Session switch/fork, compaction, active-branch tree navigation, model rebuild, feature disablement, and session shutdown reset the Advisor epoch. Before-events abort the old runtime before replacement; successful `session_start`, `session_compact`, or `session_tree` reseeds scope, generation, and cursor. A canceled before-event reseeds the unchanged current branch rather than reviving aborted state. Any late result from a prior epoch is discarded.

When enabled mid-session, the cursor seeds to the current primary transcript so old history is not replayed as a new event. Queued envelopes retain the scope/generation/epoch captured when they were created; later runtime state never restamps them.

### Queue and catch-up

The runtime uses:

- a single-flight reviewer queue;
- immutable generation-stamped queued envelopes;
- bounded backlog;
- bounded late-arrival coalescing only within one response generation/causal episode, preserving the ordered primary entry identities and recomputing the merged fingerprint;
- monotonically increasing cursor and epoch;
- cancellation before reset or shutdown;
- scope/generation/cursor/epoch stale-result rejection after every await and immediately before delivery;
- failure handling that never permanently stalls the primary;
- one accepted emission per Advisor update.

The default favors asynchronous primary throughput. A bounded advanced config value may allow OMP-style catch-up thresholds, but this is not added to the normal setup UI.

### Hard runtime bounds

The initial implementation uses these limits:

- primary delta: 24,000 redacted characters;
- behavior-retrieval query: at most the local model's exact 128-token limit, prepared with its tokenizer;
- represented primary tool calls/results: 8 per update;
- approved-habit candidates: 8, with active request habits first;
- queued update batches: 5; later arrivals coalesce only within the same response generation and causal episode;
- Advisor update timeout: 60 seconds;
- read-only Advisor tool calls: 3 per update;
- Advisor tool result: 8,000 redacted characters each and 16,000 redacted characters aggregate per update;
- generic accepted note: 1,200 characters;
- accepted emissions: 1 per update;
- persisted `advisor_finding` observation: 6,000 redacted characters;
- immune turns after interrupting delivery: 3;
- normalized session dedupe ring: 4,096 entries.

Before every prompt, the adapter estimates the retained Advisor messages plus the pending bounded update against the selected model's context window. At 75%, it aborts no primary work, resets only the private Advisor Agent, and re-primes deterministically from the current bounded request/delta/candidates—never from model-authored summaries or abandoned pre-compaction history. Estimation/maintenance failure and provider overflow remain fail-open for the primary and fail-closed for new advice.

## Advisor tools and instructions

The Advisor receives isolated read-only `read`, `grep`, and `glob` tools rooted at the canonical real path of the primary working directory. `glob` is a purpose-built bounded tool; it is not assumed to exist in Pi's read-only factory.

All three tools reject absolute, `~`, parent-traversal, symlink-escape, Experiences-state, VCS-internal, and known credential/secret paths. Results and details are redacted and secret-scanned before entering Agent state, capped per result and per update, and replaced with a static denial when safe output cannot be established. Tool state is not shared with the primary agent. The Advisor cannot mutate files, execute commands, send messages directly, create subagents, or access Experiences storage.

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
- derives a non-reversible event fingerprint from stable causal-episode/session-entry identity plus canonical redacted content;
- rejects a replay of the same durable event fingerprint while allowing a later identical action with new entry identities;
- limits one accepted finding per update;
- suppresses an equal or lower-severity duplicate in the same causal episode;
- resets transient cooldown state safely on Advisor epoch reset.

Suppression is not exposed to the Advisor model, preventing paraphrase loops.

## Severity and delivery

Delivery follows OMP's authority model without manufacturing extra primary turns:

- `nit` — held until the primary is settled, then appended visibly with no triggered turn;
- `concern` — live steering only when a material risk should affect an active, non-plan-mode run; otherwise append visibly when settled;
- `blocker` — live steering only when continuing an active, non-plan-mode run would clearly waste work or produce a broken or unsafe result; otherwise append visibly when settled.

There is no pre-execution tool blocking.

Safe-delivery rules:

- while the primary loop is active, an eligible concern or blocker may enter through Pi's documented `steer` channel;
- `followUp` is not used for noninterrupting findings because it can force another model continuation;
- a user-interrupted, canceled, terminal, plan-mode, or ambiguous run is never unexpectedly restarted;
- after `agent_settled`, `sendMessage` with no delivery mode and `triggerTurn:false` appends the custom message immediately to session context and the TUI;
- if shutdown/replacement makes model-visible delivery impossible, a same-schema visible custom entry is appended as the durable UI-only fallback and is never represented as delivered guidance;
- plan-mode detection reads the latest validated `plan-mode` custom state on the active branch; missing malformed state while that convention is present degrades to visible-only delivery;
- immune turns limit repeated live steering after a successful steer;
- unavailable delivery never becomes a fake user message or hidden `nextTurn` queue.

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
- the non-reversible causal-event fingerprint.

It does not contain Advisor reasoning, tool investigation transcripts, aliases, vectors, scores, model/provider identity, habit IDs, raw primary transcript, or reversible session identifiers.

The observation uses a deterministic identity derived from the fingerprint. Under the existing observation lock, append checks the active retained generation by indexed reverse reads with a hard scan cap; cap exhaustion fails closed for the new observation. Analyze defensively collapses Advisor observations by fingerprint, so restart/resume replay cannot create recurrence authority while a genuinely later event with different session-entry identities can.

Advisor findings do not directly create suggestions. Existing Analyze processing must:

- exclude Advisor-origin evidence from every one-shot/explicit-correction path;
- require distinct Advisor event fingerprints;
- preserve the existing repetition and day thresholds;
- distinguish Advisor-origin evidence from user-origin examples;
- avoid counting replays or repeated advice on the same causal episode;
- create review-only suggestions;
- require explicit human approval of exact `When` / `Do` wording.

Entire response generations caused by prior Advisor messages are excluded from both recursive review and learning evidence through the process-local causal marker.

## Configuration

New configuration is bounded to Advisor runtime needs:

- `advisor_enabled: boolean` — default `false`;
- `advisor_model: string` — empty means inherit `selector_model`;
- `advisor_timeout_ms: number` — default `60000`, clamped to `5000..120000`;
- `advisor_sync_backlog: "off" | 1 | 3 | 5` — advanced config, default `"off"`;
- `advisor_immune_turns: number` — default `3`, clamped to `0..10`.

The existing master `enabled` remains authoritative. The explicit Advisor-enable flow sets master and Advisor true only after auth/disclosure confirmation. Unrelated master-enabling flows clear a stale `advisor_enabled` flag; all-off clears every runtime feature flag.

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
2. inherited and explicit Advisor model resolution plus master/feature inconsistent-state safety;
3. incremental generation-stamped envelopes, cursor, bounded formatting, and no cross-generation coalescing;
4. reasoning/tool intent/tool result inclusion and redaction;
5. Advisor-caused response-generation exclusion for steer, settled append, and the next genuine user request;
6. confined read/grep/custom-glob tools, absolute/traversal/symlink/secret-path denial, result redaction, and output bounds;
7. generic compliant silence;
8. concrete nit, concern, and blocker emission;
9. content-free, duplicate, stale-buffer, and over-budget emission suppression;
10. live steering versus settled visible append, no forced nit continuation, cooldown, user-interrupt, terminal-answer, plan-mode, unsupported-client, and shutdown fallback behavior;
11. active request habit union with behavior-retrieved habits;
12. tokenizer-bounded emergent-behavior retrieval for 24,000-character, multibyte, and over-128-token deltas;
13. pending, rejected, disabled, superseded, archived, stale, and invalid habit exclusion;
14. exact alias mapping and unknown/duplicate/rewritten/original-ID rejection;
15. full `When` / `Do` proposition grounding and false-positive rejection;
16. habit violation priority over generic advice;
17. exact approved behavior correction and visible provenance;
18. changed habit/law/generation/cursor/epoch rejection before emission;
19. compaction, tree navigation, branch/session transition, cancellation, model selection, disable, and shutdown reset;
20. timeout, auth, quota, malformed output, tool failure, context maintenance, and repeated failure never stall the primary;
21. no private Advisor transcript or raw finding persistence;
22. Learning OFF creates no Advisor observations;
23. Learning ON creates one bounded event-identity-deduplicated `advisor_finding` observation;
24. Advisor observations cannot use one-shot correction paths, directly create, or approve habits;
25. distinct findings enter existing Analyze thresholds and human review;
26. existing request selector, capture, Analyze, review, duplicate, schedule, break-in, storage, and provider-guidance tests remain passing;
27. grouped setup home and every focused subpanel;
28. setup custom and fallback menu parity;
29. Advisor model inheritance/override and explicit enable disclosure;
30. all-off and independent-switch behavior;
31. narrow/wide grouped setup and Advisor/Experience card screenshots from a fresh packed install.

Run focused tests, the complete `npm run check`, `npm audit --omit=dev`, `git diff --check`, generated CLI checks, and the repository's pack/fresh-install fixture with explicit installed-package, transcript, and temporary `AX_STATE_ROOT` arguments.

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
- create npm staging artifacts or publish npm artifacts.

## Success criteria

The implementation succeeds when a separate persistent Advisor can review the main agent incrementally, investigate with isolated read-only tools, deliver OMP-like generic advice, enforce exact retrieved approved habits with stronger provenance, and contribute bounded findings to the existing human-reviewed learning pipeline.

It must preserve Experiences' approval authority, embedding retrieval, privacy, stale-state discipline, direct selector behavior, and fail-closed guarantees while making `/experience setup` materially simpler than the current flat control panel.
