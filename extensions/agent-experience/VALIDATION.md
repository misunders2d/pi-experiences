# Agent Experience validation

Run from the package root on Node.js `>=22.19.0`.

## Complete source suite

```bash
npm run check
npm audit --omit=dev
```

`npm run check` includes:

1. setup/default/privacy behavior;
2. SQLite storage and migrations;
3. capture/redaction;
4. consolidation/proposal validation;
5. explicit review/CAS/law gates;
6. selector behavior plus muted per-answer steering provenance, privacy, ordering, and fail-closed visibility;
7. selector adapters and legacy CLI behavior;
8. nonblocking setup Analyze;
9. separate-field semantic duplicate routing, method reconciliation, and candidate restoration;
10. future-schema and online backup/journaled restore hardening;
11. bounded observation tail/index/Analyze/rotation/retention;
12. managed local embedding unit checks;
13. two-connection semantic activation and atomic scan adversarial checks;
14. token-lock stale/dead/malformed/ownership recovery;
15. conversational draft/confirm, direct declaration, numbered review, privacy, stale-state, and no-orphan semantic failure;
16. source/import bundling and generated CLI drift;
17. scheduled Analyze no-work/model-call gating, outer/inner lock discipline, sanitized bounded receipts, durable TUI-only transcript delivery across startup/reload, idempotent retained/unreadable receipt handling, stale-session and renderer/append failure retention, fixed local systemd rendering, injected systemctl lifecycle, and config-state preservation.

The suite must perform no real systemd mutation, hosted embedding request, model download, or live scheduled model call. Phase 17 uses fake systemctl/model adapters and temporary unit/state roots.

## Real pinned local-model integration

The normal suite deliberately does not redownload about 150 MB. To exercise the exact pinned assets from an already downloaded fixture:

```bash
AX_LOCAL_MODEL_FIXTURE_DIR=/path/to/pinned/model-directory \
AX_LOCAL_ORT_WASM=/path/to/ort-wasm-simd-threaded.wasm \
node --experimental-strip-types ./scripts/test-agent-experience-phase13-local-embedding.mjs
```

The model fixture directory must contain:

```text
config.json
tokenizer.json
tokenizer_config.json
onnx/model_int8.onnx
```

This integration test verifies:

- exact size/SHA-256 manifest;
- 0700/0600 cache permissions;
- streamed install and idempotent cache reuse;
- network-blocked offline inference;
- 384-dimensional normalized output;
- separate condition/behavior field scoring with a 5,500-bp minimum-field review threshold;
- eight-of-nine precision-first English/Russian/Spanish/German/French/Chinese and cross-language paraphrase routing, including one documented conservative false negative;
- same-topic/different-action and same-action/different-situation rejection;
- 128-token rejection;
- worker idle unload;
- corruption rejection;
- cancellation cleanup;
- managed removal.

Run the same test with an actual Node 22.19+ binary before release, not only a newer development Node.

## Packed artifact

Build and inspect the exact tarball:

```bash
npm pack --dry-run
npm pack --json --pack-destination /tmp/pi-experiences-046-pack
```

The tarball must include:

- `package.json` version `0.1.46` and Node floor `>=22.19.0`;
- `CHANGELOG.md` with a verified entry for the release;
- wildcard Pi peer dependencies;
- extension source, `steering-note.ts`, and public skill;
- current executable `dist/experience-consolidate.mjs`;
- `runtime/agent-experience/local-embedding-worker.mjs`;
- the two pinned vendored runtime glue modules;
- source/validation scripts used by package checks;
- no model weights/WASM asset, private state, credentials, install hook, or source-map leakage.

Fresh installation must use the exact generated tarball and disable lifecycle scripts:

```bash
npm install --ignore-scripts --legacy-peer-deps /tmp/pi-experiences-046-pack/pi-experiences-0.1.46.tgz
```

Use a dedicated disposable `/tmp/*smoke*` prefix. Verify package version, CLI help/status, extension import, skill loading, package-relative worker resolution, and file allowlist from that installed copy—not the source checkout.

