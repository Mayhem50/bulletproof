# Backend Data Patterns Reference

Authoritative reference for schema design, indexing, migrations, caching, consistency, connection management, and query patterns. All examples use PostgreSQL unless noted otherwise.

---

## 1. Schema Design Principles

### Normalization Levels

**First Normal Form (1NF):** Every column holds atomic values; no repeating groups.

```sql
-- Violates 1NF: multi-valued column
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  product_names TEXT  -- "Widget, Gadget, Sprocket"
);

-- 1NF compliant: separate rows
CREATE TABLE order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_name TEXT NOT NULL
);
```

**Second Normal Form (2NF):** 1NF + every non-key column depends on the entire composite key, not part of it.

```sql
-- Violates 2NF: product_name depends only on product_id, not (order_id, product_id)
CREATE TABLE order_items (
  order_id INTEGER,
  product_id INTEGER,
  quantity INTEGER,
  product_name TEXT,  -- depends only on product_id
  PRIMARY KEY (order_id, product_id)
);

-- 2NF compliant: product_name in its own table
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE order_items (
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  quantity INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

**Third Normal Form (3NF):** 2NF + no transitive dependencies (non-key column depending on another non-key column).

```sql
-- Violates 3NF: city depends on zip_code, not directly on customer id
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  zip_code TEXT,
  city TEXT  -- transitively dependent via zip_code
);

-- 3NF compliant
CREATE TABLE zip_codes (
  code TEXT PRIMARY KEY,
  city TEXT NOT NULL
);
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  zip_code TEXT REFERENCES zip_codes(code)
);
```

### When to Denormalize

- **Read-heavy workloads** where join cost dominates (>80% reads). Store computed/joined data directly.
- **Analytics and reporting.** Materialized views or summary tables refreshed on schedule.
- **Event sourcing projections.** Read models are intentionally denormalized.
- **Caching layers.** Store pre-joined JSON in Redis rather than denormalizing the primary schema.

Rule: normalize the source of truth, denormalize the read path.

### Data Type Selection

Choose the narrowest type that accommodates all valid values.

| Data | Use | Never use |
|---|---|---|
| Money/currency | `NUMERIC(19,4)` | `FLOAT`, `DOUBLE PRECISION`, `REAL` |
| Timestamps | `TIMESTAMPTZ` | `TIMESTAMP` (no timezone) |
| Booleans | `BOOLEAN` | `INTEGER`, `CHAR(1)` |
| Short strings (enum-like) | `TEXT` + CHECK constraint | `VARCHAR(n)` unless external spec requires it |
| IP addresses | `INET` | `TEXT` |
| JSON documents | `JSONB` | `JSON` (cannot index), `TEXT` |

`FLOAT` is IEEE 754 binary and cannot exactly represent decimal fractions: `0.1 + 0.2 = 0.30000000000000004`. Financial calculations will drift. Always use `NUMERIC`.

`TIMESTAMPTZ` stores the UTC instant. `TIMESTAMP` stores a wall-clock time with no timezone context, making it ambiguous the moment your infrastructure spans timezones or DST changes.

### UUID vs Auto-Increment

**Auto-increment (`SERIAL` / `BIGSERIAL`):**
- Compact (4 or 8 bytes vs 16 for UUID).
- Naturally ordered; B-tree inserts are always at the end (no page splits).
- Predictable/enumerable -- do not expose in public APIs.
- Best for: internal IDs, join tables, high-write tables where insert throughput matters.

**UUID (`gen_random_uuid()` / UUIDv7):**
- Globally unique without coordination; safe for distributed inserts and client-generated IDs.
- UUIDv4 is fully random -- causes B-tree page splits and bloat on large tables.
- UUIDv7 (time-ordered) preserves insert locality. Prefer UUIDv7 when available.
- 16 bytes per key, larger indexes, more cache pressure.
- Best for: public-facing identifiers, distributed systems, merge scenarios.

Common pattern: `BIGSERIAL` internal PK + `UUID` external-facing column with a unique index.

```sql
CREATE TABLE accounts (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email TEXT NOT NULL
);
```

### Soft Deletes

**Pros:** Audit trail, easy undo, referential integrity preserved.
**Cons:** Every query needs `WHERE deleted_at IS NULL`, bloated tables, GDPR complicates "soft."

**Implementation:**

```sql
ALTER TABLE orders ADD COLUMN deleted_at TIMESTAMPTZ;

