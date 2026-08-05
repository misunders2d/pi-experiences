# Task 8 report — package gates, documentation, and isolated Advisor TUI smoke

## Result

Task 8 implements package/source assertions, a staged and fresh isolated installation, grouped setup and Advisor PTY coverage, grouped-first documentation, the maintained `agent-experience` skill update, and an Unreleased changelog entry. It does not change a live skill, live Experience state, global install, version, tag, release, push, publish, timer, plan, or specification.

Required commit message: `docs: document hybrid advisor experience`. The exact commit object ID is returned after this report is included in that commit; this file does not pre-claim its own commit hash.

## TDD evidence

1. Task 8 package/source assertions were added before implementation.
2. The requested RED was observed with exit 1: `AssertionError: complete checks must include Advisor habits and learning validation`; the actual package command ended at phase 23 and the expected phase-24 check was absent.
3. Reviewer hardening assertions were then added before their fixes. The second RED exited 1 with `AssertionError: isolated verifier hardening missing: stagePackageSource`.
4. The cleanup swap regression test then failed RED with exit 1 and `AssertionError: Missing expected rejection`: after validation, the old path-based recursive `rm` followed a replacement at the temporary-root pathname instead of remaining anchored to the originally created directory identity.
5. GREEN is the exact final self-test, source gate, and complete isolated verifier recorded below.

### RED/adversarial failure-path manifests (not final PASS evidence)

During hardening, deliberately incomplete grouped-smoke runs failed with `failureStage: "grouped setup TUI smoke"`. Their failure JSON manifests contained the partial grouped screen artifacts plus `grouped-setup-transcript.bin`, with byte counts and SHA-256 digests, and recorded the repository and live Experience-state recursive manifests as unchanged before `finally` removed the temporary root. These ephemeral failure-run digests are not mixed into the final PASS artifact table below. The source-assertion RED and isolation self-test refusals above are likewise adversarial evidence, not PASS claims for the end-to-end acceptance command.


## Verification evidence

| Command | Result |
| --- | --- |
| `node --experimental-strip-types scripts/check-agent-experience-source.mjs` | PASS, 1.06 s: `agent-experience source/import/package checks passed` |
| `node scripts/verify-isolated-package.mjs --self-test` | PASS, 0.14 s: repository descendant/symlink-parent cases were refused; a deterministic post-validation root swap was rejected by the anchored cleanup helper while preserving both the replacement sentinel and the moved original payload |
| `node scripts/verify-isolated-package.mjs` | PASS, 70.83 s: self-tests, staged source install, source gate, pack, fresh tarball install, packed/runtime check, actual installed skill loader, grouped setup PTY, Advisor PTY, recursive repository/live-state identity, artifact manifest, fd-anchored cleanup, and cleanup |
| Actual Pi skill/frontmatter loader | PASS in the isolated dependency tree; `skill_diagnostics: []`, loaded skill `agent-experience` |

The final run created `/tmp/pi-experiences-isolated-jyXDjw`, installed 139 source-stage packages and 131 tarball-consumer packages, verified 120 packed files, resolved `@earendil-works/pi-agent-core 0.83.0` and `@earendil-works/pi-coding-agent 0.83.0`, and reported `19,284,381` managed installed bytes. It used an empty isolated Pi agent directory, isolated session directory, isolated HOME/XDG roots, offline/no-default-resource launch flags, and child-only `AX_STATE_ROOT=/tmp/pi-experiences-isolated-jyXDjw/state`.

The success manifest reported repository SHA-256 `464f39e1bbff9ea43d840aa63df042440a0f1a4d68b6ea3e97b1824ee664d28d` unchanged and live Experience state SHA-256 `8b55420c908d97e5a3819bf5c473c663ee361db661e9f18d08c5ca831337e80d` unchanged. It printed the manifest before removing the one temporary root through its retained directory handles.

### Isolation/security hardening closed

