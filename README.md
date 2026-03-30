# Bulletproof

**Backend engineering skills for AI coding agents.**

Bulletproof is a collection of skills that teach AI coding agents how to build robust, resilient, and production-ready backend systems. It covers architecture, API design, data modeling, resilience patterns, security, observability, performance, testing, and more.

Think of it as a senior backend engineer's knowledge, packaged as reusable skills for your AI assistant.

Inspired by [Impeccable](https://impeccable.style/) — which does the same for frontend design.

## Skills

| Thématique | Commande | Description |
|---|---|---|
| **Architecture** | `/architect` | Evaluate and propose architecture patterns adapted to context |
| | `/model` | Analyze business domain, bounded contexts, aggregates (DDD) |
| | `/split` | Help decompose a monolith or trace module/service boundaries |
| **API** | `/contract` | Audit API surface: naming, pagination, errors, versioning |
| | `/evolve` | Verify backward compatibility, migration/deprecation strategy |
| **Data** | `/schema` | Audit DB schema: normalization, indexes, anti-patterns |
| | `/migrate` | Generate zero-downtime migrations (expand/contract) |
| | `/cache` | Identify caching opportunities, strategy, invalidation |
| **Resilience** | `/fortify` | Add circuit breakers, bulkheads, timeouts, fallbacks |
| | `/retry` | Audit retry policies, idempotency keys, backoff, DLQ |
| | `/throttle` | Implement backpressure, load shedding, rate limiting |
| **Concurrency & Async** | `/async` | Audit async flows, queues, workers, sagas |
| | `/race` | Detect race conditions, missing locks, optimistic concurrency |
| **Security** | `/harden` | Scan OWASP top 10: injection, hardcoded secrets, missing headers |
| | `/authz` | Audit AuthN/AuthZ: JWT, RBAC/ABAC, multi-tenancy |
| | `/secrets` | Detect exposed secrets, propose rotation and vault patterns |
| **Observability** | `/observe` | Add structured logging, correlation IDs, OpenTelemetry spans |
| | `/slo` | Define golden signals, propose SLOs, configure alerts |
| | `/probe` | Implement liveness/readiness probes |
| **Performance** | `/profile` | Detect N+1, slow queries, hot paths |
| | `/stress` | Generate load test scenarios, identify bottlenecks |
| **Testing** | `/testplan` | Propose the right test pyramid for the project |
| | `/chaos` | Generate fault injection scenarios, game days |
| | `/pact` | Set up consumer-driven contracts between services |
| **Error Handling** | `/errors` | Structure errors (domain/infra/transient), propagation |
| | `/recover` | Implement rollback/compensation logic, saga failure paths |
| **Deployment** | `/deploy` | Audit deploy strategy: blue/green, canary, rollback |
| | `/flags` | Implement progressive rollout, kill switches, flag cleanup |
| **Inter-services** | `/orchestrate` | Audit event-driven, event sourcing, CDC, outbox, choreography vs orchestration |
| | `/gateway` | Configure routing, aggregation, auth at gateway level |
| **Transversal** | `/audit` | Global multi-dimension score across all 13 domains |
| | `/teach` | Collect stack, constraints, SLO targets into `.bulletproof.md` |
| | `/diagnose` | Systematic investigation of a production incident/bug |
| | `/postmortem` | Structure a post-mortem: timeline, root cause, action items |

## Installation

### Claude Code

```bash
claude mcp add-skill bulletproof
```

### Manual

Copy the contents of `.claude/skills/` into your project's `.claude/skills/` directory.

## Supported Agents

- Claude Code
- Cursor
- GitHub Copilot
- Gemini CLI
- Codex CLI
- Kiro
- OpenCode
- Trae
- Pi

## License

Apache 2.0
