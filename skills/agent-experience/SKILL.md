---
name: agent-experience
description: >-
  Use when explaining, configuring, troubleshooting, or safely operating the Pi
  Experiences / Agent Experience extension: /experience setup, local capture,
  bounded Analyze, suggestion review, approved-habit controls, local duplicate
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

Always start with:

```text
/experience setup
```

This is the complete normal-user surface. Do not require typed setup/review subcommands, IDs, checksums, thresholds, endpoints, provider settings, model-server details, or filesystem commands.

If the panel does not render, tell the user to restart Pi so the latest extension loads, then run `/experience setup` again.

## Normal workflow

1. Open `/experience setup`.
2. Turn on **Save chat examples locally**.
3. Use Pi normally until behavior repeats.
4. Choose **Choose model for habit learning**.
5. Choose **Analyze saved examples now**.
6. Open **Review suggested habits** and explicitly Approve or Reject.
7. Open **Review approved habits** to inspect, disable, re-enable, archive, or recheck a waiting approval.
8. Optionally prepare **Prevent duplicate habits**.
9. Optionally enable **Use approved habits before replies**.
10. Choose 7/14/30-day source-example retention as needed.

The panel also exposes duplicate resolution, current settings, help, schedule Phase 2/off, all-off, and Done.

## Hard product invariants

- Every new or materially reworded habit needs explicit human approval.
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

A suggestion currently needs at least three cited observations across two distinct days. Approval may remain visibly waiting for more evidence, current law, conflict resolution, or local duplicate checking.

- Analyze automatically rechecks approved waiting habits after a validated commit.
- **Review approved habits** offers a plain recheck action.
- Prior approval remains valid only while normalized condition, behavior, and polarity are unchanged.
- Material wording changes require approval again.

Reject archives that exact candidate identity. It does not semantically ban every related future proposal.

Archive/hide preserves audit/history while removing a habit from normal browsing and reminder use.

## Local duplicate prevention

Duplicate prevention is off until explicitly prepared from setup.

Tell users only the plain contract:

- it compares habit wording on this computer;
- preparation downloads about 149 MB once (under the 300 MB cap);
- no external app, account, key, service, or setup is required;
- it works offline after preparation;
- setup can remove the local files;
- cancellation/corruption fails closed;
- possible duplicates always require human resolution.

Do not ask users to configure a provider, model, dimensions, API key, endpoint, Python, Ollama, LM Studio, port, or server. There is no hosted fallback.

Only normalized `condition + "\n" + behavior` enters local inference. Raw examples, source refs, evidence summaries, residual JSON, paths, checksums, audit text, credentials, and tokens do not.

The setup progress view shows plain preparation/comparison/save phases and supports Escape cancellation. Scans are bounded and atomic; a failed/cancelled scan must not claim partial durable results.

Use **Resolve duplicate habits** for explicit merge evidence, supersede, keep separate, or archive/hide decisions. Never expose internal scores or thresholds in normal UI.

## Source retention

After a source generation is fully analyzed, redacted source text rotates and is deleted after:

- 7 days by default/recommended;
- optionally 14 or 30 days.

Minimized evidence, provenance, integrity checks, and review audit remain. Redaction is heuristic, not a formal guarantee.

## Approved-habit reminders

Reminders are off by default. Default instant mode uses local lexical/no-network matching. Only active same-user approved habits can be selected.

Never inject from suggestions, disabled/dormant/suppressed/archived habits, evidence, quarantine, reports, or raw observations. Selector logs do not persist raw prompt/session/injected text; `prompt_hash` remains `omitted`.

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
- semantic activation revalidates in one SQLite writer transaction;
- scan cap is 100 habits / 4,950 pairs;
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
