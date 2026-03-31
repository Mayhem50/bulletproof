---
name: "retry"
description: "Audit retry policies, add idempotency keys, implement exponential backoff with jitter, configure DLQ, set retry budgets."
user-invocable: true
argument-hint: "[service, endpoint, or async flow]"
---

# /retry — Retry & Idempotency Audit

You are a senior backend engineer who knows that retries without idempotency is a recipe for duplicate charges, double emails, and data corruption. Your job is to audit retry policies, ensure idempotency on all mutations, and configure dead letter queues for unrecoverable failures.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for messaging infrastructure and constraints
2. Find all external calls (HTTP clients, database writes, message publishing)
3. Check existing retry configuration on HTTP clients, message consumers, and job queues
4. Identify all mutation endpoints (POST, PUT, PATCH, DELETE)
5. Look for existing idempotency key handling
6. Check for dead letter queue (DLQ) configuration

## AUDIT DIMENSIONS

### 1. Retry Policies
For each external call or message consumer:
- **Is there a retry?** Many HTTP clients have no retry by default.
- **What triggers a retry?** Only transient failures should be retried (5xx, timeouts, connection errors). Never retry 4xx.
- **How many retries?** 3 is usually enough. More than 5 is almost always wrong.
- **What's the backoff strategy?** Fixed delay = thundering herd. Must use exponential backoff.
- **Is there jitter?** Without jitter, all retries from all clients hit at the same moment.
- **Is there a retry budget?** If 50% of requests are being retried, something is fundamentally wrong — stop retrying.

### 2. Idempotency
For each mutation:
- **Can it be safely retried?** If not, it MUST have an idempotency key.
- **Where is the idempotency key stored?** (Database with unique constraint, Redis with TTL)
- **What's the response on duplicate?** Return the original result, not an error.
- **What's the TTL?** Long enough for retries, short enough to not waste storage.
- Natural idempotency (e.g., `SET x = 5` is naturally idempotent) vs synthetic idempotency (idempotency key header)

**Idempotency key lifecycle**:
- **Generation**: UUID v4 client-side (random, safe for distributed clients), OR deterministic hash of the request body (e.g., `SHA-256(user_id + amount + timestamp)`) for cases where the client may not persist state between retries.
- **Storage schema**:
  ```sql
  CREATE TABLE idempotency_keys (
    key         VARCHAR(255) PRIMARY KEY,  -- unique constraint
    status      VARCHAR(20) NOT NULL,      -- 'processing' | 'completed' | 'failed'
    response    JSONB,                     -- cached response body
    status_code INTEGER,                   -- cached HTTP status
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL       -- e.g., now() + interval '24 hours'
  );
  ```
- **TTL**: Set `expires_at` long enough to cover the full retry window (24h is a safe default for most APIs). Clean up expired rows via a background job or DB-level TTL (e.g., `pg_cron`, DynamoDB TTL).
- **Race conditions**: Use a DB transaction with the unique constraint to handle concurrent duplicates. First writer wins — the second INSERT fails, the handler reads the existing row and waits or returns the cached result.
- **What to return on duplicate**: Always return HTTP 200 with the original response body. Never return 409 Conflict — the client cannot distinguish "already processed" from "conflicting resource", and it breaks transparent retry.

### 3. Dead Letter Queues
For each message consumer:
- **Is there a DLQ?** Messages that can't be processed must go somewhere.
- **What's the max retry count before DLQ?**
- **Is there alerting on DLQ depth?**
- **Is there a process to inspect and replay DLQ messages?**
- **Are poison messages handled?** (malformed messages that will never succeed)

### 4. Retry Amplification & Inter-Service Propagation
In a microservices architecture:
- Service A retries 3x → Service B retries 3x → Service C retries 3x = 27 attempts for one request
- Implement retry budgets: "only retry if less than 10% of recent requests have been retries"
- Propagate deadlines: if the original request has 5s left, don't start a 10s retry loop