-- Partial index: active rows only. Keeps index small and fast.
CREATE INDEX idx_orders_active ON orders (status, created_at)
  WHERE deleted_at IS NULL;

-- All application queries filter:
SELECT * FROM orders WHERE deleted_at IS NULL AND status = 'pending';
```

Create a view for convenience:

```sql
CREATE VIEW active_orders AS
  SELECT * FROM orders WHERE deleted_at IS NULL;
```

For GDPR compliance, soft-deleted rows should be hard-deleted after the retention window via a scheduled job.

### Audit Fields

Every table should carry:

```sql
CREATE TABLE entities (
  id BIGSERIAL PRIMARY KEY,
  -- ... domain columns ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id)
);

-- Auto-update updated_at via trigger
CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

For full history, use a separate audit log table or event sourcing rather than cramming history into the main table.

---

## 2. Index Strategy

### Index Types

| Type | Best for | Notes |
|---|---|---|
| **B-tree** | Equality, range, sorting, `LIKE 'prefix%'` | Default. Covers 90%+ of cases. |
| **Hash** | Equality only | Smaller than B-tree for pure equality. Not WAL-logged before PG10. Rarely needed. |
| **GIN** | Array containment, full-text search, JSONB `@>` / `?` | Expensive to update; fast to query. |
| **GiST** | Geometric, range types, full-text (with ranking), nearest-neighbor | Lossy; may recheck rows. |
| **BRIN** | Physically ordered large tables (time-series, append-only logs) | Tiny index, only useful if table data correlates with physical order. |

### Composite Index Column Order

Place columns in this order:

1. **Equality** predicates first (most selective).
2. **Range** predicates next (`BETWEEN`, `>`, `<`).
3. **Sort** columns last.

```sql
-- Query: WHERE tenant_id = ? AND created_at > ? ORDER BY priority
CREATE INDEX idx_orders_tenant_created_priority
  ON orders (tenant_id, created_at, priority);
```

The index can satisfy the equality filter, then scan the range, then deliver rows in sort order without a separate sort step.

If you put the range column first, the equality column cannot use the index efficiently because the B-tree would need to scan all `created_at` ranges.

### Covering Indexes

Add non-filtered columns with `INCLUDE` to enable index-only scans (avoid heap fetches):

```sql
-- Query: SELECT email, name FROM users WHERE tenant_id = ? AND active = true
CREATE INDEX idx_users_tenant_active_covering
  ON users (tenant_id, active) INCLUDE (email, name);
```

EXPLAIN output for an index-only scan:

```
Index Only Scan using idx_users_tenant_active_covering on users
  Index Cond: ((tenant_id = 42) AND (active = true))
  Heap Fetches: 0    -- <-- this is the goal
```

Covering indexes increase index size. Use them for hot queries, not speculatively.

### Partial Indexes

Index only the rows you query:

```sql
-- 95% of queries filter for non-deleted rows
CREATE INDEX idx_orders_status_active
  ON orders (status, created_at)
  WHERE deleted_at IS NULL;

-- Only index unprocessed items
CREATE INDEX idx_jobs_pending
  ON jobs (priority, created_at)
  WHERE processed_at IS NULL;
```

A partial index on 5% of a 100M-row table is 20x smaller and 20x faster to scan than a full index.

### Index-Only Scans

Requirements for an index-only scan:
1. All columns in SELECT, WHERE, and ORDER BY are in the index (keys + INCLUDE).
2. The visibility map indicates the heap page is all-visible (no recent unvacuumed changes).

