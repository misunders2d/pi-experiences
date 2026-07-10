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
6. selector behavior;
7. selector adapters and legacy CLI behavior;
8. nonblocking setup Analyze;
9. semantic duplicate routing;
10. future-schema and online backup/journaled restore hardening;
11. bounded observation tail/index/Analyze/rotation/retention;
12. managed local embedding unit checks;
13. two-connection semantic activation and atomic scan adversarial checks;
14. token-lock stale/dead/malformed/ownership recovery;
15. source/import bundling and generated CLI drift.

The suite must leave timers off and perform no hosted embedding request or model download.

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
- English, Russian, Spanish, German, French, Chinese, and cross-language duplicate/non-duplicate calibration;
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
npm pack --json --pack-destination /tmp/pi-experiences-028-pack
```

The tarball must include:

- `package.json` version `0.1.28` and Node floor `>=22.19.0`;
- wildcard Pi peer dependencies;
- extension source and public skill;
- current executable `dist/experience-consolidate.mjs`;
- `runtime/agent-experience/local-embedding-worker.mjs`;
- the two pinned vendored runtime glue modules;
- source/validation scripts used by package checks;
- no model weights/WASM asset, private state, credentials, install hook, or source-map leakage.

Fresh installation must use the exact generated tarball and disable lifecycle scripts:

```bash
npm install --ignore-scripts /tmp/pi-experiences-028-pack/pi-experiences-0.1.28.tgz
```

Use a dedicated disposable `/tmp/*smoke*` prefix. Verify package version, CLI help/status, extension import, skill loading, package-relative worker resolution, and file allowlist from that installed copy—not the source checkout.

## Real Pi skill/frontmatter loader

Run Pi's actual skill loader against the installed package and require zero diagnostics. A YAML parser alone is insufficient.

## Isolated installed-package TUI

Use the packed/fresh-installed package with:

```bash
AX_STATE_ROOT=/tmp/pi-experiences-028-tui-smoke-state
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
- schedule Phase 2/off;
- current settings;
- help;
- all-off/Done.

Verify the visible UI contains no habit IDs, checksums, duplicate thresholds, local-model identifiers, provider endpoints, API-key instructions, or required advanced subcommands.

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
- live/expired/dead/empty/malformed/foreign/mismatch lock behavior;
- bounded append and disjoint Analyze watermarks;
- cross-batch learning from compact structured context;
- 7/14/30-day journaled rotation/retention;
- exact embedding payload privacy probes;
- full disabled/all-off/no-timer/no-law-write regressions.

## Release gate

Before tag/push:

```bash
npm run check
npm audit --omit=dev
git diff --check
git status --short
```

Then obtain independent DeepSeek, GLM, and constitution review of the actual diff plus test evidence. Reviewer verdicts do not replace test evidence.

After final commit/tag push, verify local `HEAD`, `origin/main`, and `refs/tags/v0.1.28` resolve to the same commit and `v0.1.25`, `v0.1.26`, and `v0.1.27` remain unchanged. npm publication is a separate manual action and is outside this release scope.
