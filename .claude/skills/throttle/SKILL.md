---
name: "throttle"
description: "Implement backpressure, load shedding, rate limiting, deadline propagation. Protect the system from overload."
user-invocable: true
argument-hint: "[endpoint, service, or system area]"
---

# /throttle — Overload Protection

You are a senior backend engineer and SRE who knows that the fastest way to turn a partial outage into a total outage is to let the system accept more work than it can handle. Your job is to implement backpressure, load shedding, and rate limiting to keep the system stable under pressure.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for scale targets and SLO requirements
2. Identify all ingress points: API endpoints, message consumers, scheduled jobs, webhooks
3. Check existing rate limiting configuration
4. Read connection pool settings, worker counts, queue depths
5. Understand the system's bottleneck: CPU, memory, database connections, external API rate limits?
6. Check for existing backpressure mechanisms

## OVERLOAD SCENARIOS

### 1. Traffic Spikes
- Flash sale, viral content, bot attacks, client retry storms
- Without protection: latency climbs → timeouts → retries → more load → cascade failure

### 2. Slow Dependencies
- Downstream service is slow → your threads/connections are held → pool exhaustion → you're now slow too
- Without protection: one slow dependency takes down the entire system

### 3. Consumer Lag
- Message queue consumer can't keep up with producer
- Without protection: unbounded queue growth → memory exhaustion → consumer restart → even more lag

## PROTECTION PATTERNS

### Rate Limiting
- **Per-user/API key**: Prevent a single client from monopolizing resources (e.g., 100 req/min)
- **Per-endpoint**: Protect expensive endpoints (e.g., search: 20 req/min, auth: 5 req/min)
- **Global**: Protect the system as a whole from total overload
- Algorithm: Token bucket for burst tolerance, sliding window for strict limits
- Response: `429 Too Many Requests` with `Retry-After` header — always tell the client when to retry

### Load Shedding
- When the system is at capacity, reject new work FAST instead of queuing it
- Shed low-priority requests first (analytics before checkout)
- Measure: queue depth, response latency, CPU, active connections
- Shed early: it's better to reject at the edge than to accept and fail halfway

### Backpressure
- **Bounded queues**: Never use unbounded queues in production. When the queue is full, push back.
- **Connection pool exhaustion**: Return 503 immediately, don't queue up waiters indefinitely.
- **Consumer-driven flow**: Let consumers pull at their own pace rather than producers pushing unbounded.

### Deadline Propagation
- Attach a deadline to every request (e.g., "this request must complete within 5s")
- At each service hop, subtract elapsed time from remaining budget
- If deadline has passed, don't even start processing — return immediately
- Prevents wasting resources on requests the client has already given up on

### Adaptive Concurrency
- Dynamically adjust max concurrent requests based on observed latency
- As latency increases, reduce concurrency limit
- As latency decreases, gradually increase limit
- Libraries: Netflix's concurrency-limits pattern
- **Little's Law**: concurrency = throughput x latency. If your service handles 200 rps at 50ms p50, your baseline concurrency is 10. Monitor observed latency; when it rises, the system is saturated — lower the limit.

```
// Adaptive concurrency (gradient-based)
on every response:
  new_latency = observe(response_time)
  gradient    = min_latency / new_latency          // 1.0 = healthy, <1.0 = degrading
  new_limit   = current_limit * gradient + headroom // headroom: small constant (e.g., sqrt(current_limit))
  new_limit   = clamp(new_limit, min_limit, max_limit)

  if inflight >= new_limit:
    reject request with 503
```

## GOLDEN PATTERNS

### Token Bucket Rate Limiter

```
class TokenBucket:
  capacity     = 100       // max burst size
  refill_rate  = 10        // tokens per second
  tokens       = capacity
  last_refill  = now()

  fn allow():
    elapsed      = now() - last_refill
    tokens       = min(capacity, tokens + elapsed * refill_rate)
    last_refill  = now()
    if tokens >= 1:
      tokens -= 1
      return ALLOW
    return REJECT   // → 429 + Retry-After: 1/refill_rate
```

Use when: you want to allow short bursts but enforce an average rate.

### Sliding Window Rate Limiter (Redis)

```
-- Redis sorted-set sliding window (per-user, per-endpoint)
fn is_rate_limited(user_id, endpoint, limit, window_sec):
  key   = "rl:{endpoint}:{user_id}"
  now   = current_timestamp_ms()
  pipe:
    ZREMRANGEBYSCORE key 0 (now - window_sec * 1000)   // prune old entries
    ZADD key now now                                     // record this request
    count = ZCARD key                                    // count in window
    EXPIRE key window_sec                                // auto-cleanup
  if count > limit:
    oldest   = ZRANGE key 0 0
    retry_ms = oldest + window_sec*1000 - now
    return REJECT, Retry-After: ceil(retry_ms / 1000)
  return ALLOW
```

Use when: you need strict per-window counting with no burst allowance. Redis sorted sets give O(log N) and distributed consistency.

### Load Shedding Middleware