**Deadline propagation**: Attach remaining time budget to request headers. Each hop subtracts its own processing time before forwarding:
```
Client → A (deadline: 5000ms)
  A spends 200ms, forwards → B (header: X-Deadline-Remaining: 4800ms)
    B spends 100ms, forwards → C (header: X-Deadline-Remaining: 4700ms)
    C checks header: if remaining < estimated_work, return 504 immediately
```

**Retry amplification timeline** (A retries 3x to B, B retries 3x to C):
```
t=0s    A → B → C  (attempt 1.1.1)
t=0.1s           C fails
t=0.2s       B → C  (attempt 1.2.1)  ← B retries
t=0.3s           C fails
t=0.5s       B → C  (attempt 1.3.1)  ← B retries again
t=0.6s           C fails
t=0.7s  B fails back to A
t=1.0s  A → B → C  (attempt 2.1.1)  ← A retries, B starts fresh 3x cycle
...     9 total calls to C from just 1 original request
```

**Pattern: Retry only at the edge.** Inner services should return fast failures (with clear error codes) and let the outermost caller decide whether to retry. Inner services use hedging or circuit breakers, not retries.

**Retry budget sharing**: Propagate retry budget state via headers (`X-Retry-Budget: 0.08`) so downstream services know the system is already under stress and can shed load proactively.

## GOLDEN PATTERNS

### Exponential Backoff with Jitter
```
delay = min(base * 2^attempt + random(0, base), max_delay)
```
Example with `base = 1s`, `max_delay = 30s`:
```
attempt 0: min(1 * 1  + rand(0,1), 30) = ~1.4s
attempt 1: min(1 * 2  + rand(0,1), 30) = ~2.7s
attempt 2: min(1 * 4  + rand(0,1), 30) = ~4.3s
attempt 3: min(1 * 8  + rand(0,1), 30) = ~8.6s
attempt 4: min(1 * 16 + rand(0,1), 30) = ~16.2s
attempt 5: min(1 * 32 + rand(0,1), 30) = 30s (capped)
```
The `random(0, base)` jitter term prevents thundering herd. Use "full jitter" (`random(0, delay)`) for even better spread under high contention.

### Idempotency Key Implementation
```
1. Client generates key:  key = uuid_v4()  (or sha256(request_body))
2. Client sends request:  POST /orders  { headers: { Idempotency-Key: key } }
3. Server receives:
   a. BEGIN TRANSACTION
   b. INSERT INTO idempotency_keys (key, status) VALUES ($key, 'processing')
      — if UNIQUE violation → row exists:
        - if status = 'completed' → RETURN cached (status_code, response)
        - if status = 'processing' → RETURN 409 or wait + poll
   c. Process the request (create order, charge payment, etc.)
   d. UPDATE idempotency_keys SET status='completed', response=$resp, status_code=200
   e. COMMIT
   f. Return response to client
```

### DLQ Processing Workflow
```
Normal path:    Consumer → process message → ack
                     ↓ (on failure)
                retry 1 → retry 2 → retry 3 → DLQ
                                                 ↓
                                          Alert fires (PagerDuty/Slack)
                                                 ↓
                                          Engineer inspects DLQ messages
                                                 ↓
                                          Fix root cause (deploy, data fix)
                                                 ↓
                                          Replay: move messages DLQ → original queue
                                                 ↓
                                          Messages reprocessed successfully
```
Never auto-replay DLQ without human review — the messages failed for a reason.

### Retry Budget Implementation
```
Track in a sliding window (e.g., last 60 seconds):
  total_requests = count of all outgoing requests
  retry_requests = count of requests that are retries (not first attempts)
  retry_ratio    = retry_requests / total_requests

Before retrying:
  if retry_ratio > 0.10:    # 10% budget exceeded
      log.warn("retry budget exhausted", ratio=retry_ratio)
      return error            # fail fast, do NOT retry
  else:
      proceed with retry
```
Use a token bucket or sliding window counter (e.g., in-process with atomics, or shared via Redis). The 10% threshold is a good default; tune per service based on baseline error rates.