- **ISO-001:** `npm pack` runs only from a staged source tree. The recursive repository manifest is measured before staging and compared after all success/failure handling, so the repository prepack build cannot mutate the worktree.
- **ISO-002:** repository, npm-cache, global-prefix, and live-state forbidden roots are canonicalized. Existing destinations and symlink-parent escapes are rejected. Cleanup retains `O_DIRECTORY|O_NOFOLLOW` handles and creation identities for the original parent/root; a minimal helper validates them with `fstat` and performs `dir_fd`-relative non-following traversal/removal. A swapped parent/root pathname is never recursively followed, and an identity mismatch fails closed without touching its replacement. The deterministic cleanup self-test swaps the root after JS validation, requires rejection, and proves the outside replacement sentinel and moved original payload remain intact.
- **ISO-003:** both real Pi PTYs use explicit isolated agent/session directories, isolated HOME/XDG/state/temp/cache variables, offline/no defaults/context/templates/themes/approval flags, and an environment allowlist. Global config, credentials, sessions, and extensions are not inherited.
- **ISO-004:** the live-state and repository checks are recursive deterministic manifests of entry kind, relative path, mode, content or symlink target. Both are compared on success and failure.
- **PACK-005:** the packed verifier rejects private Advisor transcript/raw-output filename families. The tarball uses only its installed `pi-coding-agent` skill loader; `PI_SKILL_LOADER` is neither trusted nor forwarded.
- **GATE-006:** source assertions bind the staged-pack/repository-manifest markers, canonical symlink/cleanup checks, isolated agent/session launch flags, recursive manifests, packed privacy filter, installed loader, `finally` artifact manifest, and Advisor raw-byte persistence.
- **ART-007:** both PTY scripts persist raw bytes in `finally`; the verifier emits a success/failure JSON artifact manifest containing path, byte count, and SHA-256 before unconditional cleanup. Multiple intentionally encountered grouped-smoke failures emitted hashed partial transcripts/screens and still reported both protected manifests unchanged before cleanup.

## Isolated artifact evidence

The final verifier printed these paths, sizes, and digests before cleanup. Paths no longer exist because cleanup is part of the gate.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `artifacts/advisor-transcript-artifacts/wide-collapsed.txt` | 2,352 | `ab19dba1355affa8634dd52ec5374d8c23892b1ea269649b2bb58c9f805df794` |
| `artifacts/advisor-transcript-artifacts/wide-expanded.txt` | 2,558 | `d62a61723b48538b2bd3af2d920840dfa811cc71c0f0835e86170ddd1a5cd042` |
| `artifacts/advisor-transcript-artifacts/narrow-collapsed.txt` | 1,742 | `8f09e67c3a3d126619bab88bc4a35cf5a7f39f9e360e1467f2c55d162c452b58` |
| `artifacts/advisor-transcript-artifacts/narrow-expanded.txt` | 1,768 | `b10193110d863408da33894b382a9d54c7251864912f3424eece231bb950b687` |
| `artifacts/advisor-transcript-artifacts/wide-raw-transcript.bin` | 24,333 | `917bbc0595475a41a256079891b505a2a243bdd8b9f723ba9501f8ba054ea846` |
| `artifacts/advisor-transcript-artifacts/narrow-raw-transcript.bin` | 20,542 | `547a9be673ac669bca12b92a482b0ae94deb9af24adc12efefab7d1943091e4f` |
| `artifacts/advisor-transcript.bin` | 44,905 | `67fab6569e1647f68ae7e1018303070ebbfde3904a68ea1b34ee63662492ee8e` |
| `artifacts/grouped-setup-transcript-artifacts/home-wide.txt` | 1,500 | `a76d4620e036578c9ea2924ad3ad629e8a32b3387973d9b5c6e41de37af8a8ca` |
| `artifacts/grouped-setup-transcript-artifacts/home-narrow.txt` | 1,555 | `4f97d735a50bc44f0505c3699f3c4fd6f5bfa46a156812fa68df945bc58453b3` |
| `artifacts/grouped-setup-transcript-artifacts/all-off.txt` | 2,159 | `c2d36d25cee43ec918d7fc2ad6ce9e242278173bc9b2a9234744f745fa915d17` |
| `artifacts/grouped-setup-transcript.bin` | 271,929 | `d7d937a97b2e5eb03e02b4970c698132291fd883fe2a4abae8451a41a5b77235` |

The Advisor fixture used only `pi.sendMessage(buildAdvisorCustomMessage(...), { triggerTurn:false })`. Every command incremented generation/cursor once and emitted one card. PTY assertions proved collapsed/expanded generic nit, concern, and blocker cards; collapsed/expanded habit violation with exact `When:` / `Do:` / next-step authority; wide/narrow wrapping; non-authoritative generic framing versus approved-habit authority; one-card increments; and no fixture IDs, alias, scores, checksums, transcript excerpts, private paths, raw model output, or internal provenance in visible screens/transcripts.

