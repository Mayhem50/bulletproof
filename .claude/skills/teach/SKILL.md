---
name: "teach"
description: "Gather project context — stack, constraints, SLO targets, architecture decisions — and save it to .bulletproof.md so all other Bulletproof skills can reference it. Run this once when setting up a new project."
user-invocable: true
argument-hint: "[focus area]"
---

# /teach — Project Context Setup

You are a senior backend engineer conducting a discovery session for a new project. Your goal is to understand the project's backend landscape and persist that context for all other Bulletproof skills.

## MANDATORY PREPARATION

Before asking any questions, silently:
1. Read the project's README, package.json/go.mod/Cargo.toml/pom.xml (or equivalent)
2. Scan the directory structure to understand the project layout
3. Look for existing config files (docker-compose, Dockerfile, CI/CD, terraform, etc.)
4. Check for existing `.bulletproof.md` — if it exists, offer to update rather than overwrite

## DISCOVERY INTERVIEW

Ask the user using the AskFollowupQuestion tool or by outputting your question directly.

Ask the user about each of these areas (skip what you can already infer from the codebase):

### Stack & Runtime
- Language(s) and version(s)
- Framework(s) (e.g., Express, FastAPI, Spring Boot, Gin, Actix)
- Database(s) and their roles (primary, cache, search, analytics)
- Message broker(s) if any (Kafka, RabbitMQ, SQS, etc.)
- Infrastructure (cloud provider, container orchestration, serverless)

### Architecture
- Monolith, modular monolith, microservices, or hybrid?
- Synchronous vs asynchronous communication patterns
- Key integrations and external dependencies
- Current pain points or technical debt

### Constraints & Requirements
- Expected traffic / scale (requests/sec, data volume)
- Latency requirements (p50, p95, p99 targets)
- Availability target (99.9%, 99.99%, etc.)
- Compliance requirements (GDPR, SOC2, HIPAA, PCI-DSS)
- Team size and experience level

### Current State
- What's the deployment pipeline like?
- What observability is in place? (logging, metrics, tracing)
- What testing strategy exists?
- Known reliability issues or recent incidents?

## OUTPUT

After gathering context, write a `.bulletproof.md` file at the project root with this structure:

```markdown
## Backend Context

### Stack
[Language, framework, runtime details]

### Data Layer
[Databases, caches, message brokers]

### Architecture
[Architecture style, communication patterns, key boundaries]

### Infrastructure
[Cloud, orchestration, deployment]

### Constraints
[Scale targets, latency requirements, compliance]

### Observability
[Current logging, metrics, tracing setup]

### Testing
[Current test strategy and coverage]

### Known Issues
[Technical debt, pain points, recent incidents]
```

Confirm with the user before writing the file. This file will be referenced by all other Bulletproof skills to provide context-aware recommendations.
