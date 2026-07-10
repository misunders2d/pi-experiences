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
5. Choose **Analyze saved examples now**.
6. Open **Review suggested habits** and explicitly Approve or Reject.
7. Open **Review approved habits** to inspect, disable, re-enable, archive, or recheck a waiting approval.
8. Optionally prepare **Prevent duplicate habits**.
9. Optionally enable **Use approved habits before replies**.
10. Choose 7/14/30-day source-example retention as needed.

The panel also exposes duplicate resolution, current settings, help, schedule Phase 2/off, all-off, and Done.

## Hard product invariants

- Every new or materially reworded habit needs explicit human approval; conversational confirmation must occur after the exact draft in a later user turn.
- Exact normalized evidence may update support for an unchanged approved identity without rewriting it.
- Exact strong contradictory evidence may make one uniquely matched old active habit dormant; replacement remains a proposal.
- Direct user instructions and configured law override habits.
- Never auto-approve, auto-merge, auto-activate replacement wording, or modify law.
- Never install or enable timers in this release.
- One private state root represents one human.
- Semantic similarity supports review quality; it is not the product center.
- Missing/corrupt/stale state fails closed.

## Capture and Analyze

Capture stores bounded, heuristically redacted completed user/assistant pairs. Capture alone creates no habits.

Analyze:

- is manually started from setup;
- runs nonblocking;
- reads only the next bounded contiguous same-user unread range;
- defaults to at most 200 records / 80,000 bytes;
- uses compact structured prior-habit context for cross-batch repetition;
- validates model output and cited ranges;
- advances its watermark only in a successful commit;
- creates proposals, never approvals.

If saved examples exist but no suggestions appear, choose **Analyze saved examples now** again. More unread bounded batches may remain.

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

Reminders are off by default. Default instant mode uses local lexical/no-network matching. Only active same-user approved habits can be selected.

Never steer invisibly. For every actual TUI injection, Pi must place a muted collapsed marker immediately before the answer:

```text
◇ Habit steering · N approved habit(s)
```

Expanded rendering shows the exact approved `When:` / `Do:` wording selected. No marker means no habit guidance was injected. The marker is a durable custom Pi session entry and never enters LLM context. It may retain selected approved wording for traceability, but never raw prompts, IDs, checksums, confidence, model/provider details, source refs, raw examples, paths, or audit data.

If the interface is not the Pi TUI, or marker registration/build/append fails, suppress habit injection and emit only the static sanitized diagnostic. Never fall back to hidden steering or `sendMessage`.

Never inject from suggestions, disabled/dormant/suppressed/archived habits, evidence, quarantine, reports, or raw observations. Selector hit logs do not persist raw prompt/session/injected text; `prompt_hash` remains `omitted`; the separate provenance marker stores approved wording only.

Optional advanced matching is separately controlled and must fail closed.

## Law

Default private law path:

```text
~/.agents/experience/law.md
```

Setup may create the default law file only after explicit user choice and must never overwrite an unreadable existing file. Activation synchronously revalidates law freshness/integrity before state change.

Current law checking uses deterministic freshness plus a dangerous-pattern denylist. It is not full semantic interpretation of law text.

## All-off and scheduling

**Turn all experience features off** stops capture and runtime gates while preserving private records for audit/re-enable.

Automatic schedule remains Phase 2/off. Unit files are disabled maintainer templates; do not install or enable them as normal UX.

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
- each actual TUI injection appends one `agent_experience.habit_steering` custom entry before prompt modification; non-TUI/unrenderable/unappendable provenance suppresses injection;
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
- **Analyze saved examples now**: process the next unread batch.
- **Review suggested habits**: inspect unapproved proposals.
- **Resolve duplicate habits**: handle potential duplicate wording.
- **Review approved habits**: browse active/disabled habits or recheck waiting approvals.
- **Prevent duplicate habits**: retry preparation, turn off while keeping files, or remove files.
- **Automatic schedule**: verify Phase 2/off.

If corruption or a future schema is reported, do not bypass it. Preserve state and use a compatible/newer package or validated restore path.
