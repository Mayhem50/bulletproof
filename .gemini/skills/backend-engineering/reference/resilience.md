# Backend Resilience Patterns Reference

> Dense reference for implementing resilience in distributed backend systems.
> Intended audience: AI coding agents building or reviewing production services.

---

## 1. Timeouts

### Timeout Types

| Type | What it bounds | Typical range |
|------|---------------|---------------|
| **Connect timeout** | TCP handshake + TLS negotiation | 1-5s (same DC), 5-10s (cross-region) |
| **Read timeout** (socket timeout) | Time waiting for first byte after request sent | Based on p99 latency of downstream |
| **Write timeout** | Time to push request body to server | Rarely needed unless large payloads |
| **Total timeout** (request timeout) | Wall-clock from start to finish, including retries | Hard upper bound on caller patience |

**Rule: always set all three.** An unset timeout is an infinite timeout. Infinite timeouts cause thread/connection pool exhaustion and cascading failures.

### Setting Timeout Values

Formula for read timeout:

```
read_timeout = downstream_p99_latency * safety_multiplier
```

- `safety_multiplier` = 1.5-3x depending on variability
- Example: downstream p99 = 200ms --> read_timeout = 500ms
- Never set read timeout below downstream p50 latency

Formula for total timeout (with retries):

```
total_timeout = read_timeout * max_attempts + (sum of backoff delays)
```

Example:
- read_timeout = 500ms, max_retries = 2, backoff = [0ms, 200ms]
- total_timeout = 500 * 3 + 200 = 1700ms, round up to 2000ms

### Deadline Propagation

When service A calls B calls C, the remaining deadline must propagate:

```
A sets total_timeout = 3000ms
A spends 200ms on local work
A calls B with deadline = 2800ms
B spends 100ms on local work
B calls C with deadline = 2700ms
```

Implementation: pass deadline as absolute timestamp in request header (e.g., `x-deadline` or gRPC built-in deadline). Each hop computes remaining time:

```python
remaining = deadline_timestamp - current_time()
if remaining <= 0:
    return error("deadline exceeded before calling downstream")
downstream_timeout = min(remaining - local_buffer_ms, configured_timeout)
```

**Critical rule:** never start a downstream call if remaining deadline is less than the downstream's expected p50 latency. You will almost certainly time out and waste resources.

### Timeout Budget Calculation Example

Scenario: user-facing API with 5s SLA, calling 3 services sequentially.

```
User SLA:             5000ms
API overhead:          200ms
Service A (p99 300ms): timeout = 800ms  (2.5x safety)
Service B (p99 150ms): timeout = 400ms  (2.5x safety)
Service C (p99 100ms): timeout = 300ms  (3x safety)
Retry budget:         1 retry per service, 200ms backoff each
Total worst case:     200 + (800*2+200) + (400*2+200) + (300*2+200) = 4100ms
Buffer:               900ms remaining -- acceptable
```

If the budget exceeds the SLA, you must either: reduce retries, parallelize calls, or drop safety multipliers.

---

## 2. Retries

### Exponential Backoff Formula

```
delay = min(base_delay * 2^attempt + random_jitter, max_delay)
```

Typical values:
- `base_delay` = 100-500ms
- `max_delay` = 30-60s (for background jobs), 2-5s (for user-facing)
- `attempt` starts at 0

### Jitter Strategies

Without jitter, retries from many clients synchronize and create thundering herds. Three strategies:

**Full Jitter** (recommended for most cases):
```
delay = random(0, min(max_delay, base_delay * 2^attempt))
```
Widest spread. Best at decorrelating clients. Trades some individual latency for system-wide stability.

**Equal Jitter:**
```
half = min(max_delay, base_delay * 2^attempt) / 2
delay = half + random(0, half)
```
Guarantees minimum wait of half the exponential delay. Use when you want some minimum backoff guarantee.

**Decorrelated Jitter** (AWS recommendation):
```
delay = min(max_delay, random(base_delay, previous_delay * 3))
```
Each delay depends on the previous one, not the attempt count. Produces good spread without tracking attempt numbers.

### Retry Budget

Instead of per-request retry limits, cap retries as a percentage of total traffic:

```
retry_ratio = retry_requests / total_requests (over sliding window, e.g., 60s)
allow_retry = retry_ratio < 0.20  # max 20% of traffic can be retries
```

