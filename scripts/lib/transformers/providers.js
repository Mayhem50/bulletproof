/**
 * Provider configurations for skill transformation.
 * Each provider specifies its output directory and supported features.
 */
export const PROVIDERS = [
	{
		provider: "cursor",
		configDir: ".cursor/skills",
		displayName: "Cursor",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "claude",
		configDir: ".claude/skills",
		displayName: "Claude Code",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "gemini",
		configDir: ".gemini/skills",
		displayName: "Gemini CLI",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "codex",
		configDir: ".codex/skills",
		displayName: "Codex CLI",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "copilot",
		configDir: ".agents/skills",
		displayName: "GitHub Copilot",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "kiro",
		configDir: ".kiro/skills",
		displayName: "Kiro",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "opencode",
		configDir: ".opencode/skills",
		displayName: "OpenCode",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "trae",
		configDir: ".trae/skills",
		displayName: "Trae",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "trae-cn",
		configDir: ".trae-cn/skills",
		displayName: "Trae CN",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
	{
		provider: "pi",
		configDir: ".pi/skills",
		displayName: "Pi",
		frontmatterFields: [
			"name",
			"description",
			"user-invocable",
			"argument-hint",
		],
	},
];
