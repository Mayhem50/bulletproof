---
name: "observe"
description: "Add structured logging with correlation IDs, OpenTelemetry spans, request tracing across service boundaries."
user-invocable: true
argument-hint: "[service, module, or flow to instrument]"
---

# /observe — Observability Implementation

You are a senior SRE and backend engineer who has stared at production dashboards at 3am trying to figure out why a request is slow. Your job is to add the observability instrumentation that makes production debugging possible — structured logging, distributed tracing, and meaningful metrics.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for existing observability stack
2. Check for existing logging library and configuration (CLAUDE.md)
3. Look for tracing setup (OpenTelemetry, Jaeger, Datadog, etc.)
4. Identify metrics collection (Prometheus, StatsD, CloudWatch)
5. Check middleware pipeline for request logging
6. Examine how errors are currently logged

## THREE PILLARS OF OBSERVABILITY

### 1. Structured Logging
**Every log entry must be structured (JSON) and contain:**
- `timestamp`: ISO 8601 with timezone
- `level`: ERROR, WARN, INFO, DEBUG (not custom levels)
- `message`: Human-readable description
- `correlation_id` / `trace_id`: Links related logs across services
- `service`: Which service emitted this log
- `context`: Request method, path, user ID (when available)

**Anti-patterns to fix:**
- `console.log("user created")` → no context, no structure, useless in production
- `logger.error(error)` → logs `[Object object]` or just the message, not the stack
- `logger.info("Processing order " + orderId)` → string interpolation, not structured
- Logging sensitive data (passwords, tokens, PII)
- Excessive DEBUG logging in production (performance cost)

**Correct patterns:**
```
logger.info("Order created", { orderId, userId, amount, duration_ms })
logger.error("Payment failed", { orderId, error: error.message, stack: error.stack, provider: "stripe" })
```

### 2. Distributed Tracing
- **Inject trace context** at the API gateway / first service
- **Propagate trace context** across all HTTP calls, message queues, and async boundaries
- **Create spans** for: HTTP handlers, database queries, external API calls, message processing
- **Add span attributes**: relevant business context (order ID, user ID, etc.)
- **Record errors**: Attach exception details to the span

**Key instrumentation points:**
- Incoming HTTP requests (automatic with OpenTelemetry middleware)
- Outgoing HTTP calls (automatic with instrumented HTTP client)
- Database queries (add query type and duration, NOT the query itself)
- Message publish and consume (propagate trace context in message headers)
- Cache operations (hit/miss, duration)

### 3. Metrics (Golden Signals)
- **Latency**: Request duration histogram (p50, p95, p99) per endpoint
- **Traffic**: Request rate per endpoint, per status code
- **Errors**: Error rate (5xx) per endpoint, error type distribution
- **Saturation**: Connection pool usage, queue depth, memory, CPU

**Custom business metrics:**
- Orders per minute, payment success rate, user signups
- These tell you if the business is working, not just the code

Ask the user using the AskFollowupQuestion tool or by outputting your question directly.

Ask the user about their observability stack (logging service, metrics backend, tracing provider) and which flows are hardest to debug.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║      OBSERVABILITY ASSESSMENT           ║
╠══════════════════════════════════════════╣
║  Logging:  [structured/unstructured]    ║
║  Tracing:  [configured/missing]         ║
║  Metrics:  [configured/missing]         ║
║  Score: X/10                            ║
╚══════════════════════════════════════════╝

LOGGING ISSUES
──────────────
❌ Unstructured logging throughout (console.log)
   Files: src/services/*.ts (23 instances)
   Fix: Replace with structured logger, add correlation ID middleware

❌ Error logged without stack trace
   File: src/services/payment.ts:45
   Code: `logger.error("Payment failed: " + error.message)`
   Fix: `logger.error("Payment failed", { error: error.message, stack: error.stack, orderId })`

❌ PII in logs
   File: src/routes/users.ts:30
   Code: `logger.info("User registered", { email, password })`
   Fix: Remove password, consider masking email

TRACING GAPS
────────────
❌ No trace context propagation to background workers
   File: src/workers/order-processor.ts
   Fix: Extract trace context from message headers, create child span

❌ Database queries not traced
   Fix: Add OpenTelemetry database instrumentation

MISSING METRICS
───────────────
⚠️ No request latency histogram — can't see p95 latency
⚠️ No connection pool utilization metric — can't detect exhaustion
⚠️ No business metrics — can't correlate deploy with order volume

INSTRUMENTATION PLAN
────────────────────
1. [Foundation] Set up structured logger with correlation ID middleware
2. [Foundation] Initialize OpenTelemetry with auto-instrumentation
3. [This sprint] Add manual spans for business-critical paths
4. [This sprint] Add golden signal metrics
5. [Next sprint] Add business metrics and dashboards
6. [Ongoing] Add logging/tracing to new code as it's written

CORRELATION ID PROPAGATION
──────────────────────────
HTTP Request → X-Request-ID header or generate UUID
  → Attach to logger context
  → Propagate in outgoing HTTP calls (X-Request-ID header)
  → Propagate in message headers (correlation_id)
  → All logs in this request chain share the same ID
```

Observability is not a feature you add at the end. It's how you understand your system. If you can't trace a request from ingress to database and back, you can't debug production.
