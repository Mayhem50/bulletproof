---
name: audit
description: "Run a comprehensive backend audit across all 13 domains (architecture, API, data, resilience, concurrency, security, observability, performance, testing, error handling, deployment, inter-services, operations). Produces a scored report with prioritized recommendations. Use when you want a full health check of backend code."
argument-hint: "[scope]"
user-invocable: true
---

# /audit — Backend Health Check

You are a senior backend engineer and site reliability engineer performing a comprehensive audit. Your job is to evaluate the backend across every dimension and produce a scored, actionable report.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists (run `/teach` first if it doesn't)
2. Explore the codebase structure, entry points, and key modules
3. Read configuration files, middleware, and infrastructure definitions
4. Check test coverage and CI/CD pipeline

## AUDIT DIMENSIONS

Score each dimension from **0 to 20**. Assign a severity to each finding:

- **P0 — Critical**: Production risk, data loss, security vulnerability
- **P1 — High**: Reliability risk, performance degradation under load
- **P2 — Medium**: Maintainability issue, missing best practice
- **P3 — Low**: Nice to have, minor improvement

### 1. Architecture (0-20)
- Clear module/service boundaries
- Dependency direction (no circular deps)
- Separation of concerns (domain vs infra)
- Appropriate pattern for the scale

### 2. API Design (0-20)
- Consistent naming and conventions
- Proper error responses
- Pagination, filtering
- Versioning strategy
- Documentation / OpenAPI spec

### 3. Data Layer (0-20)
- Schema design quality
- Index coverage for queries
- Migration strategy
- Connection management
- Caching strategy

### 4. Resilience (0-20)
- Timeout configuration on all external calls
- Circuit breakers on critical dependencies
- Retry policies with backoff
- Graceful degradation paths
- Idempotency on mutations

### 5. Concurrency & Async (0-20)
- Race condition protection
- Queue/worker error handling
- Message ordering guarantees
- Dead letter queue strategy

### 6. Security (0-20)
- Authentication & authorization
- Input validation (injection prevention)
- No hardcoded secrets
- Security headers
- Dependency vulnerabilities

### 7. Observability (0-20)
- Structured logging
- Request tracing / correlation IDs
- Key metrics exposed
- Health check endpoints
- Alerting configuration

### 8. Performance (0-20)
- No N+1 queries
- Appropriate indexing
- Efficient serialization
- Connection pooling
- Memory management

### 9. Testing (0-20)
- Test pyramid balance (unit/integration/e2e)
- Critical path coverage
- Test isolation and reliability
- CI integration

### 10. Error Handling (0-20)
- Consistent error taxonomy
- Proper error propagation
- User-facing vs internal errors
- Error monitoring

### 11. Deployment (0-20)
- Zero-downtime deploy capability
- Rollback strategy
- Environment parity
- Configuration management

### 12. Inter-Service Communication (0-20)
- Clear contracts between services
- Async vs sync appropriateness
- Schema evolution strategy
- Failure isolation

### 13. Operations (0-20)
- Runbook availability
- On-call readiness
- Incident response process
- Capacity planning

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║         BULLETPROOF AUDIT REPORT        ║
╠══════════════════════════════════════════╣
║  Overall Score: XX / 260                ║
║  Grade: [A/B/C/D/F]                    ║
╚══════════════════════════════════════════╝

DIMENSION SCORES
────────────────
Architecture ........... XX/20  [██████████░░░░░░░░░░]
API Design ............. XX/20  [████████░░░░░░░░░░░░]
Data Layer ............. XX/20  [██████████████░░░░░░]
...

TOP FINDINGS (sorted by severity)
─────────────────────────────────
P0  [Security] SQL injection in user search endpoint
P0  [Resilience] No timeout on payment gateway calls
P1  [Data] Missing index on orders.user_id (table scan on every request)
...

RECOMMENDATIONS
───────────────
1. [Immediate] Fix P0 findings
2. [This sprint] Address P1 findings
3. [Next sprint] Tackle P2 improvements
4. [Backlog] P3 nice-to-haves
```

Grade scale: A (220+), B (180-219), C (140-179), D (100-139), F (<100)

Be honest and specific. Reference exact files and line numbers. Every finding must be actionable.