This prevents retry storms during partial outages. When 50% of requests fail, naive 3x retries turn 1000 RPS into 2500 RPS. A 20% retry budget caps it at 1200 RPS.

Implementation: maintain a token bucket or sliding window counter. Increment on every retry attempt, decrement on every original request.

### What to Retry

**Retry:**
- HTTP 500, 502, 503, 504
- Connection refused / connection reset
- Timeouts (connect and read)
- DNS resolution failures (transient)

**Never retry:**
- HTTP 400, 401, 403, 404, 409, 422 -- these won't succeed on retry
- Business logic errors (insufficient funds, validation failure)
- HTTP 429 -- respect the rate limit, use Retry-After header if present
- Requests that are not idempotent (POST without idempotency key)

**Conditionally retry:**
- HTTP 429 with Retry-After header -- retry after the specified delay
- HTTP 503 with Retry-After -- service is temporarily down, honor the delay

### Retry Amplification

In a chain A -> B -> C, if each hop retries 3 times:

```
A retries 3x on B
B retries 3x on C (for each of A's attempts)
Total calls to C = 3 * 3 = 9
```

With 4 service hops each retrying 3x: 3^4 = 81 calls to the leaf service.

**Mitigations:**
1. Only retry at the edge (the outermost caller). Inner services fail fast with no retries.
2. Use retry budgets at each layer.
3. Propagate retry metadata in headers (e.g., `x-retry-count: 2`) so downstream services can shed retried requests under load.
4. Limit total retries across the chain via deadline propagation -- if the deadline is almost expired, don't retry.

---

## 3. Circuit Breakers

### State Machine

```
     success rate OK
     +----------+
     |          |
     v          |
  CLOSED ---[failure threshold exceeded]--> OPEN
     ^                                        |
     |                                        |
     +--[probe succeeds]-- HALF-OPEN <--[reset timeout expires]
                           |
                           +--[probe fails]--> OPEN
```

**CLOSED:** All requests pass through. Failures are counted. When failure rate exceeds threshold within the measurement window, transition to OPEN.

**OPEN:** All requests fail immediately (fast-fail) without calling downstream. After `reset_timeout` expires, transition to HALF-OPEN.

**HALF-OPEN:** Allow a limited number of probe requests through. If they succeed, transition to CLOSED. If any fail, transition back to OPEN.

### Configuration Parameters

| Parameter | Description | Typical value |
|-----------|-------------|---------------|
| `failure_threshold` | Failure rate to trip the breaker | 50% over 10s window |
| `minimum_requests` | Min requests before evaluating rate | 20 (avoid tripping on 1/2 failures) |
| `measurement_window` | Sliding window for failure counting | 10-60s |
| `reset_timeout` | Time in OPEN before probing | 15-60s |
| `half_open_max_requests` | Probes allowed in HALF-OPEN | 3-5 |
| `success_threshold` | Successes needed in HALF-OPEN to close | 3 consecutive |

### What Counts as a Failure

**Count as failure:**
- HTTP 5xx responses
- Timeouts (connect and read)
- Connection errors (refused, reset)

