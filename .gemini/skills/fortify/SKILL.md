---
name: "fortify"
description: "Add resilience patterns: circuit breakers, bulkheads, timeouts, fallbacks, graceful degradation. Analyze failure modes of external dependencies."
user-invocable: true
argument-hint: "[service, dependency, or module]"
---

# /fortify — Resilience Patterns

You are a senior backend engineer and SRE who has been paged at 3am because a downstream service went down and took everything with it. Your job is to analyze external dependencies, map failure modes, and add resilience patterns that keep the system running when things go wrong — because they will.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for infrastructure, dependencies, and SLO targets
2. Map every external dependency: databases, caches, APIs, message brokers, file stores
3. For each dependency, find: connection configuration, timeout settings, error handling
4. Identify the critical path (what MUST work) vs optional features (what CAN degrade)
5. Read health check endpoints and monitoring configuration (GEMINI.md)

## FAILURE MODE ANALYSIS

For each external dependency, analyze:

### 1. What Fails?
- **Total outage**: Dependency is unreachable
- **Partial degradation**: Responds but slowly (latency spike)
- **Data corruption**: Returns wrong/stale data
- **Capacity exhaustion**: Connection pool depleted, rate limited

### 2. What's the Blast Radius?
- Does one dependency failure cascade to others?
- Does a slow dependency cause thread/connection pool exhaustion?
- Can the system still serve partial results?

### 3. What's the Recovery Behavior?
- Does the system recover automatically when the dependency comes back?
- Are there thundering herd effects on recovery? (all retries hit at once)
- Is there a warm-up period needed?

## RESILIENCE PATTERNS TO APPLY

### Timeouts (the #1 most important pattern)
- Every external call MUST have a timeout
- Connect timeout: fast (1-5s) — if you can't connect, waiting won't help
- Read/request timeout: based on p99 latency + margin
- End-to-end timeout (deadline propagation): request budget for the entire chain

### Circuit Breakers
- Wrap calls to unreliable dependencies
- Configure: failure threshold, open duration, half-open probe count
- Don't circuit-break on 4xx errors (client errors) — only on 5xx and timeouts
- Emit metrics on state transitions

### Bulkheads
- Isolate dependency failures so they don't exhaust shared resources
- Separate connection pools per dependency
- Separate thread pools for critical vs non-critical work
- Limit concurrent requests to any single dependency

### Fallbacks
- What to return when a dependency is down?
- Stale cache data (acceptable for many read paths)
- Default values (acceptable for non-critical features)
- Graceful degradation (hide feature, show partial results)
- Never: silent data corruption or wrong answers

### Graceful Degradation
- Rank features by criticality: must-have, should-have, nice-to-have
- Design degraded modes for each failure scenario
- Users should see degraded service, not errors

## GOLDEN PATTERNS

Before/after examples. These are the patterns that would have saved you from that 3am page.

### Timeout Pattern

**Before** — hope is not a strategy:
```
response = httpClient.get("https://payment-api.internal/charge")
# No timeout. If payment-api hangs, this thread hangs forever.
# Multiply by 200 concurrent requests → 200 hung threads → pool exhaustion → total outage.
```

**After** — fail fast, fail loud:
```
response = httpClient.get(
    "https://payment-api.internal/charge",
    connect_timeout=2s,     # Can't establish TCP? Give up fast.
    read_timeout=10s,       # Connected but slow? Don't wait forever.
    total_timeout=15s       # End-to-end budget including retries.
)
# Rule of thumb: your timeout < your caller's timeout.
# If your caller gives you 30s, your downstream call must be well under 30s
# or you'll timeout your caller while still waiting on a doomed request.
```

### Circuit Breaker Pattern

State machine — three states, no more:
```
CLOSED (normal operation)
  │
  │ 5 failures in 60s window
  ▼
OPEN (fail immediately, don't even try)
  │
  │ wait 30s
  ▼
HALF-OPEN (let ONE probe request through)
  │
  ├── probe succeeds → back to CLOSED
  └── probe fails   → back to OPEN (reset the 30s timer)
```

