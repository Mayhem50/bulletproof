import { readFileSync } from "fs";
import { join } from "path";

/**
 * Provider-specific placeholder values for template substitution.
 */
export const PROVIDER_PLACEHOLDERS = {
	cursor: {
		model: "the current model",
		config_file: ".cursor/rules",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	claude: {
		model: "Claude",
		config_file: "CLAUDE.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user using the AskFollowupQuestion tool or by outputting your question directly.",
	},
	gemini: {
		model: "Gemini",
		config_file: "GEMINI.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	codex: {
		model: "the current model",
		config_file: "codex.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	copilot: {
		model: "the current model",
		config_file: ".github/copilot-instructions.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	kiro: {
		model: "the current model",
		config_file: "kiro.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	opencode: {
		model: "the current model",
		config_file: "opencode.md",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	trae: {
		model: "the current model",
		config_file: ".trae/rules",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	"trae-cn": {
		model: "the current model",
		config_file: ".trae-cn/rules",
		command_prefix: "/",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
	pi: {
		model: "the current model",
		config_file: ".pi/rules",
		command_prefix: "$",
		ask_instruction:
			"Ask the user by outputting your question directly in the chat.",
	},
};

/**
 * Parse YAML-like frontmatter from a skill file.
 * Returns { frontmatter: Object, body: string }
 */
export function parseFrontmatter(content) {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) {
		return { frontmatter: {}, body: content };
	}

	const frontmatter = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		// Remove surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		// Parse booleans
		if (value === "true") value = true;
		else if (value === "false") value = false;
		frontmatter[key] = value;
	}

	return { frontmatter, body: match[2] };
}

/**
 * Replace {{placeholder}} tokens in text with provider-specific values.
 */
export function replacePlaceholders(text, provider) {
	const values = PROVIDER_PLACEHOLDERS[provider];
	if (!values) return text;

	return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
		return values[key] !== undefined ? values[key] : match;
	});
}

/**
 * Read a skill file from the source directory.
 */
export function readSkillFile(skillDir, filename = "SKILL.md") {
	return readFileSync(join(skillDir, filename), "utf-8");
}
