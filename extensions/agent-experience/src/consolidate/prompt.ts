export const GENERALIZED_HABIT_INSTRUCTIONS = [
	"Extract the reusable behavioral essence across repeated examples. Do not overfit to one project, package, repo, file path, version, screenshot, or proper noun.",
	"Write condition as a general situation class, not a one-off context. Prefer 'When preparing a release' over 'When working on Agent Experience'; prefer 'When the user reports UI confusion' over a specific package name.",
	"Write behavior as durable agent conduct that can apply to future similar work. Durable tool/task categories such as npm package releases or Pi UI debugging are allowed when the repeated behavior truly belongs to that category; one-off names such as Agent Experience, pi-experiences, specific versions, hashes, paths, or screenshot ids are not.",
	"If examples share only a project-specific fact and no broader reusable behavior, return no proposal for that pattern.",
];

// Rubric that keeps only genuine behavioral habits and rejects facts, skills, and
// single-task instructions. Sent as system-prompt guidance; examples are generic
// and contain no real names, paths, or identifiers.
export const HABIT_CLASSIFICATION_RUBRIC = [
	"Classify each pattern before proposing. Only a HABIT is proposable:",
	"- HABIT: a durable, reusable way to behave across similar future work (caution, timing, evidence standards, clarification style, review discipline, tone). Propose these.",
	"- FACT: durable knowledge or project context (a name, a decision, which branch ships). Belongs in memory. Never propose it as a habit.",
	"- SKILL: a deliberately authored multi-step procedure, checklist, or playbook. Never propose it as a habit.",
	"- ONE-OFF INSTRUCTION: a single-task directive with no reusable behavioral generalization. Never propose it as a habit.",
];

// Causal friction extraction: identify candidates by reasoning over what went
// wrong (or what a stable preference implies), not by clustering similar wording.
export const FRICTION_EXTRACTION_INSTRUCTIONS = [
	"Identify candidates by causal reasoning over the batch, not by clustering superficially similar messages. Shared words are not a habit.",
	"For each candidate, work in three steps: (1) LOCATE FRICTION — a moment where the user corrected the assistant, repeated a request, expressed dissatisfaction, or had to clarify something the assistant should have anticipated; (2) INFER THE IMPROVEMENT DIRECTION — the behavioral change that would have prevented that friction; (3) FORMULATE — express it as a generalized When/Do habit (a situation class plus durable conduct) following the generalization rules.",
	"Weight friction over preference. Corrections, complaints, and repeated requests are the primary, higher-confidence signal. Stable positive preferences with no friction (for example always wanting a table format or always wanting a rollback plan) still qualify, but require stronger and cleaner repetition and MUST receive a lower confidence_bp than friction-derived candidates.",
	"Adjacent observations MAY be related conversation turns, but adjacency is NOT guaranteed: concurrent sessions can interleave into one stream and captured pairs can be dropped, leaving gaps. So corroborate before linking — treat observation N+1 user pushback as friction evidence about observation N ONLY when the pushback content plausibly refers to that assistant behavior AND their created_at timestamps are close (minutes, not hours). Otherwise treat the pairs as independent. Friction often lives BETWEEN pairs, but this is a heuristic to apply with judgment, not a guaranteed structure — confirm the link before attributing it.",
	"Friction example: an assistant message claims a task is finished, and the next user message says the result was not actually verified. Propose 'When claiming a task is complete, verify the result before reporting it.'",
	"Negative example: several messages share a keyword (for example 'deploy') but show no common correction, dissatisfaction, or repeated preference. Return no proposal — surface similarity without friction or a stable preference is not a habit.",
];

export const HABIT_FEWSHOT_EXAMPLES = [
	"Propose (habit): condition 'When reporting whether work is finished', behavior 'State done or blocked, cite concrete evidence, then give the next action.'",
	"Propose (habit): condition 'When a request is ambiguous enough to change correctness', behavior 'Ask one focused question before proceeding.'",
	"Propose (habit): condition 'When about to call a build or release ready', behavior 'Verify the actual produced artifact instead of assuming success.'",
	"Do NOT propose (fact): 'The release ships from the main branch.' A fact belongs in memory, not a habit.",
	"Do NOT propose (skill): 'Follow the multi-step deployment checklist.' A procedure is a skill, not a habit.",
	"Do NOT propose (one-off): 'Rename this flag in this one file right now.' A single-task instruction has no reusable behavior.",
];
