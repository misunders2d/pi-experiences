# Approved-Habit Runtime Advisor Implementation Plan

Status: corrected execution plan. It supersedes the earlier hybrid-policy plan while retaining the same historical filename.

## Outcome

Add an opt-in Runtime Advisor that reviews new assistant/tool behavior exclusively against exact approved Experience habits. Experiences remains the learning, approval, storage, and setup control plane; the separate Advisor model is an ephemeral enforcement plane.

## Completed implementation tracks

### Configuration and setup

- Advisor defaults off.
- Configuration supports model, timeout, backlog, and immunity settings.
- `/experience setup` owns normal-user Advisor controls and explains model inheritance.
- Installation does not enable Advisor, capture, schedules, or downloads.

### Private reviewer plane

- Separate Advisor agent/model adapter.
- Fresh private model context for each update; reset before reuse and after review.
- Confined bounded `read`, `grep`, and `glob` tools only.
- Structural and text redaction before any investigation result reaches the private model.
- No transcript or raw model-output persistence.

### Habit authority

- Current direct-steering habit IDs are included first.
- Optional read-only vector expansion uses prepared cache only.
- Runtime retrieval never creates or updates embedding rows.
- Up to eight deterministic process-local aliases.
- Model receives aliases and exact approved condition/behavior, never durable IDs/checksums/scores.
- One structured emission: exact supplied-habit violation with `concern` or `blocker`.
- Runtime guard rejects every malformed, extra-field, unsupported, duplicate, or non-habit attempt.
- Delivery revalidates config, law, identity, checksum, confidence, freshness, alias, generation, cursor, and epoch.

### Causality and lifecycle

- User-message direct steering and assistant/tool-event review are separate.
- Current event fingerprint dedupes replay without global habit cooldown.
- Coalescing merges review text and persistence-safe evidence from one causal batch, then recomputes fingerprint.
- Navigation, compaction, model changes, setup changes, cancellation, settlement, and shutdown revoke stale work.
- No tool-call veto, forced continuation, fake user message, `followUp`, or `nextTurn`.

### Visible delivery and learning

- Exact approved `When:` / `Do:` card is visible before transient correction.
- Model-visible correction states direct current user instruction and law precedence.
- Plan/ambiguous/canceled/terminal states defer or use visible-only fallback.
- Learning stores only bounded visible assistant behavior/static activity, exact approved behavior, severity, fingerprint, and timestamp.
- User prompts, review deltas, primary tool results, aliases, scores, and private reviewer context never persist.
- Analyze remains local, bounded, review-only, and cannot activate habits.

## Remaining execution order

1. Remove obsolete alternate-policy fixtures and docs; retain explicit negative malformed-input tests only.
2. Run focused phases 2 and 23–25 plus source and diff checks.
3. Run full `npm run check`, audit, and isolated packed verification.
4. Inspect generated CLI and full worktree diff.
5. Run independent code, security, and skill-architecture reviews on the exact stabilized candidate.
6. Resolve every BLOCK/REVISE and repeat only affected gates.
7. Run one Constitution review on the stabilized candidate.
8. Commit the feature branch and merge non-destructively into `main`.
9. Choose the next patch version, update package/lock/changelog/gallery reference/verifier expectations, rebuild generated CLI, and rerun release-critical validation.
10. Create immutable annotated tag and atomically push `main` plus tag.
11. Verify exact GitHub OIDC staging workflow and npm-ready shasum/integrity.
12. Stop for Sergey’s npm publication. After registry verification, update with `pi update --extensions`; reload only with approval.

## Commands and success criteria

```bash
node --experimental-strip-types scripts/test-agent-experience-phase2-storage.mjs
node --experimental-strip-types scripts/test-agent-experience-phase23-advisor-core.mjs
node --experimental-strip-types scripts/test-agent-experience-phase24-advisor-habits-learning.mjs
node --experimental-strip-types scripts/test-agent-experience-phase25-grouped-setup.mjs
node --experimental-strip-types scripts/check-agent-experience-source.mjs
git diff --check
npm run check
npm audit --omit=dev
node scripts/verify-isolated-package.mjs
```

Success means all checks pass; packed PTY shows only approved-habit concern/blocker cards at wide/narrow and collapsed/expanded states; repository/live-state manifests remain unchanged; no temporary root remains; independent reviews and Constitution pass; release metadata is reproducible and clean.

## Non-goals

- autonomous habit approval or activation;
- generic reviewer policy;
- pre-tool blocking;
- hidden durable correction messages;
- Hub consumer mode;
- Hindsight expansion;
- non-Pi adapters;
- npm publication by this agent.