Run `VACUUM` aggressively on tables where you rely on index-only scans. Check `Heap Fetches` in EXPLAIN ANALYZE -- if it is high relative to rows returned, the visibility map is stale.

### Cost of Indexes on Writes

Every index adds overhead to INSERT, UPDATE (on indexed columns), and DELETE:

- **Rule of thumb:** Each additional index adds 5-15% overhead to write operations on that table.
- A table with 8+ indexes will feel it on bulk inserts.
- Solution: drop indexes before bulk loads, recreate after. Or use `COPY` which is faster than row-by-row inserts.
- For UPDATE, only indexes containing the updated columns are modified (Postgres HOT updates can skip index updates entirely if no indexed column changes).

### Identifying Missing Indexes

**From slow query logs (Postgres):**

```sql
-- Enable logging of slow queries (in postgresql.conf)
-- log_min_duration_statement = 200   -- log queries > 200ms
```

**From EXPLAIN ANALYZE:**

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT * FROM orders WHERE customer_id = 12345 AND status = 'pending';
```

Red flags in the output:
- `Seq Scan` on a large table with a selective WHERE clause.
- `Sort` with `Sort Method: external merge Disk` -- too many rows to sort in memory.
- `Rows Removed by Filter: 950000` -- scanning vastly more rows than returned.
- `Buffers: shared read=48210` -- reading many pages from disk.

**From pg_stat_user_tables:**

```sql
-- Tables with many sequential scans vs index scans
SELECT schemaname, relname, seq_scan, idx_scan,
       seq_scan - idx_scan AS seq_dominant
FROM pg_stat_user_tables
WHERE seq_scan > idx_scan
ORDER BY seq_scan - idx_scan DESC
LIMIT 20;
```

---

## 3. Migration Patterns

### Expand/Contract Pattern

A zero-downtime migration strategy executed in phases:

**Phase 1 - Expand (additive only):**
- Add new columns (nullable), new tables, new indexes.
- No breaking changes. Old code still works.

**Phase 2 - Migrate:**
- Deploy code that writes to both old and new structures (dual-write).
- Backfill new columns/tables from old data.
- Verify data consistency.

**Phase 3 - Contract:**
- Switch reads to new structure.
- Stop writing to old structure.
- Drop old columns/tables in a later release.

Timeline example for renaming `orders.amount` to `orders.total_cents`:

```
Week 1: ALTER TABLE orders ADD COLUMN total_cents BIGINT;
         Deploy code: write to both amount AND total_cents.
Week 2: Run backfill: UPDATE orders SET total_cents = amount WHERE total_cents IS NULL;
         (batch in chunks of 10k, sleep between batches to limit replication lag)
Week 3: Deploy code: read from total_cents, still dual-write.
         Verify reads match.
Week 4: Deploy code: stop writing to amount.
Week 5: ALTER TABLE orders DROP COLUMN amount;
```

### Adding Columns Safely

```sql
-- Step 1: Add nullable column (instant in Postgres 11+, no table rewrite)
ALTER TABLE orders ADD COLUMN region TEXT;

-- Step 2: Backfill in batches
UPDATE orders SET region = 'us-east'
  WHERE id BETWEEN 1 AND 100000 AND region IS NULL;
-- repeat for subsequent ranges, with pauses

-- Step 3: Add NOT NULL constraint (once fully backfilled)
ALTER TABLE orders ALTER COLUMN region SET NOT NULL;

-- Step 4 (optional): Set default for future rows
ALTER TABLE orders ALTER COLUMN region SET DEFAULT 'us-east';
```

In PostgreSQL 11+, `ADD COLUMN ... DEFAULT <value>` with a non-volatile default is also instant (no table rewrite). But separating the steps gives you control over backfill pacing.

### Adding Indexes Safely

```sql
-- PostgreSQL: CONCURRENTLY avoids locking writes (but takes longer, runs outside a transaction)
CREATE INDEX CONCURRENTLY idx_orders_region ON orders (region);

