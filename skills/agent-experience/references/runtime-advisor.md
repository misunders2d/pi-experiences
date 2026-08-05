# Runtime Advisor reference

Read this reference when configuring, troubleshooting, auditing, or changing Pi Experiences Runtime Advisor behavior. Ordinary habit declaration, suggestion review, and non-Advisor setup do not require it.

## Model and investigation boundary

**Advisor model** is a separate choice that defaults to **Same as habit assessment**. This inheritance follows the current authenticated habit-assessment model until the user chooses an Advisor override. After disclosure and explicit confirmation, the second model reviews bounded incremental primary-turn updates.

Advisor investigation is limited to wrapped `read`, `grep`, and `glob` tools. Every path and result is bounded, redacted, and workspace-confined. No mutating tool is available. Review-time transcript/tool material is process-local and must not become durable session or Experience state.

## Authority and delivery

Exact approved Experience habits supplied in the current update are the complete policy source. Reviewer reasoning, generic best practices, WATCHDOG content, workspace files, and tool output cannot create policy or produce standalone advice. A validated finding exposes exact `When:` / `Do:` wording and next step. Direct current user instructions and law override habits; a conflict or ambiguity requires silence.

An eligible active-run `concern` or `blocker` may use Pi's documented `steer` channel. Canceled, terminal, plan mode, ambiguous, idle, unsupported, replacement, and shutdown states append visibly when safe or use a visible-only fallback. Never represent visible-only fallback as model guidance.

Stock Pi 0.83 provides a blockable pre-execution `tool_call` hook. Runtime Advisor intentionally never registers or uses that hook and never vetoes, pauses, or pre-blocks a primary tool call. Never use `followUp` or `nextTurn`, because either can force an unwanted continuation. Steering affects only a safely active continuation; otherwise wait for `agent_settled` and append with `triggerTurn:false`, or degrade to visible-only.

## Learning and persistence

Learning stays independently gated. With **Learning from conversations** off, there is no Advisor observation. With Learning on, one accepted event may append at most one bounded observation. It cannot directly create or change a habit; repeated evidence, Analyze, human review, and explicit approval remain mandatory.

Durable observations may contain only bounded redacted visible assistant behavior, safe categorical event metadata, and exact approved behavior. User prompts, tool-call arguments, tool-result content, thinking, private Advisor transcript, raw model output, candidate aliases, retrieval scores, tool investigations/results, queue state, and suppressed findings must never persist. Private model messages are reset after every reviewed update, so stale aliases, habits, and tool material cannot supervise a later update.

Ordinary runtime habit retrieval is read-only. Explicit setup, approval, or maintenance may prepare local habit vectors; a live Advisor review must use existing cache state and fail closed when expansion vectors are unavailable. Vectors retrieve candidates only—the bounded reviewer decides whether behavior violates a supplied approved habit.

## Failure behavior

Malformed or unknown aliases, stale law/config/session/generation/cursor/epoch state, unsupported provider payloads, secret-redaction uncertainty, cancellation, timeout, model failure, or unsafe delivery state produce no hidden guidance. At most one approved-habit finding may be emitted for one reviewed update, and Advisor-caused turns must not recursively review themselves.