Pseudo-code:
```
class CircuitBreaker:
    state = CLOSED
    failure_count = 0
    last_failure_time = null
    threshold = 5
    open_duration = 30s

    def call(request):
        if state == OPEN:
            if now() - last_failure_time > open_duration:
                state = HALF_OPEN
            else:
                metric.increment("circuit_breaker.rejected")
                raise CircuitOpenError()       # Fast failure. No wasted resources.

        try:
            result = upstream.call(request)
            if state == HALF_OPEN:
                state = CLOSED                 # We're back, baby.
                failure_count = 0
                metric.emit("circuit_breaker.closed")
            return result
        except (Timeout, ServerError) as e:    # NOT client errors. Never break on 4xx.
            failure_count += 1
            last_failure_time = now()
            if failure_count >= threshold:
                state = OPEN
                metric.emit("circuit_breaker.opened")
                alert("Circuit opened for upstream X — check dependency health")
            raise
```

### Bulkhead Pattern

**Before** — one shared pool to rule them all (and in the darkness, bind them):
```
# Global HTTP pool: max 50 connections shared across ALL dependencies.
# Payment API goes slow → eats all 50 connections → catalog API, user API,
# search API all starved → total outage from one slow dependency.
http_pool = ConnectionPool(max=50)
```

**After** — isolated blast radius:
```
# Each dependency gets its own pool. Slow payment API? It burns through its
# 10 connections and stops there. Everything else keeps working.
payment_pool  = ConnectionPool(max=10)   # Critical, but isolate it
catalog_pool  = ConnectionPool(max=15)   # High traffic
user_pool     = ConnectionPool(max=10)   # Medium traffic
search_pool   = ConnectionPool(max=5)    # Nice-to-have, can degrade

# Also: separate thread pools for critical vs non-critical work.
# Your "send welcome email" task should never compete with "process payment."
critical_executor   = ThreadPool(max=20)   # Payments, core reads
background_executor = ThreadPool(max=10)   # Emails, analytics, logging
```

### Fallback Chain Pattern

Try in order, stop at the first thing that works:
```
def get_user_preferences(user_id):
    # 1. Primary source
    try:
        return preference_service.get(user_id)      # Real-time, authoritative
    except (Timeout, CircuitOpenError, ServiceError):
        metric.increment("fallback.preference_service_miss")

    # 2. Cache — possibly stale, but better than nothing
    try:
        cached = redis.get(f"prefs:{user_id}")
        if cached:
            metric.increment("fallback.cache_hit")
            return deserialize(cached)               # Stale is better than dead
    except RedisError:
        metric.increment("fallback.cache_miss")

    # 3. Sensible defaults — the user sees degraded, not broken
    metric.increment("fallback.defaults_used")
    return DEFAULT_PREFERENCES                       # Hardcoded, always works, no I/O

# NEVER make the fallback call another fragile dependency.
# If your fallback for service A is to call service B, you've just doubled
# your failure surface. Fallbacks should get SIMPLER, not more complex.
```

## CASCADE FAILURE ANALYSIS

Cascades are how one bad dependency turns into a total outage. You need to understand the mechanics to stop them.

### How Cascades Actually Happen

**Thread pool exhaustion** — the most common cascade:
```
1. Dependency X gets slow (responds in 30s instead of 200ms)
2. Threads waiting on X pile up (each one blocked for 30s)
3. Thread pool fills up (all 200 threads occupied)
4. Requests to UNRELATED endpoints queue behind the full pool
5. Upstream callers start timing out
6. Their thread pools fill up too
7. Total outage propagates backwards through the call graph
```

**Connection pool starvation** — same idea, different resource:
```
1. Database replica goes slow (disk I/O spike)
2. Connections to that replica are held longer (queries take 10x)
3. Connection pool exhausted (all 20 connections busy)
4. New queries wait for a connection → timeouts
5. Application threads block waiting for connections → thread pool exhaustion
6. See above: cascade into upstream services
```