-- If it fails partway through, the index is left in INVALID state:
-- Check: SELECT * FROM pg_indexes WHERE indexname = 'idx_orders_region';
-- Fix:   DROP INDEX idx_orders_region; then retry.
```

MySQL equivalent: `ALTER TABLE orders ADD INDEX idx_region (region), ALGORITHM=INPLACE, LOCK=NONE;`

### Data Migrations vs Schema Migrations

**Always separate them.** Schema migrations (DDL) should be in your migration tool (Flyway, Alembic, Knex, etc.). Data migrations (backfills, transforms) should be separate scripts.

Reasons:
- Data migrations may take hours. Schema migrations should be instant or near-instant.
- Data migrations may need to be re-run, paused, or run in chunks.
- Mixing them in one transaction risks long-held locks.

### Lock Awareness (PostgreSQL)

| Operation | Lock level | Blocks reads? | Blocks writes? |
|---|---|---|---|
| `CREATE INDEX CONCURRENTLY` | `ShareUpdateExclusiveLock` | No | No |
| `CREATE INDEX` (non-concurrent) | `ShareLock` | No | **Yes** |
| `ALTER TABLE ADD COLUMN` (nullable, no default) | `AccessExclusiveLock` | **Briefly** | **Briefly** |
| `ALTER TABLE ADD COLUMN ... DEFAULT val` (PG11+) | `AccessExclusiveLock` | **Briefly** | **Briefly** |
| `ALTER TABLE ALTER COLUMN SET NOT NULL` | `AccessExclusiveLock` | **Briefly** | **Briefly** |
| `ALTER TABLE DROP COLUMN` | `AccessExclusiveLock` | **Briefly** | **Briefly** |
| `ALTER TABLE ALTER COLUMN TYPE` | `AccessExclusiveLock` | **Yes (full rewrite)** | **Yes** |
| `DROP TABLE` | `AccessExclusiveLock` | **Yes** | **Yes** |

"Briefly" means the lock is acquired and released quickly (sub-second on most tables). `ALTER COLUMN TYPE` rewrites the entire table and holds the lock for the duration -- avoid on large tables. Instead, add a new column with the new type and use expand/contract.

Set a lock timeout to fail fast rather than queue behind a lock:

```sql
SET lock_timeout = '3s';
ALTER TABLE orders ADD COLUMN region TEXT;
```

---

## 4. Caching Patterns

### Cache-Aside (Lazy Loading)

```
Read path:
  1. Check cache for key
  2. Cache HIT  -> return cached value
  3. Cache MISS -> query database -> write to cache with TTL -> return value
```

**Pros:** Cache only contains data that is actually requested. Simple to implement. Cache failure is not fatal (fallback to DB).
**Cons:** First request is always slow (cold cache). Data can become stale until TTL expires or explicit invalidation.

```python
def get_user(user_id):
    key = f"user:{user_id}"
    cached = redis.get(key)
    if cached:
        return deserialize(cached)
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    redis.setex(key, 300, serialize(user))  # TTL 5 minutes
    return user
```

### Write-Through

```
Write path:
  1. Write to cache
  2. Cache writes to database synchronously
  3. Return success after both complete
```

**Pros:** Cache is always consistent with DB. Reads are always fast after the first write.
**Cons:** Write latency increases (two writes on every mutation). Cache may hold data that is never read.

### Write-Behind (Write-Back)

```
Write path:
  1. Write to cache
  2. Return success immediately
  3. Asynchronously flush to database (batched, on interval)
