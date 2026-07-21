---
name: agent-experience
description: >-
  Use when explaining, configuring, troubleshooting, or safely operating the Pi
  Experiences / Agent Experience extension: natural habit declaration and
  numbered conversational review, /experience setup, local capture, bounded
  Analyze, suggestion review, approved-habit controls, local duplicate
  prevention, short source retention, approved-habit reminders, privacy, law,
  and the distinction between skills, memory, and experience. Do not use for
  unrelated Pi extension development.
---

# Agent Experience

## What it is

- **Skill:** deliberate procedure.
- **Memory:** durable fact or knowledge.
- **Experience:** reviewed behavioral/working habit inferred from repetition.

Experience may learn durable work preferences and recurring task/tool categories. It must not convert project facts, one-off labels, credentials, or narrow task knowledge into habits.

## Normal-user rule

Use natural conversation when the user directly discusses or declares a habit:

1. clarify the behavioral pattern in ordinary language;
2. call `agent_experience_draft_habit` with exact `When:` / `Do:` wording;
3. show that exact wording and ask whether to save it;
4. call `agent_experience_confirm_habit` only after a clear affirmative answer in a later user message;
5. if the user changes wording, draft again and never confirm the replaced draft.

For suggestions or possible duplicates, call `agent_experience_list_review`, discuss its numbered plain-language items, then call `agent_experience_apply_review` only after the user explicitly names the number and decision in a later message. Never expose or request IDs, checksums, source refs, scores, thresholds, providers, raw examples, private paths, audit fields, or capability tokens.

The complete control panel/fallback remains:

```text
/experience setup
```

Setup must remain sufficient by itself. Do not require typed setup/review subcommands, IDs, checksums, thresholds, endpoints, provider settings, model-server details, or filesystem commands.

If the panel does not render, tell the user to restart Pi so the latest extension loads, then run `/experience setup` again.

## Documentation and discovery contract

The root `README.md` must always do three jobs:

1. **Explain and market the idea:** lead with the category-defining distinction—skills are procedures, memory is facts/context, Experience is human-reviewed behavioral habits. Use discoverable Pi/coding-agent language, an accessible infographic, real-life habit examples, the review-first loop, and a clear explanation of why an ever-growing `profile.md` is not a scalable habit engine.
2. **Guide humans:** keep setup, choices, privacy, provider boundaries, control, and safety clear in simple visible language. Do not bury the one-command `/experience setup` path under implementation detail.
3. **Guide agents and maintainers:** retain the detailed implementation contract inside a collapsed `<details>` block whose summary begins **For agents and maintainers**.

Never reduce the README to a dry safety specification, and never delete the technical block while simplifying normal-user documentation. A small profile file may hold stable declared identity/preferences; do not market it as equivalent to structured, selectively injected habits with evidence, approval, freshness, status, and audit.

Update all layers when behavior changes. The technical layer must retain package/runtime contracts, hard invariants, context-selection/profile trade-offs, capture/storage semantics, local embedding details, duplicate-resolution atomicity, law/selector caveats, validation, and release discipline. Package description, discovery keywords, and Pi gallery artwork must preserve the same product category. `npm run check:source` intentionally fails if the product story, either audience layer, gallery assets, or collapsed structure disappears.

## Normal workflow

### Directly declared habit

1. Discuss the pattern naturally.
2. Show the exact tool-produced `When:` / `Do:` draft.
3. Wait for a later user message.
4. On explicit yes, save the current draft. On correction, replace the draft and ask again.
5. Explain only the sanitized outcome: active, waiting on law/conflict/duplicate review, or not saved.

A direct declaration bypasses only the repeated-observation threshold. Law, conflict, local duplicate, same-user, stale-state, audit, and fail-closed gates remain. Drafting alone changes no durable state.

### Learned from repetition

1. Open `/experience setup`.
2. Turn on **Save chat examples locally**.
3. Use Pi normally until behavior repeats.
4. Select **Choose model for habit learning**.
5. Choose **Analyze all waiting examples now**, or run `/experience analyze`.
6. Open **Review suggested habits** and explicitly Approve or Reject.
7. Open **Review approved habits** to inspect, disable, re-enable, archive, or recheck a waiting approval.
8. Optionally prepare **Prevent duplicate habits**.
9. Optionally select **Choose model for habit assessment** to choose the authenticated Pi model used for reply-time applicability checks.
10. Optionally enable **Use approved habits before replies**.
11. Choose 7/14/30-day source-example retention as needed.