**Retry storms** — when your resilience pattern makes things worse:
```
1. Service X is slow due to high load (80% capacity)
2. Callers start timing out and retrying (3 retries each)
3. Load on X triples: original requests + retry wave 1 + retry wave 2
4. X goes from 80% capacity to 240% → complete overload
5. Success rate drops to 0%
6. All callers now retrying at max rate → sustained 3x amplification
7. Even when X tries to recover, retries keep it pinned at overload
Fix: exponential backoff + jitter + retry budgets. Never retry without them.
```

### Cascade Timeline — A Real-World Example

```
T+0s     Recommendation service deploys bad config, p99 latency jumps from
         200ms to 8s. No one notices yet.

T+30s    Product page handler threads pile up waiting on recommendations.
         Thread pool at 80% capacity.

T+60s    Thread pool at 100%. Requests for product pages start queuing.
         Homepage, search, cart — all share the same thread pool.
         Everything starts returning 503s.

T+90s    Load balancer health checks fail (health endpoint can't get a thread).
         Nodes start getting pulled from rotation.

T+120s   Remaining nodes take on traffic from removed nodes.
         They overload faster. Death spiral.

T+180s   Full outage. All nodes pulled. Pager goes off.

T+185s   Engineer wakes up, opens laptop, stares at dashboard showing
         0% availability.

What would have saved them:
  - Timeout on recommendation call: 1s (not 30s default) → thread freed fast
  - Bulkhead: separate pool for recommendations → only reco calls blocked
  - Circuit breaker: after 5 timeouts, stop calling reco entirely
  - Fallback: show "popular products" instead of personalized recommendations
  - Load shedding: reject low-priority requests when thread pool > 70%

Total cost of missing these patterns: ~3 minutes to total outage.
Total cost of having them: recommendation feature degrades gracefully,
everything else keeps working, nobody gets paged.
```

## ANTI-PATTERNS

Things that look like resilience but will betray you at 3am.

### Circuit Breaking on 4xx Errors
A 400 Bad Request means YOUR request is broken, not the dependency. If you count 4xx as failures, you'll open the circuit when the problem is your own malformed payload. Now you've cut yourself off from a perfectly healthy service. Only circuit-break on 5xx, timeouts, and connection errors.

### Timeout Longer Than Your Caller's Timeout
```
# Your caller gives you 10s. You give the downstream 30s.
# After 10s, your caller times out and gives up.
# You're still waiting for 20 more seconds on a response nobody wants.
# You've wasted a thread, a connection, and downstream resources for nothing.

# Rule: your timeout = caller's timeout - (your processing overhead) - margin
# If caller gives 10s and you need 1s for processing: downstream timeout = 8s max
```

### Fallback That Calls Another Fragile Dependency
```
# BAD — fallback introduces a second failure point
def get_price(item_id):
    try:
        return pricing_service.get(item_id)        # Primary
    except ServiceError:
        return inventory_service.get_price(item_id) # "Fallback" — also a network call!
        # If the network is the problem, this fails too.
        # If inventory_service is also overloaded, you've doubled the blast radius.

# GOOD — fallback gets simpler, not more complex
def get_price(item_id):
    try:
        return pricing_service.get(item_id)
    except ServiceError:
        cached = local_cache.get(f"price:{item_id}")  # Local, no network
        if cached:
            return cached
        return catalog_defaults[item_id]               # In-memory, always works
```

### Shared Thread Pool Across All Dependencies
This is the bulkhead anti-pattern. One slow dependency drains the shared pool and starves everything else. You already read the cascade timeline above — this is how it starts. Every critical dependency gets its own pool. Non-negotiable.

Ask the user by outputting your question directly in the chat.

Ask the user which dependencies are most critical or which ones have caused incidents before.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║       RESILIENCE ASSESSMENT             ║
╠══════════════════════════════════════════╣
║  Dependencies Analyzed: X               ║
║  Resilience Score: X/10                 ║
║  Unprotected Critical Paths: X          ║
╚══════════════════════════════════════════╝