```

**Pros:** Lowest write latency. Batching reduces DB load.
**Cons:** **Data loss risk** if cache node crashes before flush. Complex failure handling. Not suitable for financial data or anything requiring durability guarantees.

### Cache Stampede Prevention

When a hot key expires, hundreds of concurrent requests simultaneously miss the cache and all hit the database.

**Mutex (lock-based):**

```python
def get_user(user_id):
    key = f"user:{user_id}"
    cached = redis.get(key)
    if cached:
        return deserialize(cached)

    lock_key = f"lock:{key}"
    if redis.set(lock_key, "1", nx=True, ex=5):  # acquire lock, 5s timeout
        try:
            user = db.query("SELECT * FROM users WHERE id = %s", user_id)
            redis.setex(key, 300, serialize(user))
            return user
        finally:
            redis.delete(lock_key)
    else:
        time.sleep(0.05)        # wait for the holder to populate
        return get_user(user_id) # retry
```

**Probabilistic early expiry (stagger expiration):**

```python
def get_with_early_expiry(key, ttl, recompute_fn):
    cached, expiry = redis.get_with_ttl(key)
    remaining = expiry - time.time()
    # Probabilistically recompute before actual expiry
    # As TTL approaches 0, probability approaches 1
    if cached is None or remaining - random.exponential(beta=ttl * 0.1) <= 0:
        value = recompute_fn()
        redis.setex(key, ttl, value)
        return value
    return cached
```

**Stale-while-revalidate:** Return the stale value immediately, trigger async refresh in the background.

### Cache Invalidation Strategies

| Strategy | Mechanism | Best for |
|---|---|---|
| **TTL** | Key expires after fixed duration | General purpose, acceptable staleness |
| **Event-based** | Invalidate on write (publish event) | Strong consistency requirements |
| **Version-based** | Key includes version counter; bump on write | Avoid race conditions during invalidation |
| **Tag-based** | Associate keys with tags; invalidate all keys for a tag | Invalidating groups (e.g., all data for tenant X) |

### Cache Key Design

Format: `{service}:{entity}:{id}:{qualifier}`

```
user-svc:user:42:profile
user-svc:user:42:permissions
order-svc:order:1001:summary
order-svc:orders-by-user:42:page:1
catalog:product:sku-881:pricing:usd
```

Rules:
- Use colons as delimiters (Redis convention, enables `SCAN` patterns).
- Include service prefix to avoid collisions in shared Redis instances.
- Keep keys deterministic and reproducible from the request parameters.
- Never put user input directly into keys without sanitization.

### Negative Caching

Cache "not found" results to prevent repeated database misses for nonexistent keys:

```python
user = db.query("SELECT * FROM users WHERE id = %s", user_id)
if user is None:
    redis.setex(f"user:{user_id}", 60, "NOT_FOUND")  # short TTL
else:
    redis.setex(f"user:{user_id}", 300, serialize(user))
```

Without negative caching, an attacker can DDoS your database by requesting nonexistent IDs.

### Multi-Level Caching

```
L1: In-process cache (HashMap / Caffeine / lru-cache)
    - Sub-microsecond reads
    - Per-instance, not shared
    - Small capacity (1000-10000 entries)
    - TTL: 5-30 seconds

L2: Shared cache (Redis / Memcached)
    - Sub-millisecond reads (network hop)
    - Shared across all instances
    - Large capacity (GBs)
    - TTL: 1-60 minutes

L3: CDN / edge cache
    - For public, non-personalized data
    - Cache-Control headers
    - TTL: minutes to hours
```

Read path: L1 -> L2 -> L3 -> database. Write invalidation must propagate from database outward through all levels.

---

## 5. Consistency Patterns

### Strong vs Eventual Consistency

**Strong consistency:** Every read returns the most recent write. Required for:
- Financial transactions and balances.
- Inventory counts before purchase.
- User authentication state.
- Any operation where stale data causes monetary loss or security issues.

**Eventual consistency:** Reads may return stale data for a bounded period. Acceptable for:
- Social feeds, notifications, analytics.
- Search indexes (short lag is fine).
- Recommendation engines.
- Cached product catalogs.

### Read-Your-Writes Consistency

After a user writes data, that same user must see their write in subsequent reads, even if other users see stale data.

Implementation strategies:
- **Session affinity:** Route the user's reads to the primary database for N seconds after a write.
- **Read-from-primary flag:** Set a short-lived cookie/header after writes; middleware routes reads to primary if flag is present.
- **Replication lag tracking:** Check `pg_last_wal_replay_lsn()` on the replica. If it has not caught up to the LSN of the user's last write, read from primary.

### Optimistic Concurrency Control

Use a version column to detect concurrent modifications:

```sql
ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Read: get current version
SELECT id, status, total, version FROM orders WHERE id = 42;
-- Application receives: version = 3

