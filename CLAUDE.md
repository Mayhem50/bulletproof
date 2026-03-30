# Bulletproof — Instructions for Claude

## What this is

Bulletproof is a collection of backend engineering skills for AI coding agents. Skills are authored in `source/skills/` and transformed into provider-specific formats by the build system.

## Build

```bash
npm run build    # Generate all provider outputs
npm run rebuild  # Clean + build
```

## Adding/editing skills

- Source of truth: `source/skills/<name>/SKILL.md`
- Never edit files in `.claude/skills/`, `.cursor/skills/`, etc. — they're generated
- After editing source skills, run `npm run build`

## Skill style

- Each skill is written as a prompt for an AI coding agent
- Skills should be opinionated and reference real backend engineering best practices
- Include concrete examples, anti-patterns, and structured output formats
- Use `{{placeholder}}` syntax for provider-specific values (see DEVELOP.md)

## Version management

- Version is in `package.json` and `.claude-plugin/plugin.json`
- Bump both when releasing