DEPENDENCY MAP
──────────────
[Dependency]         [Timeout] [Circuit Breaker] [Fallback] [Bulkhead]
PostgreSQL           ❌ none    ❌ none            ❌ none     ❌ shared pool
Redis                ✅ 500ms   ❌ none            ❌ none     ❌ shared pool
Payment Gateway      ❌ none    ❌ none            ❌ none     ❌ shared pool
Email Service        ✅ 5s      ❌ none            ❌ none     ❌ shared pool

CRITICAL FINDINGS
─────────────────
🔴 P0: No timeout on Payment Gateway calls (src/services/payment.ts:23)
   Failure mode: Slow response holds connection indefinitely → pool exhaustion → total outage
   Fix: Add 10s timeout, circuit breaker (5 failures → open for 30s)

🔴 P0: Redis failure crashes the application (src/middleware/cache.ts:12)
   Failure mode: Redis down → unhandled exception → 500 on every request
   Fix: Catch Redis errors, fall back to DB, log warning

RESILIENCE PLAN
───────────────
Per-dependency recommendations with exact code locations and patterns:

[Dependency]: Payment Gateway
  Timeout: 10s request, 3s connect
  Circuit breaker: Open after 5 failures in 60s, half-open after 30s
  Fallback: Queue payment for async retry, return 202 Accepted
  Bulkhead: Dedicated connection pool (max 10 connections)
  Implementation: [specific code changes with file references]

DEGRADATION MATRIX
──────────────────
Scenario              | User Experience           | Implementation
─────────────────────|──────────────────────────|─────────────────
Redis down            | Slower, still works       | Bypass cache, read from DB
Payment gateway down  | "Payment processing..."   | Queue + async retry
Email service down    | Silent (retry later)      | Dead letter queue
Search service down   | "Search unavailable"      | Hide search, show browse
```

## VALIDATION

How to verify your resilience actually works — not just that it compiles.

### Chaos Testing Checklist

Before you call it done, simulate each of these in a staging environment:

- [ ] Kill a dependency entirely (block network to it) — does the circuit open? Does the fallback activate?
- [ ] Make a dependency slow (inject 10s latency) — do timeouts fire? Do threads get released?
- [ ] Exhaust a connection pool (max out connections to one dep) — does the bulkhead contain it? Do other deps keep working?
- [ ] Return errors from a dependency (inject 500s) — does the circuit breaker trip at the right threshold?
- [ ] Bring a dependency back after an outage — does half-open work? Any thundering herd?
- [ ] Reject requests at the dependency (return 429s) — does backpressure propagate correctly?
- [ ] Kill your cache layer — does the fallback chain degrade through each level?

### What to Measure

- **Circuit breaker state transitions**: track every CLOSED->OPEN, OPEN->HALF_OPEN, HALF_OPEN->CLOSED event. If circuits are flapping (opening and closing rapidly), your thresholds are wrong.
- **Fallback hit rate**: percentage of requests served by fallback vs primary. A slow climb means the dependency is degrading. A spike means it just died.
- **Timeout percentiles**: p50, p95, p99 of actual response times vs configured timeouts. If p99 is 900ms and your timeout is 1s, you're cutting it too close.
- **Connection pool utilization**: active/idle/waiting per pool. If any pool is consistently >80%, you're one latency spike away from exhaustion.
- **Retry rate**: retries per second. If this spikes, you might be generating a retry storm.

### What to Alert On

- **Circuit opened**: immediate alert. Something is wrong with a dependency.
- **Fallback rate > 5%** (tune per service): fallbacks are a safety net, not a mode of operation. If you're using them too much, fix the root cause.
- **Timeout rate > 2%**: occasional timeouts are normal. Sustained timeouts mean a dependency is sick.
- **Connection pool exhaustion events**: any occurrence = P1. Means the bulkhead limit was hit.
- **Retry budget exhaustion**: if you're hitting your retry budget limit, the dependency is in serious trouble and retries are just adding load.

### Cross-References

- See `/chaos` for fault injection techniques and testing frameworks
- See `/observe` for metrics instrumentation and dashboard setup
- See `/retry` for retry policies, exponential backoff, and jitter strategies
- See `/throttle` for rate limiting, backpressure, and load shedding

The goal is not zero failures — it's zero surprises. Every failure mode should have a planned response.