-- Update: conditional on version match
UPDATE orders
SET status = 'shipped', version = version + 1
WHERE id = 42 AND version = 3;

-- If 0 rows affected: another writer incremented the version first.
-- Application must re-read and retry or return a conflict error (HTTP 409).
```

No locks held between read and write. Scales well under low contention. Under high contention, retry storms become a problem -- switch to pessimistic locking.

### Pessimistic Locking

```sql
BEGIN;
-- Lock the row; other transactions block on this row until we commit
SELECT * FROM orders WHERE id = 42 FOR UPDATE;

-- Safe to modify without concurrent interference
UPDATE orders SET status = 'shipped' WHERE id = 42;
COMMIT;
```

Variants:
- `FOR UPDATE NOWAIT` -- fail immediately if the row is already locked.
- `FOR UPDATE SKIP LOCKED` -- skip locked rows; useful for job queue patterns.

```sql
-- Job queue: each worker grabs unlocked jobs
BEGIN;
SELECT id, payload FROM jobs
  WHERE status = 'pending'
  ORDER BY priority, created_at
  LIMIT 10
  FOR UPDATE SKIP LOCKED;

UPDATE jobs SET status = 'processing' WHERE id IN (...);
COMMIT;
```

### Advisory Locks

Application-level locks managed by the database, not tied to any row or table:

```sql
-- Acquire a lock keyed to an arbitrary bigint (e.g., hash of a resource name)
SELECT pg_advisory_lock(hashtext('process-daily-report'));

-- ... do exclusive work ...

SELECT pg_advisory_unlock(hashtext('process-daily-report'));
```

Use cases: ensuring only one instance runs a cron job, coordinating schema migrations, preventing duplicate processing of an event.

`pg_try_advisory_lock` returns a boolean immediately (non-blocking). Prefer this for "skip if already running" semantics.

### Distributed Consensus

You need distributed consensus (Raft, Paxos, etcd, ZooKeeper) only when:
- Multiple independent databases must agree on state.
- Leader election across stateless application nodes.
- Distributed locking across separate database clusters.

You almost certainly do NOT need it for:
- A single-primary PostgreSQL deployment (the database is the consensus authority).
- Microservices that share a database.
- Anything solvable with a database advisory lock or a Redis-based lock.

Do not introduce Raft/Paxos into your architecture unless you have confirmed that simpler mechanisms are insufficient. The operational complexity is substantial.

---

## 6. Connection Management

### Connection Pool Sizing

PostgreSQL formula (from the PostgreSQL wiki):

```
connections = (core_count * 2) + effective_spindle_count
```

- `core_count`: physical CPU cores (not hyperthreads) on the database server.
- `effective_spindle_count`: number of independent I/O channels (1 for SSD, number of disks for spinning HDD array).

Example: 4-core server with SSD = `(4 * 2) + 1 = 9` connections.

This is the total across ALL application instances. If you have 5 app servers, each pool should be sized at `9 / 5 ~ 2` connections (round up to 3-4 for headroom).

Counter-intuitive but confirmed by benchmarks: a small pool (10-20 connections) outperforms a large pool (200 connections) because of context switching, cache thrashing, and lock contention inside the database.

### Pool Exhaustion

**Symptoms:**
- Application threads blocking on `getConnection()`, timeouts, 5xx errors.
- All connections in `pg_stat_activity` are `active` or `idle in transaction`.
- Database CPU may be low (connections are waiting on locks, not computing).

**Diagnosis:**

```sql
-- Active connections by state
SELECT state, count(*) FROM pg_stat_activity GROUP BY state;