The panel also exposes duplicate resolution, current settings, help, explicit local schedule management, all-off, and Done.

## Hard product invariants

- Every new or materially reworded habit needs explicit human approval; conversational confirmation must occur after the exact draft in a later user turn.
- Exact normalized evidence may update support for an unchanged approved identity without rewriting it.
- Exact strong contradictory evidence may make one uniquely matched old active habit dormant; replacement remains a proposal.
- Direct user instructions and configured law override habits.
- Never auto-approve, auto-merge, auto-activate replacement wording, or modify law.
- Never install, enable, disable, repair, or remove a timer from implication or conversation alone. Schedule mutation is allowed only after the human selects the exact `/experience setup` action, reviews the rendered details, and confirms.
- One private state root represents one human.
- Semantic similarity supports review quality; it is not the product center.
- Missing/corrupt/stale state fails closed.

## Capture and Analyze

Capture stores bounded, heuristically redacted completed user/assistant pairs. Capture alone creates no habits.

Manual Analyze:

- is started explicitly from setup or `/experience analyze`;
- runs nonblocking;
- snapshots all same-user unread examples waiting when the action starts;
- processes that fixed snapshot through sequential model calls, each still bounded to at most 200 records / 80,000 bytes by default;
- leaves examples appended after the snapshot for the next run;
- rebuilds compact structured prior-habit context after every committed batch for cross-batch repetition;
- validates model output and cited ranges;
- advances its watermark atomically per successful batch, preserving earlier committed progress if a later batch fails;
- posts one final summary and creates proposals, never approvals.

Scheduled Analyze remains one bounded batch per scheduled run.

## Review and approved waiting habits

Review suggestion details in the focused panel. Do not dump internal JSON into chat.

An Analyze-generated suggestion currently needs at least three cited observations across two distinct days. A directly declared and exactly confirmed habit does not need fabricated/repeated evidence. Either path may remain inactive for current law, conflict resolution, or local duplicate checking.

- Analyze automatically rechecks approved waiting habits after a validated commit.
- **Review approved habits** offers a plain recheck action.
- Prior approval remains valid only while normalized condition, behavior, and polarity are unchanged.
- Material wording changes require approval again.

Reject archives that exact candidate identity. It does not semantically ban every related future proposal.

Archive/hide preserves audit/history while removing a habit from normal browsing and reminder use.

## Local duplicate prevention

Duplicate prevention is off until explicitly prepared from setup.

Tell users only the plain contract:

- it compares each habit's situation and action separately on this computer;
- both parts must align before a possible duplicate is shown;
- normal maintenance compares approved habits; suggestions are checked against approved habits when proposed or activated, not globally against one another;
- preparation downloads about 150 MB once;
- the managed semantic-similarity model supports 50+ languages and works across languages;
- no external app, account, key, service, or setup is required;
- it works offline after preparation;
- setup can remove the local files;
- cancellation/corruption fails closed;
- possible duplicates always require human resolution.

Do not ask users to configure a provider, model, dimensions, API key, endpoint, Python, Ollama, LM Studio, port, or server. There is no hosted fallback.

Normalized condition and behavior wording enter local inference as two independent inputs. Raw examples, source refs, evidence summaries, residual JSON, paths, checksums, audit text, credentials, and tokens do not.

The setup progress view shows plain preparation/comparison/save phases and supports Escape cancellation. Scans are bounded and atomic; a failed/cancelled scan must not claim partial durable results. An obsolete pending scoring-method relation is dismissed only by an explicit user-started scan, with audit. A candidate remains hidden until all pending relations involving it are resolved. Unchanged keep-separate decisions survive method upgrades; changed or corrupt proof returns to human review.

Use conversational numbered review or **Resolve duplicate habits** to compare both complete wordings. Each outcome must state exactly which habit remains, which is archived/hidden, and whether evidence is combined. Merge, replacement, archive, keep-separate, approval, and rejection require an explicit user decision; cancellation changes nothing. Never expose internal IDs, checksums, scores, thresholds, providers, or source refs in normal chat/UI.

## Source retention

After a source generation is fully analyzed, redacted source text rotates and is deleted after:

- 7 days by default/recommended;
- optionally 14 or 30 days.

Minimized evidence, provenance, integrity checks, and review audit remain. Redaction is heuristic, not a formal guarantee.

## Approved-habit reminders and steering provenance