## Real Pi skill/frontmatter loader

Run Pi's actual skill loader against the installed package and require zero diagnostics. A YAML parser alone is insufficient.

## Isolated installed-package TUI

Use the packed/fresh-installed package with:

```bash
AX_STATE_ROOT=/tmp/pi-experiences-046-tui-smoke-state
```

Launch the real Pi TUI in a disposable Pi config/package root that references the installed tarball copy, not this repository. Exercise every major `/experience setup` section:

- save examples;
- model picker/back;
- Analyze prerequisite/fail-closed state;
- suggestion review empty state;
- duplicate resolution empty state;
- approved habits and waiting recheck empty state;
- duplicate-prevention explanation and cancel-safe progress surface;
- source-retention 7/14/30 choices;
- approved-habit reminder explanation;
- schedule explanation plus explicit install/enable, repair, disable, and remove flows;
- current settings;
- help;
- all-off/Done.

Also exercise the conversational tools in a fresh session: exact draft display, same-turn confirmation rejection, later-turn save, corrected-draft replacement, numbered suggestion/duplicate listing, explicit decision application, stale-list refresh, and idempotent retry.

Seed one specific approved habit plus weaker generic and behavior-only decoys, enable reminders, and submit a matching prompt. Verify the user prompt renders first, then a muted `◇ Steered by habit · <exact selected condition>` entry, then response work/answer. The collapsed marker must identify each selected condition rather than show a generic count; expansion shows every exact approved `When:` / `Do:` pair. Weaker-overlap and behavior-only decoys must not appear. An unrelated prompt shows no marker. Repeated eligible messages on the same day must continue receiving guidance with no quota. Verify tool-loop calls retain guidance without duplicate markers, a new user message cannot inherit it, and non-TUI/renderer/malformed/append failures suppress guidance.

Verify all visible UI/tool results contain no habit IDs, checksums, duplicate thresholds, local-model identifiers, provider endpoints, source refs, private paths, API-key instructions, audit fields, or required advanced subcommands.

For any user-visible report/HTML surface, capture real screenshots for each major navigation section before completion. For this terminal-only package, preserve PTY transcript/screenshot evidence of the installed TUI smoke.

## Adversarial acceptance matrix

Release evidence must include:

- future `user_version=999` unchanged after rejected open/init;
- populated transactional/idempotent v5→v6 migration;
- hot-writer online backup, logical restore, and `PRAGMA integrity_check`;
- symlink/traversal/tamper/unknown-artifact rejection;
- injected restore interruption resulting in complete old or restored state;
- concurrent approval, re-enable, and promotion barriers;
- approved waiting visibility and unchanged-identity promotion;
- semantic scan batch/cancel/progress/snapshot/write-failure rollback;
- approved-only default scans and zero candidate-to-candidate proposal/same-batch/scan routing;
- obsolete pending method cleanup with precise audit reason;
- restore-after-last behavior for candidates with multiple pending relations, including approved-waiting identity;
- new wording-hash and validated legacy-cache keep-separate continuity, plus changed/corrupt fail-closed cases;
- live/expired/dead/empty/malformed/foreign/mismatch lock behavior;
- bounded append and disjoint Analyze watermarks;
- generation-aware Analyze schemas after source rotation, while wrong-generation source refs still fail closed;
- cross-batch learning from compact structured context;
- 7/14/30-day journaled rotation/retention;
- exact embedding payload privacy probes;
- full disabled/all-off/no-implicit-timer/no-law-write regressions;
- direct declaration creates no row before later-turn confirmation, bypasses repetition only, and rechecks law/conflict/semantic gates;
- semantic-unavailable declaration creates no candidate/relation; clean activation and duplicate-block routing are atomic;
- conversational review exposes numbered sanitized wording only, revalidates hidden snapshots, and rejects stale or same-turn mutation;
- retry/correction/expiry/session-isolation behavior creates no duplicate or replaced-draft habit;
- `before_agent_start` returns synchronously without embedding/model work; the packed TUI smoke requires the submitted message to re-render within 1.5 seconds, then verifies order: triggering user message → one post-render assessment → one `agent_experience.habit_steering` entry → assistant response;
- collapsed rendering identifies every exact selected condition; expanded/malformed rendering stays safe; no-selection emits no marker;
- every enabled selection embeds the request locally and ephemerally, validates all eligible condition-vector cache rows, and uses no lexical-only or vector-only fallback;
- the strict schema-v3 judge receives only a bounded redacted current request, at most four role-tagged prior visible user/assistant messages, and retrieved conditions labeled with deterministic short process-local aliases; it covers every alias exactly, rejects schema-v2, unknown/missing/duplicate/rewritten/original-ID output, context-only applicability, mention/quotation/negation/generic wording and possible later triggers, maps accepted aliases back before all downstream use, and treats a present request about a future-dated subject (for example planning next summer) as current applicability;
- current message remains the sole trigger: assistant/user context may resolve an explicit follow-up such as “yes, do that” or “make it two weeks,” while assistant-only relevance, unrelated topic changes, negation, low confidence, ambiguity, malformed/partial output, timeout, cancellation, missing auth, and state drift fail closed;
- context extraction excludes system/developer/custom/tool/tool-result/thinking/tool-call/image-only/hidden entries, applies 4-message/300-character/1,200-total redacted caps, snapshots once per response, and degrades invalid context to the current-only path;
- contextual retrieval is current-first/newest-context-first and Unicode-safe within 120 UTF-8 bytes while the judge keeps the full bounded context; current-only and compact-context vectors normally use one local embedding batch, primary order wins, duplicate IDs retain the primary result, and secondary-only candidates append within the unchanged cap; empty context preserves current-only behavior;
- confirmed lexical false positives stay silent, while status/code/release/decision, multilingual, and contextual true positives pass vector retrieval plus judgment;
- missing/corrupt vectors fail before the judge, setup repairs complete condition caches, and post-activation maintenance failure never rolls back approved habit state;
- any non-cancellation compact-context batch failure retries current-only embedding exactly once; cancellation never retries, current-only failure remains fail-closed, and the mandatory judge runs exactly once after successful fallback;
- long internal habit IDs never enter runtime judge prompts or adapter candidate lists; aliases and their exact map remain ephemeral, while returned selections, post-judge revalidation, steering provenance, and selected/skipped logs use restored original IDs; latency probes use the same alias protocol;
- selector guidance has no daily quota; repeated eligible messages continue receiving guidance, while hit logs remain audit/provenance only and persist no prompt/context text, derivative, vector, similarity, raw error, or judge rationale/confidence; sanitized failure rows contain only closed reason/stage/mode/model/retrieval-mode values;
- durable provenance stores approved wording/count/time only and never enters LLM context; separate transient guidance enters only the marked response;
- tool-loop context receives the same snapshotted context/result/guidance without duplicate extraction, embedding, assessment, or markers; no-selection and provenance-failure tombstones also prevent retries, and a new user message cannot inherit old steering;
- non-TUI, renderer/build/append failure produces no habit guidance and only a static sanitized diagnostic.

## Release gate

Before version bump or tag/push, update `CHANGELOG.md` first with verified user-facing changes. Keep work under **Unreleased** until release preparation, then move it under the exact release version/date. Do not reconstruct or guess unsupported historical entries.

Before tag/push:

```bash
npm run check
npm audit --omit=dev
git diff --check
git status --short
```

Then obtain independent DeepSeek, an available model-diverse reviewer, and constitution review of the actual diff plus test evidence. Skip a reviewer that stalls or reports exhausted usage rather than blocking release evidence. Reviewer verdicts do not replace test evidence.

After final commit and an explicitly approved tag push, verify local `HEAD`, `origin/main`, and the new immutable release tag resolve to the same commit while all historical tags remain unchanged. npm publication is a separate manual action and is outside this release scope.