-- Long-running queries
SELECT pid, now() - query_start AS duration, query, state
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC
LIMIT 10;

-- "idle in transaction" is the silent killer
SELECT pid, now() - xact_start AS duration, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY duration DESC;
```

**Fixes:**
- Set `idle_in_transaction_session_timeout = '30s'` in PostgreSQL to kill abandoned transactions.
- Set connection pool checkout timeout (e.g., HikariCP `connectionTimeout: 5000`).
- Ensure every code path commits or rolls back transactions, especially in error handlers.
- Use `statement_timeout` to kill runaway queries.

### Connection Lifetime and Recycling

- Set `maxLifetime` (HikariCP) or equivalent to slightly below the database's `tcp_keepalives_idle` or load balancer idle timeout.
- Typical value: 25-30 minutes.
- Recycling prevents stale connections that accumulate server-side memory (temp buffers, prepared statements).
- `validation query` (e.g., `SELECT 1`) adds latency; most modern pools validate on borrow using the JDBC4 `isValid()` which is cheaper.

### Read Replicas

**When to use:** Read-heavy workloads where you can tolerate replication lag (typically 10-100ms for synchronous streaming replication, seconds to minutes for async).

**Lag awareness:**

```sql
-- On the replica: how far behind is it?
SELECT now() - pg_last_xact_replay_timestamp() AS replication_lag;
```

Application-level pattern:
- Write operations always go to primary.
- Read operations go to replica by default.
- After a write, route that user's reads to primary for a grace period (5-10 seconds).

### PgBouncer / ProxySQL

**PgBouncer** (PostgreSQL connection pooler):
- Sits between app and database, multiplexes many app connections onto fewer database connections.
- **Transaction mode** (recommended): connection returned to pool after each transaction. Prepared statements must be re-prepared per transaction.
- **Session mode:** connection held for the entire client session. Safer but fewer multiplexing benefits.
- Reduces PostgreSQL connection count from thousands (app instances * pool size) to tens.

**ProxySQL** (MySQL equivalent):
- Connection pooling, read/write splitting, query routing, query caching.
- Can route queries by pattern (e.g., SELECT to replica, everything else to primary).

---

## 7. Query Anti-Patterns

### N+1 Queries

The most common performance problem in application code.

```python
# N+1: 1 query for orders + N queries for customers
orders = db.query("SELECT * FROM orders WHERE date > '2025-01-01'")
for order in orders:  # if 500 orders, this fires 500 queries
    order.customer = db.query("SELECT * FROM customers WHERE id = %s", order.customer_id)
```

**Fix 1 -- JOIN (eager loading):**

```sql
SELECT o.*, c.name, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.date > '2025-01-01';
```

**Fix 2 -- IN (batch loading):**

```python
orders = db.query("SELECT * FROM orders WHERE date > '2025-01-01'")
customer_ids = [o.customer_id for o in orders]
customers = db.query("SELECT * FROM customers WHERE id = ANY(%s)", customer_ids)
# Map customers by id and attach to orders
```

**Fix 3 -- DataLoader pattern (GraphQL / batched resolution):**
Collect all requested IDs in a single tick, fire one batched query. Libraries: `dataloader` (JS), `promise_dataloader` (Ruby), `aiodataloader` (Python).

**Detection:** Log query counts per request. If a single endpoint fires >10 queries, investigate. ORM logging or `pg_stat_statements` can reveal repeated query patterns.

### SELECT * Is Harmful

```sql
-- Bad: fetches all columns, including the 2MB description blob
SELECT * FROM products WHERE category_id = 7;