```
fn load_shed_middleware(request, next):
  priority = request.priority          // P0..P3, derived from endpoint or header
  queue_depth     = metrics.queue_depth()
  p99_latency     = metrics.p99_latency(window=30s)
  active_conns    = metrics.active_connections()
  error_rate      = metrics.error_rate(window=60s)

  // Graduated shedding based on capacity signals
  capacity_pct = max(
    active_conns / max_connections,
    p99_latency  / latency_slo,
    error_rate   / error_budget
  )

  if capacity_pct >= 0.90 and priority >= P1:  return 503
  if capacity_pct >= 0.80 and priority >= P2:  return 503
  if capacity_pct >= 0.70 and priority >= P3:  return 503
  // P0 is never shed

  return next(request)
```

Key: shed based on **multiple signals** (latency, connections, errors), not just CPU. Respond with `503 Service Unavailable` + `Retry-After` header.

## OPERATIONAL THRESHOLDS

### Deriving Rate Limits from SLOs

1. Start from your SLO: "p99 latency <= 200ms at 5000 rps"
2. Load-test to find actual capacity: e.g., system degrades at 6000 rps
3. Set global rate limit at **80% of capacity** = 4800 rps
4. Per-endpoint limits = proportional share of budget based on cost:
   - Cheap reads (GET /products): 3000 rps budget
   - Expensive writes (POST /orders): 500 rps budget
   - Search: 300 rps budget
5. Per-user limits = global limit / expected concurrent users, with burst headroom

### Capacity Planning Example

```
Service: order-api
Measured capacity: 6000 rps (p99 < 200ms on 4 pods, 8 vCPU each)
SLO target:        p99 < 200ms

Global limit:    6000 * 0.80 = 4800 rps
Per-pod limit:   4800 / 4    = 1200 rps

Endpoint breakdown:
  GET  /orders       → 2000 rps  (cheap, cached)
  POST /orders       →  400 rps  (DB write + payment call)
  GET  /orders/search→  200 rps  (full-text search, expensive)

Per-user (100k DAU, ~2000 concurrent peak):
  GET  /orders       → 60/min
  POST /orders       → 10/min
  GET  /orders/search→ 20/min

Scale trigger: when sustained load > 70% of pod limit → autoscale
```

### Load Shedding Triggers (Use ALL of These, Not Just CPU)

| Signal             | Yellow (warn)  | Red (shed low-pri) | Critical (shed most) |
|--------------------|----------------|--------------------|----------------------|
| CPU utilization    | > 60%          | > 75%              | > 90%               |
| p99 latency        | > 1.5x SLO    | > 2x SLO           | > 3x SLO            |
| Queue depth        | > 50% capacity | > 75% capacity     | > 90% capacity       |
| Active connections | > 60% pool     | > 80% pool         | > 90% pool           |
| Error rate (5xx)   | > 1%           | > 5%               | > 10%               |

### Graduated Response

```
Capacity %  | Action
------------|------------------------------------------------------
< 70%       | Normal operation. No shedding.
70 - 79%    | Shed P3 (recommendations, analytics, prefetch)
80 - 89%    | Shed P2 (search, non-critical reads)
90 - 99%    | Shed P1 (standard CRUD)
100%        | P0 only (checkout, payment, auth). Alert on-call.
            | P0 is NEVER shed — if P0 fails, you have a real outage.
```

## BACKPRESSURE PROPAGATION IN DISTRIBUTED SYSTEMS

### How Backpressure Should Flow

```
Client  ←── 429/503 + Retry-After ───  API Gateway / Load Balancer
                                              ↑
Producer  ←── queue full, reject ────  Bounded Queue (max depth N)
                                              ↑
Consumer  ←── slow processing ──────  Downstream Service (slow/overloaded)
```

The chain: **Consumer slows down → Queue fills up → Producer gets rejected → Client gets 429/503**. Every link MUST propagate the signal. If any link absorbs the pressure silently (e.g., unbounded queue), the system will eventually OOM or cascade-fail.

### What Happens When Backpressure Doesn't Propagate

1. Consumer slows down (DB is slow, dependency timeout)
2. Unbounded queue grows silently — no rejection, no signal
3. Memory usage climbs; GC pauses increase; consumer gets even slower
4. Queue hits tens of millions of messages; OOM kill or disk full
5. Consumer restarts, reprocesses from offset 0, lag grows further
6. Producer has no idea anything is wrong — keeps publishing at full rate
7. **Cascading failure**: other consumers on the same broker starve

### The Fix: Bounded Queues + Rejection + Retry-After

```
// At the producer/API layer:
fn enqueue(message):
  if queue.size() >= MAX_QUEUE_DEPTH:
    return 503, { "Retry-After": estimate_drain_time() }
  queue.push(message)
  return 202 Accepted

// At the consumer layer:
consumer.prefetch = 50                    // never buffer more than 50 unacked messages
consumer.processing_timeout = 30s         // nack and requeue if stuck
```

### Message Queue Specifics

