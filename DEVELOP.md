# Contributing to Bulletproof

## Skill Format

Every skill lives in `source/skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: skill-name
description: "Description used by agents to decide when to trigger this skill"
argument-hint: "[target]"
user-invocable: true
---
```

### Frontmatter Fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Skill identifier (1-64 chars) |
| `description` | Yes | Trigger description (up to 1024 chars) |
| `user-invocable` | No | Set to `true` for slash commands |
| `argument-hint` | No | Autocomplete hint (e.g., `"[target]"`) |

### Placeholders

Use these in skill body content — they're replaced per-provider during build:

| Placeholder | Description |
|---|---|
| `{{model}}` | Provider's model name |
| `{{config_file}}` | Provider's config file path |
| `{{command_prefix}}` | `/` or `$` depending on provider |
| `{{ask_instruction}}` | How to ask the user a question |

### Reference Files

Skills can have reference documents in a `reference/` subdirectory:

```
source/skills/backend-engineering/
├── SKILL.md
└── reference/
    ├── resilience.md
    ├── data-patterns.md
    └── ...
```

## Build System

```bash
npm run build    # Generate provider-specific skill files
npm run clean    # Remove generated files
npm run rebuild  # Clean + build
```

The build reads from `source/skills/` and generates output for 10 providers:
- `.claude/skills/` (Claude Code)
- `.cursor/skills/` (Cursor)
- `.gemini/skills/` (Gemini CLI)
- `.codex/skills/` (Codex CLI)
- `.agents/skills/` (GitHub Copilot)
- `.kiro/skills/` (Kiro)
- `.opencode/skills/` (OpenCode)
- `.trae/skills/` (Trae)
- `.trae-cn/skills/` (Trae CN)
- `.pi/skills/` (Pi)

## Adding a New Skill

1. Create `source/skills/<name>/SKILL.md`
2. Add frontmatter with `name`, `description`, `user-invocable: true`
3. Write the skill prompt (see existing skills for style)
4. Run `npm run build` to generate provider outputs
5. Test with your preferred agent

## Adding a New Provider

1. Add placeholder values in `scripts/lib/utils.js` → `PROVIDER_PLACEHOLDERS`
2. Add provider config in `scripts/lib/transformers/providers.js` → `PROVIDERS`
3. Run `npm run build`

## Skill Writing Guidelines

- Reference `.bulletproof.md` for project context
- Be opinionated — reference real industry best practices
- Include concrete examples with code
- Use structured output format with ASCII box headers
- End with a memorable engineering maxim
- Use `{{ask_instruction}}` when the skill needs user input