-- Good: only what you need
SELECT id, name, price, stock_count FROM products WHERE category_id = 7;
```

Problems with `SELECT *`:
- Fetches columns you do not use, wasting I/O and memory.
- Prevents covering index optimizations (index-only scans).
- Schema changes (adding a column) silently change the result set, potentially breaking callers.

### Unbounded Queries

Every query returning multiple rows must have a limit.

```sql
-- Dangerous: could return 10 million rows
SELECT * FROM events WHERE type = 'click';

-- Safe: always paginate
SELECT * FROM events WHERE type = 'click'
ORDER BY created_at DESC
LIMIT 50;
```

### Missing WHERE on UPDATE/DELETE

```sql
-- CATASTROPHIC: updates every row in the table
UPDATE orders SET status = 'cancelled';

-- Safe
UPDATE orders SET status = 'cancelled' WHERE id = 42;
```

Mitigation: enable `safe_updates` mode in MySQL. In PostgreSQL, use a pre-commit hook or review tool that flags UPDATE/DELETE without WHERE. Wrap destructive operations in transactions with a manual sanity check:

```sql
BEGIN;
UPDATE orders SET status = 'cancelled' WHERE customer_id = 99;
-- Check: "UPDATE 3" -- does 3 seem right?
-- If not: ROLLBACK;
COMMIT;
```

### Implicit Type Casting Bypasses Indexes

```sql
-- orders.id is BIGINT, but parameter is passed as TEXT
-- Postgres must cast every row's id to TEXT for comparison, bypassing the index
EXPLAIN SELECT * FROM orders WHERE id = '42';

-- Alternatively, if the column is TEXT but you pass an integer:
-- WHERE phone = 5551234  -- forces cast of every phone to numeric
```

Ensure parameter types match column types. ORMs usually handle this, but raw SQL and some drivers do not.

EXPLAIN shows `Filter` (row-by-row check) instead of `Index Cond` when casting prevents index use.

### OFFSET Pagination at Scale

```sql
-- Page 1: fast
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 0;

-- Page 5000: slow -- database must read and discard 100,000 rows
SELECT * FROM orders ORDER BY created_at DESC LIMIT 20 OFFSET 100000;
```

EXPLAIN for OFFSET 100000:

```
Limit  (cost=28523.45..28523.50 rows=20)
  ->  Sort  (cost=28273.45..28773.45 rows=200000)
        Sort Key: created_at DESC
        ->  Seq Scan on orders  (cost=0.00..14421.00 rows=200000)
```

**Fix -- Keyset (cursor) pagination:**

```sql
-- Page 1
SELECT id, created_at, status
FROM orders
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- Client remembers last row: created_at='2025-06-15 10:30:00', id=98701

-- Page 2: seek from where we left off
SELECT id, created_at, status
FROM orders
WHERE (created_at, id) < ('2025-06-15 10:30:00', 98701)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

Keyset pagination uses the index to seek directly to the start point. Performance is constant regardless of page depth. Trade-off: no random page access (cannot jump to page 5000), but this is rarely needed in practice.

Index to support this:

```sql
CREATE INDEX idx_orders_created_id ON orders (created_at DESC, id DESC);
```

---

## Quick Reference: Common Numbers

| Metric | Typical value |
|---|---|
| B-tree index lookup | 3-4 disk pages for millions of rows |
| Sequential scan speed (SSD) | ~1-2 GB/s raw, ~200-500 MB/s after processing |
| Network round-trip (same AZ) | 0.1-0.5 ms |
| Redis GET latency | 0.1-0.3 ms |
| PostgreSQL simple query | 0.2-2 ms (indexed), 100ms+ (seq scan on large table) |
| Connection establishment | 5-15 ms (TCP + auth) |
| PgBouncer overhead | <0.1 ms per query |
| `VACUUM` on 1M rows | 1-5 seconds |
| `CREATE INDEX` on 10M rows | 10-60 seconds (depending on column width) |
| `CREATE INDEX CONCURRENTLY` | 2-5x slower than non-concurrent |
| Replication lag (streaming sync) | 0.1-10 ms |
| Replication lag (async) | 100 ms - seconds |
