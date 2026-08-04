# Task 9 skill fixes — audit preparation

## Scope and correction

This is the updated Step 4a evidence pack for the final independent skill-architecture reviewer, not that reviewer's verdict. The patch is limited to the maintained skill, its eval corpus, retained public documentation surfaces, the deterministic source/eval gate, and this report.

The resolved Pi 0.83 declarations are authoritative for the corrected platform claim: `ToolCallEvent` is fired before execution and can block (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:684-690`), and `ToolCallEventResult.block` blocks execution (`:778-781`). The product boundary is separate: Runtime Advisor intentionally never registers or uses `tool_call` and never vetoes, pauses, or pre-blocks a primary tool call.

The inaccurate “stock Pi provides no pre-execution blocking” claim was replaced on all retained surfaces:

- `skills/agent-experience/SKILL.md`
- the normal-user Runtime Advisor section in `README.md`
- the maintainer Runtime Advisor contract in `README.md`
- `extensions/agent-experience/README.md`

Every surface retains the actual delivery limitations: no `followUp` or `nextTurn`, steering only during a safely active continuation, then settlement delivery or visible-only fallback. The source gate rejects both wording drift and any `pi.on("tool_call", ...)` registration in the extension entry point.

## Baseline, size, and progressive disclosure

| Artifact | Lines | Bytes | Approximate instruction tokens |
| --- | ---: | ---: | ---: |
| Baseline `fcc505b:skills/agent-experience/SKILL.md` | 243 | 21,407 | 5,352 |
| Current `skills/agent-experience/SKILL.md` | 259 | 24,192 | 6,048 |
| Delta | +16 | +2,785 | +696 |
| New `skills/agent-experience/evals/evals.json` | 102 | 6,490 | not loaded as root instructions |

The root remains above the practical 5,000-token target but below the loose 500-line ceiling. The Task 8 additions are load-bearing setup, authority, consent, privacy, and fail-closed delivery rules; moving them behind an optional reference would weaken the operating gate. The eval corpus adds no root instruction cost.

## Ten-category audit preparation

| Category | Updated evidence for independent review |
| --- | --- |
| 1. Trigger and boundary design | Frontmatter routes `/experience setup` and Runtime Advisor while excluding unrelated Pi extension development. Evals 1-2 are positive setup/Advisor triggers, 3-4 are unrelated-Pi and generic-advisor negatives, and 5 is the Pi-hook-versus-this-product boundary. |
| 2. Correct scope and ownership | `agent-experience` remains the sole operational skill owner. Root and extension READMEs repeat only audience-appropriate product contracts; no neighboring skill was modified or given competing ownership. |
| 3. Contradictions and drift | The false platform limitation is removed. All retained surfaces now distinguish Pi 0.83's blockable hook from deliberate Advisor non-use. The focused gate verifies the corrected sentence and the implementation's lack of `tool_call` registration. |
| 4. Repetition and canonical gates | The root skill remains the canonical agent operating gate. Repetition across the normal-user README, maintainer contract, and extension README is intentionally retained because each is an independently consumed surface; one source loop validates all three against the same semantic boundary. |
| 5. Size and progressive disclosure | Exact baseline/current measurements are above. No new root section or optional reference was added. The 6,490-byte eval corpus is validation data, not injected root guidance. |
| 6. Instruction quality | The corrected rule is executable and unambiguous: Pi can block through `tool_call`; Advisor does not register/use it; Advisor never pre-blocks; `followUp`/`nextTurn` remain forbidden; settlement/visible fallback remains explicit. |
| 7. Safety and enforcement boundary | Runtime capability and product policy are no longer conflated. Deterministic source enforcement rejects hook registration. Evals 7-9 defend generic-advice non-authority, later-turn exact-draft approval, and private Advisor transcript/raw-output boundaries. Direct instructions and law continue to override habits. |
| 8. Reference and portability design | There is no skill reference chain. The claim is explicitly scoped to supported Pi 0.83, matching the resolved and declared Pi API line. The actual Pi loader reads the root directly with zero diagnostics. |
| 9. Eval design | The repository previously had no eval convention. The new file follows the installed `skill-creator` `evals.json` schema: `skill_name`, integer IDs, prompts, expected outputs, file lists, and expectations. Coverage is 2 should-trigger, 2 should-not-trigger, 1 boundary, 1 contradiction, and 3 adversarial cases. The repository has no skill-eval runner, so none was invented; deterministic schema and required-content validation is part of the focused source gate. |
| 10. Maintainability and evidence | This is the smallest coherent correction: four retained wording locations, one eval corpus, and one strengthened source gate. Stale wording has no retained match. Validation evidence is recorded below. The final independent skill-architecture reviewer still owns the category-by-category verdict. |

## Old/new behavior and regression evidence

- Baseline `fcc505b` did not route Runtime Advisor in frontmatter and placed natural habit conversation before grouped setup.
- Task 8 added Runtime Advisor/setup routing and real installed Pi PTY evidence but explicitly recorded no dedicated trigger/negative/adversarial eval corpus.
- This patch preserves Task 8's grouped setup and runtime behavior while correcting the platform statement and adding nine regression prompts.
- Evals 1-2 expect correct skill selection for setup and Advisor troubleshooting.
- Evals 3-4 expect non-selection for an unrelated Pi extension and a generic career advisor.
- Eval 5 prevents a recurrence of the platform/product-boundary contradiction.
- Eval 6 preserves independent Learning and Advisor controls and forbids auto-created habits.
- Evals 7-9 resist authority escalation, same-message approval bypass, and privacy disclosure.
- Task 8's installed grouped/Advisor PTY evidence remains the latest end-to-end runtime behavior evidence. This focused skill-fix slice did not rerun or invent a model-graded eval runner or the isolated verifier.

## Focused validation evidence

| Check | Observed result |
| --- | --- |
| Actual resolved Pi skill/frontmatter loader against `skills/agent-experience/SKILL.md` with defaults excluded | `{"diagnostics":[],"skills":["agent-experience"]}` |
| `node --experimental-strip-types scripts/check-agent-experience-source.mjs` | `agent-experience source/import/package/eval-schema checks passed` |
| Deterministic eval-schema/content gate inside the focused source check | Valid top-level schema; nine unique positive integer IDs; exact supported per-case fields; non-empty prompts/expected outputs; at least two expectations per case; required category counts and setup/Advisor/negative/authority/approval/privacy content all passed |
| Stale-claim search across the skill, READMEs, validation guide, and source gate | No retained `no/provides no/exposes no pre-execution tool blocking` match |

## Independent-review handoff

The final independent reviewer must still inspect the complete baseline/current skill system, focused diff, eval quality, authoritative Pi declarations, and all ten categories, then return the blocking verdict. This report does not pre-claim PASS.