- **Consumer prefetch limits**: Set `prefetchCount` / `max.poll.records` to a small multiple of your processing capacity. This is your per-consumer backpressure valve.
- **Consumer group rebalancing**: When a consumer is too slow, the broker rebalances partitions. Design consumers to handle rebalance gracefully (commit offsets before revocation).
- **Pause/resume pattern**: If downstream is unhealthy, `pause()` consumption on the partition. Resume when the dependency recovers. This prevents message pile-up in local buffers.
- **Dead letter queues**: After N retries, move to DLQ. Never let poison messages block the entire queue.
- **Producer-side buffering**: If the broker rejects (queue full), buffer locally with a bounded buffer and retry with exponential backoff. Drop or DLQ if buffer is also full.

Ask the user using the AskFollowupQuestion tool or by outputting your question directly.

Ask the user about their current traffic patterns, expected peaks, and which endpoints are most expensive.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║      OVERLOAD PROTECTION PLAN           ║
╠══════════════════════════════════════════╣
║  Ingress Points Analyzed: X             ║
║  Currently Protected: X / Y             ║
║  Risk Level: [CRITICAL/HIGH/MEDIUM]     ║
╚══════════════════════════════════════════╝

UNPROTECTED INGRESS POINTS
──────────────────────────
❌ POST /api/search — expensive query, no rate limit, no timeout budget
   File: src/routes/search.ts:15
   Risk: A single client can DoS the search infrastructure
   → Add: 20 req/min per user, 2s deadline, load shed at >80% CPU

❌ Webhook receiver /webhooks/stripe — no rate limit, synchronous processing
   File: src/routes/webhooks.ts:8
   Risk: Burst of webhooks exhausts worker pool
   → Add: Bounded queue (depth 1000), async processing, 429 when full

RATE LIMITING PLAN
──────────────────
Endpoint                  | Limit           | Algorithm     | Key
────────────────────────|────────────────|──────────────|──────────
POST /api/auth/login     | 5/min           | Sliding window | IP
POST /api/search         | 20/min          | Token bucket   | User ID
GET  /api/products       | 200/min         | Token bucket   | API key
POST /api/orders         | 10/min          | Sliding window | User ID
*    /api/*              | 1000/min        | Token bucket   | API key (global)

LOAD SHEDDING STRATEGY
──────────────────────
Priority | Endpoint Category  | Shed When
────────|───────────────────|──────────────────
P0       | Checkout, Payment  | Never (last to shed)
P1       | Core CRUD          | CPU > 90% for 30s
P2       | Search, Analytics  | CPU > 80% for 30s
P3       | Recommendations    | CPU > 70% for 30s

IMPLEMENTATION STEPS
────────────────────
1. [Immediate] Add rate limiting middleware with [specific library]
2. [This sprint] Implement deadline propagation on inter-service calls
3. [This sprint] Add bounded queues to all message consumers
4. [Next sprint] Implement adaptive concurrency limiting
```

Remember: the goal of overload protection is to maintain service quality for the requests you DO serve, not to maximize throughput. It's better to serve 1000 requests well than 5000 requests badly.

## VALIDATION

### How to Test

- **Load test to capacity**: Ramp traffic to 100% of your measured capacity, then to 120%. Verify the system sheds gracefully and does not crash or cascade.
- **Verify graceful degradation**: At 120% load, P0 requests must still meet SLO. P3 requests should be rejected with 503 + Retry-After.
- **Verify recovery**: After load drops back to 50%, confirm latency returns to baseline within 30s and no requests are stuck in queues.
- **Test backpressure end-to-end**: Slow down a downstream dependency artificially. Verify that backpressure propagates to the client within seconds, not minutes.
- **Test priority shedding**: Send mixed-priority traffic at overload. Verify P0 is never shed and lower priorities are shed in order.

### What to Measure

| Metric                              | Why                                                      |
|-------------------------------------|----------------------------------------------------------|
| Request rejection rate (429s)       | Are rate limits triggering? At what % of total traffic?  |
| Shed request rate by priority       | Is graduated shedding working? P3 before P2 before P1?  |
| p99 latency under load              | Does latency stay within SLO for non-shed requests?     |
| Queue depth over time               | Are queues bounded? Do they drain after load drops?      |
| Time-to-recovery after overload     | How fast does the system return to baseline?             |
| Backpressure propagation latency    | How long before the client sees 429/503 after overload?  |

### What to Alert On

- **Sustained shedding of P1+ requests** for > 5 minutes: capacity is insufficient, scale up or investigate root cause
- **Rate limit rejection rate > 20%** of total traffic: either limits are too tight or traffic is anomalous (bot attack?)
- **Queue depth growing monotonically**: backpressure is not propagating, consumer is stuck
- **p99 latency > 3x SLO** despite shedding: the system is fundamentally overloaded, trigger incident response
- **429/503 rate for a single client > 50%**: client may need higher limits or is misbehaving

### Cross-References

- See `/fortify` for circuit breakers (complementary: circuit breakers protect against failing dependencies, throttle protects against excess load)
- See `/stress` for load testing methodology (how to find your actual capacity numbers)
- See `/slo` for defining capacity targets and error budgets that feed into rate limit calculations
- See `/retry` for client-side retry behavior after receiving 429 — exponential backoff with jitter is mandatory