**Do NOT count as failure:**
- HTTP 4xx (client errors -- not the downstream's fault)
- Business logic rejections
- Slow but successful responses (use separate latency monitoring)

### Metrics to Emit

Emit metrics on every state transition for alerting and dashboards:

```
circuit_breaker.state_change{service="payment-api", from="closed", to="open"}
circuit_breaker.state_change{service="payment-api", from="open", to="half_open"}
circuit_breaker.state_change{service="payment-api", from="half_open", to="closed"}
circuit_breaker.state_change{service="payment-api", from="half_open", to="open"}
circuit_breaker.rejected{service="payment-api"}          # incremented on each fast-fail
circuit_breaker.probe_result{service="payment-api", result="success|failure"}
```

Alert on: OPEN transitions (page), sustained OPEN state > 5 minutes (escalate).

### When NOT to Use Circuit Breakers

- **Database connections:** Use connection pool health checks and failover instead. A circuit breaker on your primary DB means your service is down anyway.
- **Internal sidecar/localhost calls:** If the sidecar is down, the service is fundamentally broken. Circuit breaking adds latency without benefit.
- **Single critical dependency with no fallback:** If there is no fallback behavior when the circuit opens, the breaker just adds complexity. You fail either way -- let the timeout handle it.
- **Very low traffic services:** With <1 RPS, the measurement window won't have enough data. Use health checks instead.

---

## 4. Bulkheads

### Thread Pool Isolation vs Semaphore Isolation

**Thread pool isolation:**
- Each dependency gets its own thread pool with fixed size
- Provides true isolation: a hung dependency only exhausts its own pool
- Overhead: context switching, thread creation cost
- Use for: network calls, I/O-bound operations

**Semaphore isolation:**
- Uses a counter (semaphore) to limit concurrent requests to a dependency
- Runs on the caller's thread -- no context switch overhead
- Less isolation: a slow dependency still holds caller threads
- Use for: in-memory operations, very fast calls, when thread overhead matters

Decision: prefer semaphore isolation for calls < 10ms p99. Use thread pool isolation for calls > 10ms p99 or any network call.

### Separate Connection Pools Per Dependency

Never share a single HTTP connection pool across multiple downstream services.

```
# BAD: shared pool
http_client = HttpClient(max_connections=100)
payment_response = http_client.get("payment-service/...")
user_response = http_client.get("user-service/...")

# GOOD: isolated pools
payment_client = HttpClient(max_connections=30, connect_timeout=2s, read_timeout=500ms)
user_client = HttpClient(max_connections=50, connect_timeout=2s, read_timeout=300ms)
notification_client = HttpClient(max_connections=20, connect_timeout=2s, read_timeout=1s)
```

If payment-service hangs, it exhausts only its 30 connections, not all 100.

### Worker Pool Isolation

For async processing, separate workers by priority:

```
critical_queue:      workers=20  (payments, order creation)
standard_queue:      workers=10  (notifications, analytics events)
best_effort_queue:   workers=5   (recommendations, reporting)
```

Under load, critical work continues even if best-effort queues back up.

### Sizing Pool Sizes

**For connection pools:**
```
pool_size = target_throughput * average_latency_seconds
```
Example: 200 RPS to payment-service, 50ms avg latency
```
pool_size = 200 * 0.05 = 10 connections (steady state)
```
Add 2-3x headroom for bursts: 20-30 connections.

**For thread pools:**
- CPU-bound: `pool_size = num_cores`
- I/O-bound: `pool_size = num_cores * (1 + wait_time / compute_time)`
- Example: 8 cores, 200ms wait, 10ms compute: `8 * (1 + 200/10) = 168 threads`
- Cap at practical limits (typically 200-500 threads per JVM).

---

## 5. Fallbacks

### Decision Tree

```
Dependency failed --> Is there a cached response?
  YES --> Is the cache stale but still usable?
    YES --> Return stale data with cache-status header
    NO  --> Is there a static default?
      YES --> Return default
      NO  --> Is the feature non-critical?
        YES --> Hide/degrade the feature
        NO  --> Return error to caller
  NO --> Is this a write operation?
    YES --> Can it be deferred?
      YES --> Queue for async retry
      NO  --> Return error to caller
    NO --> Return error to caller
```

### Stale Cache (Read Path)

Serve stale data when the source of truth is unavailable. Implementation:

```python
def get_product(product_id):
    try:
        product = product_service.get(product_id, timeout=500)
        cache.set(product_id, product, ttl=300)      # 5 min fresh TTL
        cache.set(f"{product_id}:stale", product, ttl=86400)  # 24h stale TTL
        return product
    except (Timeout, ServiceUnavailable):
        stale = cache.get(f"{product_id}:stale")
        if stale:
            log.warn("serving stale product data", product_id=product_id)
            return stale.with_header("x-data-freshness", "stale")
        raise
```

Acceptable for: product catalog, user profiles, configuration, recommendations.
Not acceptable for: account balances, inventory counts, auth tokens.

### Default/Static Values

For non-critical features where stale cache is unavailable:

```python
def get_recommendations(user_id):
    try:
        return recommendation_service.get(user_id)
    except ServiceUnavailable:
        return STATIC_POPULAR_ITEMS  # pre-computed top-20 list
```

### Graceful Degradation (Hide Feature)

Disable entire UI sections when their backing service is down:

```python
def get_product_page(product_id):
    product = product_service.get(product_id)  # critical -- no fallback
    try:
        reviews = review_service.get(product_id)
    except ServiceUnavailable:
        reviews = None  # template renders "Reviews unavailable" or hides section
    try:
        recommendations = rec_service.get(product_id)
    except ServiceUnavailable:
        recommendations = None  # section hidden
    return render(product, reviews, recommendations)
```

### Queue for Async Retry (Write Path)

When a write to a downstream service fails, persist it for later retry:

```python
def record_payment(payment):
    try:
        ledger_service.record(payment)
    except ServiceUnavailable:
        retry_queue.enqueue(
            task="record_payment",
            payload=payment.serialize(),
            max_retries=10,
            backoff="exponential"
        )
        return PaymentResult(status="accepted", processing="async")
```

Requirements: the write must be idempotent. The queue must be durable (not in-memory). Monitor queue depth for alerts.

### Never: Silent Data Corruption

Never swallow a write error and pretend it succeeded. Never return fabricated data that looks real. Always signal degradation to the caller via response metadata, HTTP headers, or explicit status fields.

---

## 6. Backpressure

### Bounded Queues

**Rule: never use an unbounded queue in production.** Unbounded queues convert a latency problem into a memory problem, leading to OOM crashes.

```python
# BAD
queue = Queue()  # unbounded, will grow until OOM

# GOOD
queue = Queue(maxsize=10000)
try:
    queue.put_nowait(item)
except QueueFull:
    metrics.increment("queue.rejected")
    return Response(status=503, body="service overloaded")
```

Sizing the queue: `queue_size = acceptable_latency / processing_time_per_item`. If acceptable latency is 5s and processing is 5ms, queue size = 1000.

### Load Shedding

Reject requests early at the edge rather than letting them propagate through the system and fail deep inside.

**Implementation pattern:**

```python
# Middleware at API gateway / load balancer
def load_shedding_middleware(request):
    current_concurrency = active_requests.value()
    if current_concurrency > MAX_CONCURRENT:
        metrics.increment("load_shedding.rejected")
        return Response(status=503, headers={"Retry-After": "5"})

    active_requests.increment()
    try:
        return handle(request)
    finally:
        active_requests.decrement()
```

Typical `MAX_CONCURRENT` values: 2-5x your normal peak concurrency. Set based on load testing -- find the concurrency at which p99 latency degrades past your SLA, then set the limit below that.

### Adaptive Concurrency Limits (Netflix Pattern)

Instead of a static limit, dynamically adjust based on observed latency:

```
Algorithm (gradient-based):
1. Measure RTT for each request
2. Maintain min_rtt (estimated best-case latency over a window)
3. Calculate gradient = min_rtt / current_rtt
4. Adjust limit:
   new_limit = current_limit * gradient + queue_size
   new_limit = clamp(new_limit, min_limit, max_limit)
```

When latency increases (gradient < 1), the limit decreases. When latency is near baseline (gradient ~ 1), the limit increases. This automatically adapts to changing system capacity.

Libraries: Netflix `concurrency-limits` (Java), `aioconcurrency` (Python), `sentinel` (Go).

### Priority-Based Shedding

When overloaded, shed low-priority work first:

```
Priority levels:
  P0 - Health checks, auth (never shed)
  P1 - Revenue-critical (checkout, payments)
  P2 - Core reads (product pages, search)
  P3 - Nice-to-have (recommendations, analytics)
  P4 - Background (reporting, batch jobs)

Shedding order: P4 first, then P3, then P2. Never shed P0/P1.
```

Implementation: tag each request with priority at the edge. Load shedding middleware checks priority against current load level.

```python
SHEDDING_THRESHOLDS = {
    Priority.P4: 0.70,  # start shedding P4 at 70% capacity
    Priority.P3: 0.85,  # start shedding P3 at 85% capacity
    Priority.P2: 0.95,  # start shedding P2 at 95% capacity
}

def should_shed(request, current_load_ratio):
    threshold = SHEDDING_THRESHOLDS.get(request.priority)
    if threshold and current_load_ratio > threshold:
        return True
    return False
```

### Rate Limiting: Token Bucket vs Sliding Window

**Token bucket:**
- Bucket holds `max_tokens` tokens, refills at `rate` tokens/second
- Each request consumes 1 token. If empty, reject.
- Allows bursts up to `max_tokens` then enforces steady rate.
- Best for: API rate limiting where bursts are acceptable.

```
tokens = min(max_tokens, tokens + rate * elapsed_seconds)
if tokens >= 1:
    tokens -= 1
    allow()
else:
    reject()
```

**Sliding window (log-based):**
- Track timestamp of each request in the window
- Count requests in the last `window_size` seconds
- If count >= limit, reject.
- No burst allowance -- strict enforcement.
- Best for: strict rate enforcement, billing-related limits.

**Sliding window (counter-based, approximate):**
- Keep counters for current and previous window
- Estimate: `count = prev_window_count * overlap_ratio + current_window_count`
- Memory efficient -- only 2 counters per key instead of full log.

---

## 7. Idempotency

### Natural vs Synthetic Idempotency

**Naturally idempotent operations:**
- `SET balance = 500` (absolute value)
- `DELETE FROM orders WHERE id = 123`
- `PUT /users/123 {"name": "Alice"}` (full replacement)
- HTTP GET, HEAD, OPTIONS, DELETE (by spec)

**Not naturally idempotent (need synthetic keys):**
- `UPDATE balance = balance + 50` (relative change)
- `POST /orders` (creates new resource)
- `INSERT INTO ledger (amount) VALUES (50)` (additive)

### Idempotency Key Implementation

Client sends a unique key (UUID v4) with each mutating request:

```
POST /payments
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
Content-Type: application/json

{"amount": 50.00, "currency": "USD", "recipient": "merchant-123"}
```

Server-side flow:

```python
def process_payment(request):
    key = request.headers["Idempotency-Key"]

    # 1. Check if already processed
    existing = db.query(
        "SELECT response_status, response_body FROM idempotency_keys WHERE key = %s",
        key
    )
    if existing:
        return Response(status=existing.response_status, body=existing.response_body)

    # 2. Lock the key (prevent concurrent duplicates)
    try:
        db.execute(
            "INSERT INTO idempotency_keys (key, status, created_at) VALUES (%s, 'processing', NOW())",
            key
        )
    except UniqueViolation:
        return Response(status=409, body="Request is already being processed")

    # 3. Process the request
    try:
        result = payment_service.charge(request.body)
        db.execute(
            "UPDATE idempotency_keys SET status='completed', response_status=%s, response_body=%s WHERE key=%s",
            200, result.serialize(), key
        )
        return Response(status=200, body=result)
    except Exception as e:
        db.execute("DELETE FROM idempotency_keys WHERE key = %s", key)
        raise
```

### Storage Options

**Database (PostgreSQL):**
```sql
CREATE TABLE idempotency_keys (
    key         UUID PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'processing',  -- processing | completed
    response_status INTEGER,
    response_body   JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX idx_idempotency_expires ON idempotency_keys (expires_at);
-- Periodic cleanup: DELETE FROM idempotency_keys WHERE expires_at < NOW();
```

**Redis (for high throughput):**
```python
# Atomic check-and-set with TTL
result = redis.set(f"idempotency:{key}", "processing", nx=True, ex=86400)
if not result:
    cached = redis.get(f"idempotency:{key}")
    if cached == "processing":
        return Response(status=409, body="Request in progress")
    return Response.deserialize(cached)
```

### Response on Duplicate

**Correct:** Return the original response (same status code, same body). The client should not be able to distinguish between the first and subsequent calls.

**Wrong:** Return 409 Conflict or an error. The whole point of idempotency is that retries are transparent.

Exception: if the original request is still in-flight (`status = 'processing'`), return 409 or 429 with `Retry-After: 1` to tell the client to wait.

### Idempotency Window

How long to keep processed keys:

| Use case | Window | Rationale |
|----------|--------|-----------|
| Payment processing | 24-72 hours | Client might retry after network partition heals |
| Order creation | 24 hours | Covers typical user session + retry scenarios |
| API writes (general) | 1-24 hours | Balance storage cost vs retry coverage |
| Event ingestion | 1-7 days | Producers may replay from offset |

Storage cost consideration: at 1M requests/day with 1KB per record, 24h window = ~1GB. Acceptable for Postgres. For higher volumes, use Redis with TTL or a compacting storage backend.

---

## 8. Graceful Degradation Matrix

### Feature Criticality Ranking

Classify every feature and dependency before incidents happen:

| Tier | Label | Definition | Example |
|------|-------|-----------|---------|
| T0 | **Must-have** | Service is useless without it | Auth, core data read/write, checkout |
| T1 | **Should-have** | Major impact if missing, but service still functions | Search, filtering, user preferences |
| T2 | **Nice-to-have** | Enhances experience, not essential | Recommendations, analytics, social proof |
| T3 | **Deferrable** | Can be delayed or dropped entirely | Email notifications, reporting, logging enrichment |

### Degradation Matrix

Map each dependency failure to a concrete degradation behavior:

| Dependency | Tier | If unavailable | User experience | Fallback |
|-----------|------|---------------|-----------------|----------|
| Auth service | T0 | Allow cached sessions (5 min), reject new logins | Logged-in users unaffected short-term | Session cache + static "login unavailable" page |
| Product DB (primary) | T0 | Promote read replica, serve stale reads | Slightly stale data, writes fail | Read replica + queue writes |
| Payment provider | T0 | Queue payment, show "processing" | Delayed confirmation | Durable queue + async retry |
| Search service | T1 | Fall back to DB query (slower) | Slower search, possibly reduced features | Direct DB query with LIMIT |
| Recommendation engine | T2 | Show popular/static items | Less personalized | Pre-computed popular items list |
| Review service | T2 | Hide reviews section | Missing social proof | Cached reviews or hidden section |
| Email service | T3 | Queue for later delivery | Delayed notifications | Durable queue |
| Analytics pipeline | T3 | Drop events silently | No user impact | /dev/null or local buffer to disk |

### User Experience During Degradation

Rules for communicating degradation to users:

1. **Never lie.** Don't show fake data. If reviews are unavailable, hide the section or say "Reviews are temporarily unavailable."
2. **Preserve core flows.** If checkout is possible, keep it working even if recommendations, reviews, and analytics are down.
3. **Indicate staleness.** If showing cached data, consider a subtle indicator: "Prices as of 5 minutes ago" or a `last-updated` timestamp.
4. **Fail clearly on writes.** If a write cannot be processed (even async), tell the user. "Your order is being processed and you'll receive confirmation shortly" is acceptable. Silence is not.
5. **Provide alternatives.** If search is degraded, offer category browsing. If a feature is fully down, link to status page.

### Implementation Pattern: Feature Flags + Circuit Breakers

```python
class DegradationManager:
    def __init__(self):
        self.circuit_breakers = {}   # per-dependency circuit breakers
        self.feature_flags = {}      # manual overrides

    def is_available(self, dependency: str) -> bool:
        # Manual kill switch takes precedence
        if self.feature_flags.get(f"{dependency}.disabled"):
            return False
        # Then check circuit breaker state
        cb = self.circuit_breakers[dependency]
        return cb.state != CircuitState.OPEN

    def get_with_fallback(self, dependency, call_fn, fallback_fn):
        if not self.is_available(dependency):
            return fallback_fn()
        try:
            return self.circuit_breakers[dependency].execute(call_fn)
        except Exception:
            return fallback_fn()
```

---

## Quick Reference: Pattern Selection

| Problem | Primary pattern | Supporting patterns |
|---------|---------------|-------------------|
| Slow dependency | Timeout | Circuit breaker, fallback |
| Flaky dependency (intermittent errors) | Retry with backoff | Idempotency, circuit breaker |
| Dependency fully down | Circuit breaker | Fallback, graceful degradation |
| Cascading failure / overload | Bulkhead | Backpressure, load shedding |
| Thundering herd after recovery | Jittered retry | Adaptive concurrency |
| Duplicate processing | Idempotency | Queue with dedup |
| Memory exhaustion from queuing | Bounded queue | Load shedding, backpressure |
| Uneven load across priorities | Priority shedding | Bulkhead, separate queues |

## Anti-Patterns

1. **Retry without backoff.** Hammering a struggling service guarantees it stays down.
2. **Retry non-idempotent operations.** Double-charging a customer, double-creating an order.
3. **Unbounded queues.** Converts latency problems into OOM crashes.
4. **Circuit breaker on the only path.** If there is no fallback, the breaker just adds complexity.
5. **Timeout higher than caller's timeout.** The caller gives up before you do, wasting resources.
6. **Shared connection pool for all dependencies.** One slow service exhausts connections for all.
7. **Catching and swallowing errors silently.** Hides failures until they cascade.
8. **Retry at every layer.** 3 retries * 3 retries * 3 retries = 27x amplification.
9. **Static concurrency limits.** Capacity changes with deployments, time of day, and load. Use adaptive limits.
10. **No metrics on resilience mechanisms.** If you can't see circuit breaker trips, retry rates, and shed requests, you're flying blind.