Reminders are off by default. There is no daily quota: every genuinely applicable eligible message may receive approved habit guidance. Never invent or recommend an arbitrary per-day guidance cap. **Choose model for habit assessment** selects the authenticated Pi model used for the bounded applicability call; changing it must not enable or disable reminders. Enabling reminders separately prepares pinned private local vectors for eligible approved habit conditions and discloses one bounded configured-model applicability call per eligible request. Package install/update never downloads assets or enables reminders.

Every enabled attempt must embed the request locally and ephemerally, validate the cached condition vectors for the deterministic top 100 eligible habits it considers (confidence descending, then id; habits beyond the cap are excluded deterministically, not failed closed), retrieve a bounded condition-only candidate set, then obtain exact-coverage current-applicability judgments. Preparation covers that top 100 plus a law-agnostic fill up to 500. For follow-ups, extract at most four prior visible user/assistant messages from the active branch, cap each after redaction at 300 characters and the total at 1,200, and snapshot them once per response. Exclude system/developer/custom/tool/tool-result/thinking/tool-call/image-only/hidden/stale-branch content. Build a separate selector-only contextual retrieval query with current request first, newest context next, and a 120-byte UTF-8 cap; keep the full bounded context for the judge. Embed current-only and compact-context queries in one local batch. On any non-cancellation dual-batch failure, retry strict current-only embedding exactly once; cancellation never retries, current-only failure remains fail-closed, and the judge remains mandatory. Preserve current-only candidate order, deduplicate by habit ID, and append secondary-only candidates within the existing cap; never fuse scores.

Behavior text must never cause retrieval or enter the judge payload. The schema-v3 judge receives only a bounded redacted current request, bounded role-tagged context, and retrieved conditions labeled with deterministic short process-local aliases; original habit IDs, scores, confidence/staleness, unretrieved habits, sources, paths, and audit data stay excluded. Require exact complete alias coverage. Unknown, missing, duplicate, rewritten, or original-ID output fails closed; map accepted aliases exactly back to original IDs before revalidation, guidance, returned results, or selected/skipped audit handling. Current user message is the sole causal trigger. Prior user/assistant text may resolve explicit reference, confirmation, continuation, modification, or rejection, but cannot trigger a habit independently; context-only matches are non-applicable. Reject mention, quotation, negation, generic shared wording, low confidence, ambiguity, malformed/partial output, timeout, cancellation, missing auth/assets/vectors, or state drift. Reject `hypothetical_or_future` only when the current message merely discusses a possible later trigger. A request made now about a future-dated subject is current applicability when its request type matches the condition—for example, planning next summer is current planning. There is no lexical-only or vector-only injection fallback.

Never persist extracted context, process-local candidate aliases or their original-ID map, prompt/context vectors, hashes, similarities, rationale, or transient guidance. Invalid or sensitive context degrades to current-only selection. Redaction is heuristic rather than complete PII removal; strict caps minimize but do not eliminate configured-provider exposure. Schema-v3 judge output is ephemeral, so rollback requires only a code revert and no data migration.

Never show a generic “habits active” state and never steer invisibly. For every actual TUI injection, Pi must place response-specific provenance after the triggering user message and immediately before that response. Each collapsed line identifies one exact selected condition:

```text
◇ Steered by habit · When I ask for cobalt status
```

Expanded rendering shows every exact approved `When:` / `Do:` pair selected for that response. No marker means that response received no habit guidance. The marker is a durable custom Pi session entry and never enters LLM context. It may retain selected approved wording for traceability, but never raw prompts, IDs, checksums, confidence, model/provider details, source refs, raw examples, paths, or audit data.

Prepare a separate transient system-level provider instruction first, then allow it into that response only after marker append succeeds. Never inject habit guidance as user/custom conversation content or persist it in session history. Reuse it across the same tool loop without another marker or duplicate system block; never let a new user message inherit prior steering. If the interface is not the Pi TUI, marker registration/build/append fails, the provider API is unsupported, or its known payload shape is malformed, suppress habit guidance and emit only the static sanitized diagnostic. Never fall back to hidden user-role steering, `sendMessage`, or `sendUserMessage`.