The grouped smoke started from the grouped home, covered wide/narrow order, all five groups, empty-agent authenticated-model controls failing closed, Advisor visibly OFF with explicit inheritance, Analyze/review/duplicate safety paths, retention/schedule/review-prompt/semantic explanations, truthful status, and all-off. It asserted screens rather than assuming a live authenticated model.

## Exact Task 8 files

Modified:

- `package.json`
- `scripts/check-agent-experience-source.mjs`
- `scripts/verify-packed-install.mjs`
- `scripts/test-installed-tui-smoke.py`
- `README.md`
- `extensions/agent-experience/README.md`
- `extensions/agent-experience/VALIDATION.md`
- `skills/agent-experience/SKILL.md`
- `CHANGELOG.md`

Created:

- `scripts/fixtures/advisor-tui-driver.ts`
- `scripts/test-advisor-tui-smoke.py`
- `scripts/verify-isolated-package.mjs`
- `.superpowers/sdd/2026-08-04-hybrid-advisor-experiences/task-8-report.md`

`package-lock.json` already contained the required contracts and remained unchanged. The staged prepack build means `dist/experience-consolidate.mjs` remains unchanged rather than requiring post-run restoration.

## Skill-maintainer audit preparation for Task 9

This is the proportional audit input/evidence pack, not the final skill-architecture verdict.

| Category | Task 8 preparation/evidence |
| --- | --- |
| Trigger and boundary design | Frontmatter includes Runtime Advisor and `/experience setup`; unrelated-extension exclusion remains. Grouped setup is first and typed subcommands are advanced/backward-compatible only. |
| Scope and ownership | `agent-experience` remains the single operational skill owner. README/extension/validation files are audience-specific surfaces, not competing skills. |
| Contradictions and drift | Natural-first setup ordering, stale peer wording, and implications that Advisor pre-blocks tools or forces `followUp`/`nextTurn` were removed. Source assertions bind the public instruction layers. |
| Repetition and canonical gates | The skill states its load-bearing operating gate once in the grouped setup section. Cross-surface repetition is intentional for separate audiences and source-gated against drift. |
| Size and progressive disclosure | Baseline: 243 lines / 21,407 bytes / approximately 5,352 bytes÷4 tokens. Final: 259 lines / 24,124 bytes / approximately 6,031 tokens. Delta: +16 lines / +2,717 bytes / approximately +679 tokens. The root was already above the practical 5,000-token target and remains below 500 lines. |
| Instruction quality | Setup choices are ordered and executable; inheritance, incremental review, confined tools, authority, delivery, learning, and fallbacks are explicit and fail closed. |
| Safety and enforcement | The skill distinguishes runtime enforcement from instruction: confined read-only tools, no pre-execution blocking, no forced continuation, visible-only fallback, no direct habit mutation, and no private Advisor-state persistence. |
| Reference and portability design | There are no skill references/scripts/evals, hence no broken reference chain. Stock Pi limitations and public APIs stay in the root skill; no cross-harness claim was added. |
| Eval design | Positive/boundary/privacy behavior is source-gated and exercised through the actual installed loader plus real installed Pi PTYs at two widths. No dedicated model-graded trigger/negative skill eval exists. |
| Maintainability and evidence | The patch is bounded to Task 8 files; no live skill was edited or synced. RED/GREEN, installed loader, packed file/peer/size, PTY artifacts, adversarial isolation, failure manifests, and cleanup evidence are recorded here. |

Authoritative Task 9 inputs: Task 8 brief, approved design/plan already in the repository, baseline `HEAD:skills/agent-experience/SKILL.md`, current skill, focused Task 8 diff, empty reference/eval tree, source/PTY/security evidence above, and higher-priority repository/task constraints.

### Remaining audit concerns

- Task 9 still owns the independent category-by-category skill architecture/design review and blocking verdict. This report does not claim that audit is complete.
- The root instruction estimate remains above the practical 5,000-token target; Task 9 must decide whether one-level progressive disclosure improves the architecture without hiding load-bearing gates.
- No dedicated should-trigger/should-not-trigger/adversarial skill eval exists; deterministic source and real installed-TUI gates do not replace Task 9's architecture review.

## Cleanliness gate

Only the files above are intended for the Task 8 commit. The exact commit hash and post-commit worktree status are necessarily returned after this report itself is committed.
