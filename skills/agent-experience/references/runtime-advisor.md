# Runtime Advisor reference

Read this reference when configuring, troubleshooting, auditing, or changing Pi Experiences Runtime Advisor behavior. Ordinary habit declaration, suggestion review, and non-Advisor setup do not require it.

## Host behavior

- **Pi:** the package's opt-in Runtime Advisor is a second model. Pi owns its incremental queue, confined tools, visible findings, and safe steering/fallback lifecycle.
- **OMP:** the package does not start Runtime Advisor. It retrieves bounded, relevant, human-approved Experience entries and adds them to OMP's native Advisor review context. There is no second Advisor and no additional reviewer-model call. OMP owns Advisor enablement, model selection, full-conversation review, tools, delivery, and lifecycle.

`/experience setup` remains the complete settings menu on both hosts. On OMP, **Use Experiences in OMP Advisor** prepares private local semantic files and enables only the context contribution; OMP's own settings still control whether its native Advisor runs.

## Pi Runtime Advisor model and investigation

On Pi, **Advisor model** is a separate choice that defaults to **Same as habit assessment**. After disclosure and explicit confirmation, this second model reviews bounded incremental primary-turn updates.

Pi Runtime Advisor investigation is limited to wrapped `read`, `grep`, and `glob` tools. Every path and result is bounded, redacted, and workspace-confined. No mutating tool is available. Review-time transcript/tool material is process-local and must not become durable session or Experience state.

## Pi Runtime Advisor authority and delivery

Exact approved Experience habits supplied in the current Pi update are the complete policy source. Reviewer reasoning, generic best practices, WATCHDOG content, workspace files, and tool output cannot create policy or produce standalone advice. A validated finding exposes exact `When:` / `Do:` wording and next step. Direct current user instructions and law override habits; a conflict or ambiguity requires silence.

An eligible active Pi run may steer one validated `concern` or `blocker`. Canceled, terminal, plan mode, ambiguous, idle, unsupported, replacement, and shutdown states append visibly when safe or use a visible-only fallback. Never represent visible-only fallback as model guidance.

Stock Pi 0.83 provides a blockable pre-execution `tool_call` hook. Pi Runtime Advisor intentionally never registers or uses that hook and never vetoes, pauses, or pre-blocks a primary tool call. Never use `followUp` or `nextTurn`.

## Pi Runtime Advisor learning and persistence

Pi learning stays independently gated. With **Learning from conversations** off, there is no Advisor observation. With Learning on, one accepted Pi Runtime Advisor event may append at most one bounded observation. It cannot directly create or change a habit; repeated evidence, Analyze, human review, and explicit approval remain mandatory.

Durable observations may contain only bounded redacted visible assistant behavior, safe categorical event metadata, and exact approved behavior. User prompts, tool-call arguments, tool-result content, thinking, private Advisor transcript, raw model output, candidate aliases, retrieval scores, tool investigations/results, queue state, and suppressed findings must never persist.

Ordinary Pi runtime habit retrieval is read-only. Explicit setup, approval, or maintenance may prepare local habit vectors; a live Runtime Advisor review must use existing cache state and fail closed when expansion vectors are unavailable.

## Pi Runtime Advisor failure behavior

Malformed or unknown aliases, stale law/config/session/generation/cursor/epoch state, unsupported provider payloads, secret-redaction uncertainty, cancellation, timeout, model failure, or unsafe delivery state produce no hidden guidance. At most one approved-habit finding may be emitted for one reviewed update, and Advisor-caused turns must not recursively review themselves.

## OMP native Advisor context

On OMP, Agent Experience starts no model, exposes no Advisor tools, and performs no steering or card delivery itself. It retrieves eligible approved Experience entries for the current runtime/workspace/repository/project scope, bounds the newest update data, and contributes sanitized context plus current-review opaque habit aliases through OMP's native Advisor hook. Only habit entries can define runtime policy; preferences, constraints, facts, decisions, episodes, and goals are support context.

OMP's native Advisor uses the live conversation to decide applicability and retains ownership of its model, tools, delivery, lifecycle, and failure behavior. When an approved habit directly causes advice, the Advisor may cite its opaque alias; OMP validates that alias, renders an **Experience** card with exact `When:` / `Do:` provenance, and tells the primary agent to follow that exact approved behavior unless higher-priority instructions or safety conflict. Unknown, stale, or duplicate aliases remain ordinary non-authoritative Advisor notes and cannot claim Experience provenance. When Learning is enabled, a context-marked OMP reviewer turn with exactly one attributable habit may retain at most its first `concern` or `blocker` as a bounded observation after the Advisor transcript is closed. Raw transcript text, review notes, user content, tool data, and private identifiers are not copied into that observation. If retrieval, context assembly, attribution, or retention fails, no Experience context or observation is produced and OMP Advisor continues normally.
