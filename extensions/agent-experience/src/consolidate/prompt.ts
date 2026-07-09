export const GENERALIZED_HABIT_INSTRUCTIONS = [
	"Extract the reusable behavioral essence across repeated examples. Do not overfit to one project, package, repo, file path, version, screenshot, or proper noun.",
	"Write condition as a general situation class, not a one-off context. Prefer 'When preparing a release' over 'When working on Agent Experience'; prefer 'When the user reports UI confusion' over a specific package name.",
	"Write behavior as durable agent conduct that can apply to future similar work. Durable tool/task categories such as npm package releases or Pi UI debugging are allowed when the repeated behavior truly belongs to that category; one-off names such as Agent Experience, pi-experiences, specific versions, hashes, paths, or screenshot ids are not.",
	"If examples share only a project-specific fact and no broader reusable behavior, return no proposal for that pattern.",
];
