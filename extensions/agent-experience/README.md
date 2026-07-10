# Agent Experience extension

Agent Experience learns **reviewed behavioral and working habits** from repeated interaction. It is not a skill store or factual memory store.

## Normal surfaces

Use natural conversation for direct habit declaration and numbered review:

1. discuss a pattern;
2. let Pi show exact `When:` / `Do:` wording;
3. confirm that exact draft in a later user message, or correct it and review the replacement;
4. ask to show suggestions/duplicates, then approve, reject, merge, supersede, archive, or keep numbered items separate in plain language.

No durable habit is created while drafting. A direct declaration bypasses only repetition evidence; law, conflicts, local duplicate checking, stale-state revalidation, audit, and fail-closed behavior still apply.

The complete control panel/fallback remains:

```text
/experience setup
```

The panel contains every normal action:

- save redacted chat examples locally;
- choose the Pi model used for manual habit learning;
- analyze the next bounded unread range;
- review suggestions;
- resolve possible duplicates;
- browse, disable, re-enable, archive, or recheck approved habits;
- prepare/remove local duplicate prevention;
- choose 7/14/30-day source-example retention;
- enable approved-habit reminders;
- inspect current settings;
- confirm scheduling is Phase 2/off;
- turn everything off.

Conversational tools expose only numbered `When:` / `Do:` summaries and supported outcomes. Normal users do not type IDs, checksums, thresholds, endpoints, model-server settings, source references, private paths, or advanced commands.

## Product invariants

- New or materially reworded habits require explicit approval; conversational saving requires a later user turn confirming the exact current draft.
- Exact normalized evidence may increase support for an unchanged approved identity.
- Exact strong contradiction may make one uniquely matched active habit dormant; replacement wording remains a proposal.
- Direct instructions and law override habits.
- No automatic approval, merge, replacement activation, law write, or timer installation.
- One private state root represents one human.
- Missing/corrupt/stale state fails closed.

Approved-but-waiting candidates remain visible under **Review approved habits** and are automatically rechecked after successful Analyze commits. Prior approval remains valid only while normalized condition, behavior, and polarity are unchanged.

## Capture and Analyze

Capture writes bounded, heuristically redacted completed conversation pairs. It does not create habits.

Observation generations use a checksummed tail manifest and fixed-width offset index, so normal append and Analyze do not parse or resend all history. Analyze reads only the next contiguous same-user unread range (default maximum 200 records / 80,000 bytes), includes compact structured prior-habit context, and advances its watermark only in the successful reducer transaction.

Fully analyzed source generations rotate through a recovery journal. Rotated redacted source text expires after 7 days by default, with 14/30-day choices. Minimized evidence, provenance, integrity checks, and review audit remain.

Redaction is heuristic, not a formal proof that every sensitive value is recognizable.

## Local duplicate prevention

Duplicate prevention is fully local and extension-managed.

- off by default;
- no download during package installation;
- explicit setup preparation downloads about 150 MB once;
- the pinned semantic-similarity model supports 50+ languages and is tested across languages;
- no hosted provider/fallback, API key, external runtime, Python, model server, port, account, or service;
- private 0700/0600 cache inside the state root;
- pinned version/size/SHA-256 manifest;
- offline inference after preparation;
- cancellation cleanup, corruption fail-closed, upgrade staging, and setup removal;
- single-threaded bounded worker, 128-token input cap, maximum 64 texts per local request, and 30-second idle unload.

Normalized condition and behavior wording enter local inference as two independent inputs. Raw examples, source refs, evidence summaries, residual JSON, paths, checksums, audit text, credentials, and tokens do not.

Effective similarity is the lower of the two field scores. The review threshold is 5,500 basis points and the strong threshold is 7,000; both fields must align. Opposite polarity is excluded before comparison.

Normal scans compare active/disabled approved habits only. Candidate targets are checked against approved habits during proposal and activation; candidate-to-candidate semantic routing is excluded. Scans remain capped at 100 current habits / 4,950 pairs, batched, cancellable, progress-visible, snapshot-revalidated, and committed in one transaction. Failure leaves pre-scan semantic state unchanged.