Never inject from suggestions, disabled/dormant/suppressed/archived habits, evidence, quarantine, reports, or raw observations. Re-read every selected row after judgment and revalidate same user, active approval, checksum, law, confidence/freshness, and condition identity. Selector hit logs support audit/provenance, not quotas. They persist no prompt/context text, hash derivative, vector, similarities, judge confidence/reasons, session, raw error, or injected text; `prompt_hash` remains the fixed sentinel `omitted`. Selected/skipped rows may retain bounded static metadata. Failure diagnostics may retain only a closed sanitized reason plus static stage, mode, model, and retrieval mode. The separate provenance marker stores approved wording only.

## Law

Default private law path:

```text
~/.agents/experience/law.md
```

Setup may create the default law file only after explicit user choice and must never overwrite an unreadable existing file. Activation synchronously revalidates law freshness/integrity before state change.

Current law checking uses deterministic freshness plus a dangerous-pattern denylist. It is not full semantic interpretation of law text.

## All-off and scheduling

**Turn all experience features off** stops capture and runtime gates while preserving private records for audit/re-enable.

Automatic schedule defaults off. On Linux with a working systemd user manager, `/experience setup` may explicitly render and install the package-owned daily 03:30 system-local timer with `Persistent=true`. Before enabling, show the exact Node path, CLI path, host Pi runtime path, unit paths, state root, user, model, timezone, no-work/no-runtime-import/no-model-call behavior, suggestions-only rule, and sanitized open-or-next-TUI receipt behavior. Scheduled summaries use durable TUI-only transcript entries and never enter model context. Require a separate confirmation. Setup also owns explicit repair, disable, and removal. Package install/update never activates it.

Break-in review prompts are separately explicit and default off. Setup must explain and confirm ON. After Analyze creates new suggestions, wait for safe idle TUI state; offer exactly Review now, Later, or Turn break-in off once per manual action or scheduled batch. Scheduled Analyze never opens UI itself; its bounded sanitized result is detected during an open eligible TUI session or at the next eligible TUI start. Never make an extra model call, expose private metadata, or auto-approve/apply from break-in. Suppress or defer during tools, compaction, streaming, queued messages, missing scope/UI, non-TUI modes, and shutdown.

## Maintainer-only controls

Typed capture/consolidation/review/selector commands and `experience-consolidate` are compatibility/testing controls. Do not present them as the normal path.

Maintainer invariants:

- schema v6 future-version guard runs before any writeful open action;
- v5 migration remains transactional/idempotent;
- online backups contain standalone SQLite only;
- restore prevalidates and journals old-or-new recovery;
- observations use tail manifest + fixed-width index;
- locks use token/PID/hostname/time and ownership-checked release;
- conversational drafts/review snapshots are same-user/session, in-memory, bounded, 15-minute, and lost safely on restart;
- direct declarations create no row when semantic preparation is unavailable and otherwise create/block/activate in one SQLite writer transaction;
- semantic activation revalidates in one SQLite writer transaction;
- each actual TUI injection appends one `agent_experience.habit_steering` custom entry after the triggering user message; only then may transient guidance enter that response's context;
- duplicate scoring uses the lower of separate condition/behavior scores at 5,500 review / 7,000 strong basis points;
- normal scans compare active/disabled approved habits only and never candidate-to-candidate pairs;
- scan cap is 100 current habits / 4,950 pairs;
- package Node floor is `>=22.19.0`;
- Pi peers remain wildcard;
- package install has no model-download lifecycle hook;
- packed installed artifact and real isolated Pi TUI must be validated before release.

## Troubleshooting

From `/experience setup`:

- **Show current settings**: confirm capture, Analyze, duplicate prevention, retention, reminders, and waiting approvals.
- **Analyze all waiting examples now**: process the fixed queue waiting at action start through sequential bounded batches; later arrivals wait for the next run. If Analyze reports a partial stop, fix the reported cause and run it again; verified committed batches are not repeated.
- **Review suggested habits**: inspect unapproved proposals.
- **Resolve duplicate habits**: handle potential duplicate wording.
- **Review approved habits**: browse active/disabled habits or recheck waiting approvals.
- **Prevent duplicate habits**: retry preparation, turn off while keeping files, or remove files.
- **Automatic schedule**: explain/status; explicitly install/enable, repair/rewrite, disable, or remove the local systemd user units. Scheduled Analyze creates suggestions only and never auto-approves.
- **Break-in review prompts**: explain and explicitly toggle private review-only prompts. Review now only opens Review; Later leaves suggestions waiting; Turn break-in off persists OFF.

If corruption or a future schema is reported, do not bypass it. Preserve state and use a compatible/newer package or validated restore path.