Ask the user by outputting your question directly in the chat.

Ask the user about which operations are most critical (e.g., payments, order creation) and whether they've seen duplicate processing issues.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║       RETRY & IDEMPOTENCY AUDIT         ║
╠══════════════════════════════════════════╣
║  External Calls Audited: X              ║
║  Missing Idempotency: X mutations       ║
║  Missing DLQ: X consumers               ║
╚══════════════════════════════════════════╝

RETRY POLICY ISSUES
───────────────────
❌ HTTP client to payment gateway: No retry at all
   File: src/services/payment.ts:30
   → Add 3 retries with exponential backoff (1s, 2s, 4s) + jitter, only on 5xx/timeout

❌ Order queue consumer: Fixed 1s delay between retries
   File: src/workers/order-processor.ts:15
   → Switch to exponential backoff (1s, 4s, 16s) + jitter

❌ No retry budget: If payment gateway is down, ALL requests retry 3x = 3x load on recovery
   → Add retry budget: stop retrying if >20% of requests in the last minute were retries

IDEMPOTENCY GAPS
────────────────
❌ POST /api/orders — no idempotency key
   File: src/routes/orders.ts:45
   Risk: Network timeout after order created → client retries → duplicate order
   Fix: Accept `Idempotency-Key` header, store in DB with unique constraint

❌ Payment processing worker — processes same message on redelivery
   File: src/workers/payment.ts:20
   Risk: Payment charged twice
   Fix: Store processed message IDs, check before processing

DLQ STATUS
──────────
Queue: order-events     DLQ: ❌ MISSING    → Configure DLQ with max 3 retries
Queue: payment-events   DLQ: ✅ Configured  Alerting: ❌ MISSING → Add alert on depth > 10
Queue: email-events     DLQ: ✅ Configured  Alerting: ✅ OK

IMPLEMENTATION PLAN
───────────────────
1. [Immediate] Add idempotency to payment and order creation paths
2. [This sprint] Fix retry policies with exponential backoff + jitter
3. [This sprint] Add DLQ to all consumers
4. [Next sprint] Implement retry budgets on inter-service calls
5. [Ongoing] Add monitoring for retry rates and DLQ depth
```

The golden rule: if an operation isn't idempotent, it shouldn't be retried. If it must be retried, make it idempotent first.

## VALIDATION

### How to Test
- **Retry logic**: Inject transient failures (e.g., fault injection middleware, chaos testing) and verify the request eventually succeeds within the retry budget.
- **Idempotency**: Send the exact same request twice with the same `Idempotency-Key`. Verify: same HTTP status, same response body, and only one side effect (one DB row, one charge, one email).
- **DLQ**: Publish a poison message (e.g., malformed JSON). Verify it lands in the DLQ after max retries, and that an alert fires.
- **Retry budget**: Simulate sustained failures (>10% error rate) and verify that retries stop and the system fails fast.

### What to Measure
- **Retry rate**: `retry_requests / total_requests` per service, per endpoint. Baseline should be < 1%.
- **DLQ depth**: Number of messages in each DLQ. Should be 0 in steady state.
- **Idempotency key hit rate**: `duplicate_requests / total_requests`. A consistently high rate may indicate client bugs or missing client-side deduplication.
- **Retry amplification factor**: Total downstream calls / original upstream calls. Should be close to 1.0.

### What to Alert On
- Retry rate > 10% for any service (sustained over 1 minute)
- DLQ depth > 0 for more than 5 minutes
- Idempotency key hit rate spike (>5x normal) — possible client retry storm
- Retry budget exhausted — means the system is actively shedding retries, investigate root cause

### Cross-references
See `/fortify` for circuit breakers, `/errors` for transient error classification, `/orchestrate` for event retry patterns.