User-started scans dismiss obsolete pending scoring-method relations with audit. Candidates remain hidden until all their pending relations resolve. Unchanged keep-separate decisions survive method upgrades through wording hashes or validated legacy cache proof; changed/corrupt proof fails closed to re-review.

Similarity only routes possible duplicates for explicit resolution. No semantic result approves or merges a habit.

## Conversational state and activation concurrency

Conversational state is bounded process memory scoped to the current user/session: one exact draft and one numbered review snapshot, 15-minute expiry, no raw conversation or confirmation utterance, and no model-visible capability token. Drafting never writes the ledger. Restart/expiry requires a fresh draft or list.

Direct declaration, approve, re-enable, and approved-pending promotion share atomic semantic activation rules:

1. snapshot the declared/candidate target plus active/disabled comparators and relevant relations;
2. prepare missing local vectors outside the writer transaction;
3. begin `BEGIN IMMEDIATE`;
4. re-read target/comparators/relations and synchronously revalidate current law;
5. create the declared candidate only after semantic preparation succeeds;
6. persist valid cache/relation/audit changes;
7. block or perform the state transition before one commit.

A clean direct declaration activates without fabricated observation evidence. A semantic-unavailable declaration creates no candidate. A possible duplicate creates an inactive candidate and pending relation but never auto-merges. Numbered review actions resolve through hidden snapshots, then existing checksum/CAS product transactions revalidate before mutation.

State drift retries boundedly, then fails closed. Two concurrent connections cannot both activate semantic duplicates.

## Storage safety

- schema v6;
- first statement on an existing ledger is read-only `PRAGMA user_version`;
- future versions receive no mutation;
- v5→v6 migration is transactional/idempotent;
- current schemas verify required structures.

Online backups contain a standalone consistent `ledger.sqlite` only. Restore allowlists and prevalidates artifacts, rejects symlinks/traversal/tamper/future schemas, uses a checksummed recovery journal, removes stale WAL/SHM, and produces a complete old or restored state rather than a mixed generation.

Shared locks carry random token, PID, hostname, and creation time. Live locks block; expired/dead/malformed locks recover under bounded rules; foreign-host locks fail closed; release verifies ownership.

## Selector/reminders and visible steering provenance

Approved-habit reminders are off by default. Default instant mode is lexical, local, and no-network. It matches meaningful condition tokens only, ignores behavior text/common stopwords, and keeps only the strongest overlap tier; genuinely tied habits may all apply. Only active same-user approved habits are candidates.

A habit may steer one specific TUI response only when Pi can append response-adjacent provenance after the triggering user message and before provider context is returned:

```text
◇ Steered by habit · When I ask for cobalt status
```

Each selected condition gets an exact collapsed line; expanded rendering shows every selected approved `When:` / `Do:` pair. No marker means that response received no habit guidance. The entry is durable local session provenance and does not participate in LLM context. A separate non-persisted hidden guidance message enters only that response's provider context and is repeated across its tool loop without adding markers. The entry stores no raw prompt, internal ID, checksum, confidence, provider/model, source ref, raw example, path, or audit payload. New user messages cannot inherit old steering. Non-TUI modes and renderer/build/append failures suppress steering rather than hide it.

Selector hit logs still persist no raw prompts or injected guidance; `prompt_hash` remains `omitted`. The response-adjacent marker is authoritative proof that guidance reached that response. The configured law file is synchronously revalidated at activation. Current law checking combines freshness/integrity with a deterministic dangerous-pattern denylist; it is not full semantic interpretation of law text.

## State layout

Default root: `~/.agents/experience/`

```text
agent-experience.toml
ledger.sqlite
observations.jsonl
observations.idx
observations-tail.json
archive/observations/
models/local-embedding/
law.md
habits-report.md
```

`habits-report.md` is report-only and never selector input.

## Advanced compatibility controls

Typed capture/consolidation/review/selector commands and `experience-consolidate` exist for maintainers and tests. Do not present them as the normal workflow. Natural conversation is optional; setup must remain complete by itself.

Timer unit files are disabled templates only. No setup action installs or enables them.

## Validation

Run from package root:

```bash
npm run check
npm audit --omit=dev
```

See `VALIDATION.md` for local-model fixtures, packed installation, Node 22.19+, skill loader, and isolated real Pi TUI validation.
