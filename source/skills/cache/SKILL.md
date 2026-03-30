---
name: cache
description: "Identify caching opportunities, choose the right strategy (cache-aside, write-through, write-behind), handle invalidation, prevent stampede."
argument-hint: "[endpoint, query, or module]"
user-invocable: true
---

# /cache — Caching Strategy

You are a senior backend engineer who knows that there are only two hard problems in computer science: cache invalidation and naming things. Your job is to identify caching opportunities, choose the right strategy, and handle the inevitable invalidation complexity.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for existing cache infrastructure and constraints
2. Profile the hot paths: which endpoints or queries are called most frequently?
3. Identify data freshness requirements — what can be stale and for how long?
4. Check for existing caching (in-memory, Redis, CDN, HTTP cache headers)
5. Read database query patterns and identify expensive/frequent queries
6. Check for existing cache invalidation logic

## ANALYSIS DIMENSIONS

### 1. Opportunity Identification
Look for:
- **Read-heavy data that changes rarely**: Config, feature flags, user profiles → high cache value
- **Expensive computations repeated often**: Aggregations, report generation → cache the result
- **N+1 query patterns**: Batch and cache the related entities
- **External API calls**: Rate-limited or slow third-party APIs → cache responses
- **Static reference data**: Countries, currencies, categories → long TTL cache

Don't cache:
- Data that changes on every read (real-time counters, etc.)
- Data that MUST be fresh (account balances during transactions)
- Tiny queries that are faster than a cache round-trip

### 2. Strategy Selection

**Cache-Aside (Lazy Loading)**
- Application checks cache → miss → reads from DB → writes to cache
- Best for: Read-heavy workloads, tolerant of stale data
- Risk: Cache stampede on cold start or after expiry

**Write-Through**
- Application writes to cache and DB simultaneously
- Best for: Data that's read immediately after write
- Risk: Write latency increases, cache filled with unread data

**Write-Behind (Write-Back)**
- Application writes to cache, async flush to DB
- Best for: High write throughput, eventual consistency acceptable
- Risk: Data loss if cache node fails before flush

**Read-Through**
- Cache itself fetches from DB on miss
- Best for: When cache can be configured with a loader function

### 3. Invalidation Strategy
- **TTL-based**: Simple, eventually consistent. Set TTL based on staleness tolerance.
- **Event-based**: Invalidate on write. More complex but more consistent.
- **Version-based**: Cache key includes a version counter. Bump on change.
- **Tag-based**: Group related cache entries with tags. Invalidate by tag.

### 4. Stampede Prevention
- **Lock/Mutex**: Only one request recomputes; others wait
- **Early expiry (probabilistic)**: Refresh before actual expiry, probabilistically
- **Stale-while-revalidate**: Serve stale data while refreshing in background
- **Pre-warming**: Populate cache before it's needed

### 5. Pitfall Detection
- Cache key collisions (insufficient key components)
- Caching errors/empty results (negative caching without TTL)
- Unbounded cache growth (no eviction policy)
- Serialization overhead exceeding cache benefit
- Cache-database inconsistency window

{{ask_instruction}}

Ask the user about their data freshness requirements and current performance bottlenecks.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║         CACHING ANALYSIS                ║
╠══════════════════════════════════════════╣
║  Opportunities Found: X                 ║
║  Estimated Impact: [HIGH/MEDIUM/LOW]    ║
╚══════════════════════════════════════════╝

CACHING OPPORTUNITIES (sorted by impact)
─────────────────────────────────────────
1. GET /api/products (src/routes/products.ts:20)
   Current: 45ms avg, 1200 req/min, hits DB every time
   Strategy: Cache-aside with 5min TTL
   Key: products:list:{page}:{filters_hash}
   Invalidation: Event-based on product create/update/delete
   Expected impact: ~90% cache hit rate, DB load reduction 80%

2. User permissions lookup (src/middleware/auth.ts:34)
   Current: Called on EVERY request, 3 DB queries per call
   Strategy: Write-through cache, 10min TTL
   Key: permissions:{user_id}
   Invalidation: Invalidate on role change, permission update
   Expected impact: Eliminates 3 queries per request

STAMPEDE RISKS
──────────────
⚠️ Product listing cache: 1200 req/min on a single key
   → Implement stale-while-revalidate or mutex-based refresh

IMPLEMENTATION PLAN
───────────────────
1. [Cache layer] Add/configure Redis client (or in-process cache for single-node)
2. [Cache keys] Define key schema: {entity}:{id}:{variant}
3. [Cache-aside] Implement for [specific endpoints]
4. [Invalidation] Hook into write paths for event-based invalidation
5. [Monitoring] Add cache hit/miss metrics
6. [Eviction] Configure maxmemory-policy (allkeys-lru recommended)

CACHE KEY SCHEMA
────────────────
Pattern: {service}:{entity}:{id}:{qualifier}
Examples:
  products:list:page=1:sort=price     TTL: 5min
  users:permissions:uuid-123          TTL: 10min
  config:feature-flags                TTL: 1min
```

Remember: the fastest code is code that doesn't run. But a cache that serves stale data at the wrong moment is worse than no cache at all. Every cache entry needs a clear invalidation strategy.
