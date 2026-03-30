import { mkdirSync, writeFileSync, readdirSync, existsSync, cpSync } from "fs";
import { join, resolve } from "path";
import { parseFrontmatter, replacePlaceholders, readSkillFile } from "../utils.js";

const ROOT = resolve(import.meta.dirname, "../../../");
const SOURCE_DIR = join(ROOT, "source/skills");

/**
 * Build YAML frontmatter string from an object, filtered by allowed fields.
 */
function buildFrontmatter(data, allowedFields) {
	const lines = ["---"];
	for (const field of allowedFields) {
		if (data[field] !== undefined) {
			const value = data[field];
			if (typeof value === "boolean") {
				lines.push(`${field}: ${value}`);
			} else {
				lines.push(`${field}: "${value}"`);
			}
		}
	}
	lines.push("---");
	return lines.join("\n");
}

/**
 * Create a transformer for a specific provider configuration.
 */
export function createTransformer(providerConfig) {
	const { provider, configDir, displayName, frontmatterFields, bodyTransform } =
		providerConfig;

	return {
		displayName,

		build() {
			const outputBase = join(ROOT, configDir);
			const skillDirs = readdirSync(SOURCE_DIR, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => d.name);

			let count = 0;

			for (const skillName of skillDirs) {
				const skillDir = join(SOURCE_DIR, skillName);
				const skillFile = join(skillDir, "SKILL.md");

				if (!existsSync(skillFile)) continue;

				const content = readSkillFile(skillDir);
				const { frontmatter, body } = parseFrontmatter(content);

				// Build provider-specific frontmatter
				const fm = buildFrontmatter(frontmatter, frontmatterFields);

				// Replace placeholders in body
				let processedBody = replacePlaceholders(body, provider);

				// Apply provider-specific body transform if any
				if (bodyTransform) {
					processedBody = bodyTransform(processedBody);
				}

				// Write output
				const outputDir = join(outputBase, skillName);
				mkdirSync(outputDir, { recursive: true });
				writeFileSync(join(outputDir, "SKILL.md"), `${fm}\n${processedBody}`);

				// Copy reference files if they exist
				const refDir = join(skillDir, "reference");
				if (existsSync(refDir)) {
					const outputRefDir = join(outputDir, "reference");
					cpSync(refDir, outputRefDir, { recursive: true });
				}

				count++;
			}

			return count;
		},
	};
}
