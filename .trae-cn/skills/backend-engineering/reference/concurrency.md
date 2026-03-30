# Backend Concurrency Patterns Reference

Dense reference for an AI coding agent. Covers race conditions, database concurrency control, distributed locking, message queue patterns, and async architectures.

---

## 1. Race Condition Patterns

### 1.1 TOCTOU (Time-of-Check-Time-of-Use)

Read a value, make a decision, then write -- but the value changed between read and write.

```
Timeline:
  Thread A:  READ stock=1 ──── CHECK stock>0 ──── SELL (stock=0)
  Thread B:       READ stock=1 ──── CHECK stock>0 ──── SELL (stock=-1) ← OVERSOLD
```

**Vulnerable:**
```python
stock = db.query("SELECT stock FROM products WHERE id = ?", product_id)
if stock > 0:
    db.execute("UPDATE products SET stock = stock - 1 WHERE id = ?", product_id)
    create_order(product_id)
```

**Fix -- atomic conditional write:**
```python
rows_affected = db.execute(
    "UPDATE products SET stock = stock - 1 WHERE id = ? AND stock > 0",
    product_id
)
if rows_affected == 1:
    create_order(product_id)
else:
    raise OutOfStockError()
```

### 1.2 Lost Updates

Two concurrent read-modify-write sequences. The second write silently overwrites the first.

```
Timeline:
  Thread A:  READ balance=100 ──── compute 100+50 ──── WRITE balance=150
  Thread B:       READ balance=100 ──── compute 100+30 ──── WRITE balance=130
  Result: balance=130, lost the +50. Should be 180.
```

**Vulnerable:**
```python
balance = db.query("SELECT balance FROM accounts WHERE id = ?", acct_id)
new_balance = balance + deposit_amount
db.execute("UPDATE accounts SET balance = ? WHERE id = ?", new_balance, acct_id)
```

**Fix -- atomic increment:**
```sql
UPDATE accounts SET balance = balance + $1 WHERE id = $2;
```

**Fix -- optimistic locking (when logic is complex):**
```python
row = db.query("SELECT balance, version FROM accounts WHERE id = ?", acct_id)
new_balance = complex_calculation(row.balance)
affected = db.execute(
    "UPDATE accounts SET balance = ?, version = version + 1 WHERE id = ? AND version = ?",
    new_balance, acct_id, row.version
)
if affected == 0:
    raise OptimisticLockError("Retry")  # caller retries
```

### 1.3 Double Processing

Two workers pick the same message or job from a queue.

```
Timeline:
  Worker A:  POLL job_id=42 ──── PROCESS ──── COMPLETE
  Worker B:  POLL job_id=42 ──── PROCESS ──── COMPLETE  ← duplicate work
```

**Fix -- SELECT FOR UPDATE SKIP LOCKED (database job queue):**
```sql
BEGIN;
SELECT * FROM jobs WHERE status = 'pending'
  ORDER BY created_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;  -- skip rows another transaction already locked

UPDATE jobs SET status = 'processing', worker_id = $1 WHERE id = $2;
COMMIT;
```

**Fix -- idempotent processing with deduplication key:**
```python
def process_payment(payment_id, idempotency_key):
    inserted = db.execute(
        "INSERT INTO processed_events (idempotency_key) VALUES (?) ON CONFLICT DO NOTHING",
        idempotency_key
    )
    if inserted == 0:
        return  # already processed
    do_payment(payment_id)
```

### 1.4 Non-Atomic Compound Operations

Multiple steps that should be all-or-nothing but are not wrapped in a transaction.

```
Timeline:
  Thread A:  DEBIT account ──── [CRASH] ──── never CREDIT other account
```

**Vulnerable:**
```python
db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, from_id)
# crash or error here = money vanishes
db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, to_id)
```

**Fix -- single transaction:**
```python
with db.transaction():
    db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, from_id)
    db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, to_id)
```

### 1.5 Stale Read Decisions

Acting on cached or old data that no longer reflects reality.

```
Timeline:
  Cache: price=$10 (cached 5 min ago)
  DB:    price=$15 (updated 2 min ago)
  App:   charges customer $10 based on stale cache ← revenue loss
```

**Fixes:**
- Read from DB for critical decisions (pricing, inventory, permissions).
- Use short TTLs on cache for semi-critical data.
- Cache invalidation on write (write-through or write-behind).
- Version stamps: compare cache version before acting.

---

## 2. Database-Level Concurrency Control

### 2.1 Transaction Isolation Levels

| Level | Dirty Read | Non-Repeatable Read | Phantom Read | Use Case |
|---|---|---|---|---|
| READ UNCOMMITTED | Yes | Yes | Yes | Almost never. Debug only. |
| READ COMMITTED | No | Yes | Yes | Postgres default. Good for most OLTP. |
| REPEATABLE READ | No | No | Possible* | Reports, consistent multi-query reads. |
| SERIALIZABLE | No | No | No | Financial, booking -- when correctness > throughput. |

*Postgres REPEATABLE READ uses snapshot isolation, which prevents phantoms in practice but is not true serializability.

**Setting isolation in Postgres:**
```sql
BEGIN ISOLATION LEVEL SERIALIZABLE;
-- ... queries ...
COMMIT;
```

**Key rule:** Higher isolation = more contention = more serialization errors to handle. Always code retry logic when using REPEATABLE READ or SERIALIZABLE.

```python
MAX_RETRIES = 3
for attempt in range(MAX_RETRIES):
    try:
        with db.transaction(isolation="serializable"):
            perform_critical_operation()
            break
    except SerializationError:
        if attempt == MAX_RETRIES - 1:
            raise
        continue  # retry with fresh snapshot
```

### 2.2 Pessimistic Locking

**SELECT ... FOR UPDATE** -- lock rows until transaction commits:
```sql
BEGIN;
SELECT * FROM accounts WHERE id = 42 FOR UPDATE;  -- row is now locked
-- other transactions trying FOR UPDATE on same row will BLOCK
UPDATE accounts SET balance = balance - 100 WHERE id = 42;
COMMIT;  -- lock released
```

**FOR UPDATE SKIP LOCKED** -- job queue pattern, skip already-locked rows:
```sql
BEGIN;
SELECT id, payload FROM tasks
  WHERE status = 'pending'
  ORDER BY priority DESC
  LIMIT 5
  FOR UPDATE SKIP LOCKED;
-- returns only rows not locked by other workers
UPDATE tasks SET status = 'processing' WHERE id = ANY($1);
COMMIT;
```

**FOR UPDATE NOWAIT** -- fail immediately instead of blocking:
```sql
BEGIN;
SELECT * FROM accounts WHERE id = 42 FOR UPDATE NOWAIT;
-- throws error immediately if row is locked, instead of waiting
```

Use NOWAIT in user-facing paths where blocking is unacceptable.

**Advisory Locks** -- application-level named locks via the database:
```sql
-- Session-level: held until session ends or explicit release
SELECT pg_advisory_lock(hashtext('process-monthly-billing'));
-- ... do work ...
SELECT pg_advisory_unlock(hashtext('process-monthly-billing'));

-- Transaction-level: released at COMMIT/ROLLBACK
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('singleton-job-xyz'));
-- ... do work ...
COMMIT;  -- lock auto-released

-- Non-blocking variant:
SELECT pg_try_advisory_lock(hashtext('my-lock'));  -- returns true/false
```

Advisory locks are lightweight, don't lock any rows, and are great for singleton jobs, migrations, or any app-level mutual exclusion that doesn't map to a specific row.

### 2.3 Optimistic Locking

**Version column pattern:**
```sql
-- Schema
ALTER TABLE orders ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Read
SELECT id, status, version FROM orders WHERE id = 42;
-- Returns: id=42, status='pending', version=3

-- Conditional update
UPDATE orders
SET status = 'shipped', version = version + 1
WHERE id = 42 AND version = 3;
-- Returns rows_affected: 1 if success, 0 if someone else updated first
```

**Conditional writes (atomic guard):**
```sql
-- Withdraw only if sufficient balance
UPDATE accounts SET balance = balance - 500 WHERE id = 42 AND balance >= 500;

-- Claim a job only if unclaimed
UPDATE jobs SET worker = 'worker-7', status = 'running'
WHERE id = 99 AND status = 'pending';
```

**CAS (Compare-and-Swap) loop:**
```python
def cas_update(record_id, transform_fn, max_retries=5):
    for _ in range(max_retries):
        row = db.query("SELECT * FROM records WHERE id = ?", record_id)
        new_value = transform_fn(row)
        affected = db.execute(
            "UPDATE records SET value = ?, version = version + 1 WHERE id = ? AND version = ?",
            new_value, record_id, row.version
        )
        if affected == 1:
            return new_value
    raise TooManyRetriesError()
```

### 2.4 Deadlock Prevention

```
Deadlock scenario:
  Tx A:  LOCK row 1 ──── wait for row 2 ────→ BLOCKED
  Tx B:  LOCK row 2 ──── wait for row 1 ────→ BLOCKED
  Both wait forever. DB detects and kills one.
```

**Prevention rules:**
1. **Consistent lock ordering:** Always lock rows in sorted order (e.g., by ID).
   ```python
   ids = sorted([from_account_id, to_account_id])
   with db.transaction():
       db.execute("SELECT 1 FROM accounts WHERE id = ? FOR UPDATE", ids[0])
       db.execute("SELECT 1 FROM accounts WHERE id = ? FOR UPDATE", ids[1])
       # now safe to update both
   ```
2. **Keep transactions short.** Don't do HTTP calls or file I/O inside a transaction.
3. **Set lock_timeout:**
   ```sql
   SET lock_timeout = '5s';  -- fail instead of waiting indefinitely
   ```
4. **Detect and retry:**
   ```python
   try:
       with db.transaction():
           transfer_funds(from_id, to_id, amount)
   except DeadlockDetected:
       # Postgres error code 40P01
       retry_with_backoff()
   ```

---

## 3. Application-Level Concurrency

### 3.1 In-Process Mutex/Locks

Use when: multiple threads/coroutines in a single process need exclusive access to a shared resource.

```python
import threading

lock = threading.Lock()

def update_shared_counter():
    with lock:
        # only one thread at a time
        shared_state["counter"] += 1
```

```python
# Async equivalent
import asyncio

lock = asyncio.Lock()

async def update_shared_resource():
    async with lock:
        data = await fetch_current()
        await save_updated(data)
```

**Warning:** In-process locks do NOT protect across multiple server instances. Use distributed locks for that.

### 3.2 Distributed Locks

**Redis SETNX with TTL (simple distributed lock):**
```python
import redis, uuid, time

def acquire_lock(r: redis.Redis, lock_name: str, ttl: int = 30) -> str | None:
    token = str(uuid.uuid4())
    acquired = r.set(f"lock:{lock_name}", token, nx=True, ex=ttl)
    return token if acquired else None

def release_lock(r: redis.Redis, lock_name: str, token: str) -> bool:
    # Atomic check-and-delete via Lua script
    script = """
    if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
    else
        return 0
    end
    """
    return r.eval(script, 1, f"lock:{lock_name}", token) == 1
```

**Critical edge cases with Redis locks:**
- If the lock holder crashes, TTL ensures eventual release -- but during TTL, work might stall.
- If the lock holder is slow and TTL expires, another process acquires the lock -- now two processes think they hold it.
- Mitigation: use a fencing token (monotonically increasing) and verify it at the resource.

**Redlock (multi-node Redis lock):**
- Acquire lock on N/2+1 independent Redis nodes within a time limit.
- Controversial: Martin Kleppmann's analysis shows it can fail under clock skew and process pauses.
- Use only if you understand the failure modes. For strong correctness, prefer ZooKeeper/etcd.

**ZooKeeper / etcd -- strong consistency:**
- Based on consensus (Raft/ZAB). Lock is genuinely exclusive even under partitions.
- Higher latency than Redis but stronger guarantees.
- Use for leader election, distributed barriers, configuration locks.

**Database advisory locks (simplest correct distributed lock):**
```python
# If you already have Postgres, this is often the best option
with db.transaction():
    acquired = db.query("SELECT pg_try_advisory_xact_lock(?)", lock_id)
    if acquired:
        do_exclusive_work()
    # lock auto-released at commit
```

Advantages: no extra infrastructure, transactional, survives crashes cleanly.

### 3.3 Lock-Free Patterns

**Atomic database operations:**
```sql
-- Atomic increment (no lock needed)
UPDATE counters SET value = value + 1 WHERE name = 'page_views';

-- Atomic append (Postgres array)
UPDATE events SET tags = array_append(tags, 'processed') WHERE id = 42;

-- Atomic insert-or-update
INSERT INTO kv_store (key, value) VALUES ('config', '{"v":2}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

**Redis atomic operations:**
```
INCR page_views              # atomic increment
LPUSH queue:jobs job_data    # atomic push
SETNX lock:resource token    # atomic set-if-not-exists
```

**Immutable data structures:** Instead of updating a row, insert a new version. The latest row (by timestamp or sequence) is the current value. This eliminates update races entirely.

```sql
-- Instead of UPDATE accounts SET balance = ...
INSERT INTO account_ledger (account_id, amount, created_at)
VALUES (42, -500, NOW());

-- Current balance is always a sum
SELECT SUM(amount) FROM account_ledger WHERE account_id = 42;
```

---

## 4. Message Queue Concurrency

### 4.1 Delivery Guarantees

| Guarantee | Description | Implementation |
|---|---|---|
| At-most-once | Fire and forget. Message may be lost. | ACK before processing. |
| At-least-once | Message delivered 1+ times. May duplicate. | ACK after processing. |
| Exactly-once | Message processed exactly once. | At-least-once + idempotent consumer. |

**True exactly-once is a distributed systems myth in the general case.** Achieve it practically via idempotent consumers:

```python
def handle_message(msg):
    # Deduplicate using message ID
    inserted = db.execute(
        "INSERT INTO processed_messages (msg_id) VALUES (?) ON CONFLICT DO NOTHING",
        msg.id
    )
    if inserted == 0:
        msg.ack()  # already processed, just ack
        return

    with db.transaction():
        process_business_logic(msg.payload)
        # The INSERT above + business logic should be in same transaction
        # for true atomicity

    msg.ack()
```

### 4.2 Message Ordering

**Kafka partition ordering:**
- Messages within a single partition are strictly ordered.
- Use a partition key (e.g., user_id, order_id) to ensure related messages go to the same partition.
- Across partitions: no ordering guarantee.

```python
# Ensure all events for an order go to the same partition
producer.send(
    topic="order-events",
    key=str(order_id).encode(),  # partition key
    value=serialize(event)
)
```

**Out-of-order handling strategies:**
1. **Buffer and reorder:** Hold messages in memory, emit in sequence order. Complex, needs sequence numbers.
2. **Idempotent + commutative operations:** Design operations so order doesn't matter (e.g., SET rather than INCREMENT).
3. **Version check:** Only apply if event version > current version, discard stale events.

### 4.3 Consumer Group Rebalancing

When a consumer joins/leaves a Kafka consumer group, partitions are reassigned. During rebalancing:
- Some messages may be redelivered (offset not yet committed).
- Ordering guarantees are temporarily weakened across the reassignment boundary.

**Mitigation:** Use cooperative sticky assignor, commit offsets frequently, and ensure idempotent processing.

### 4.4 Poison Messages

Messages that always fail (malformed, trigger bugs, violate invariants).

```python
MAX_RETRIES = 3

def consume(msg):
    retry_count = int(msg.headers.get("x-retry-count", 0))
    try:
        process(msg)
        msg.ack()
    except Exception as e:
        if retry_count >= MAX_RETRIES:
            send_to_dlq(msg, error=str(e))  # Dead Letter Queue
            msg.ack()  # remove from main queue
            alert_ops(msg, e)
        else:
            msg.headers["x-retry-count"] = str(retry_count + 1)
            requeue_with_backoff(msg, delay=2 ** retry_count)
```

### 4.5 Acknowledgment Strategies

**ACK before processing (at-most-once):**
```python
msg.ack()          # message removed from queue
process(msg)       # if this crashes, message is lost
```

**ACK after processing (at-least-once):**
```python
process(msg)       # if this crashes, message redelivered
msg.ack()          # consumer MUST be idempotent
```

**Batch ACK (efficiency vs. risk):**
```python
batch = consumer.poll(max_messages=100)
for msg in batch:
    process(msg)  # if crash at msg 50, msgs 1-49 reprocessed
consumer.commit()  # single commit for whole batch
```

Batch ACK is faster but increases the reprocessing window on failure. Size the batch to balance throughput against acceptable reprocessing.

---

## 5. Async Patterns

### 5.1 Saga Pattern

Manage distributed transactions across services without a global 2PC (two-phase commit).

**Orchestration vs. Choreography:**

| Aspect | Orchestration | Choreography |
|---|---|---|
| Coordination | Central saga orchestrator | Each service listens to events |
| Coupling | Services coupled to orchestrator | Services coupled to event schema |
| Visibility | Easy to trace -- single place | Hard to trace -- distributed flow |
| Complexity | Orchestrator can become complex | Emergent behavior, harder to reason about |
| Compensation | Orchestrator triggers rollbacks | Each service must know its own rollback trigger |
| Best for | Complex flows, many steps | Simple flows, few services |

**Orchestration example:**
```python
class OrderSaga:
    def execute(self, order):
        try:
            reservation = inventory_service.reserve(order.items)
            payment = payment_service.charge(order.total)
            shipping = shipping_service.schedule(order)
        except PaymentFailed:
            inventory_service.release(reservation)
            raise
        except ShippingFailed:
            payment_service.refund(payment)
            inventory_service.release(reservation)
            raise
```

**Choreography example:**
```
OrderService  ──publishes──→  "OrderCreated"
InventoryService  ──listens──→  "OrderCreated" ──publishes──→  "InventoryReserved"
PaymentService  ──listens──→  "InventoryReserved" ──publishes──→  "PaymentCharged"
ShippingService  ──listens──→  "PaymentCharged" ──publishes──→  "OrderShipped"

On failure:
PaymentService  ──publishes──→  "PaymentFailed"
InventoryService  ──listens──→  "PaymentFailed" ──releases reservation──
```

### 5.2 Outbox Pattern

Problem: writing to DB and publishing an event is not atomic. If the app crashes after DB write but before publish, the event is lost.

```
WRONG:
  db.save(order)           # succeeds
  message_queue.publish()  # app crashes here ← event lost
```

**Solution -- transactional outbox:**
```python
with db.transaction():
    db.execute("INSERT INTO orders (...) VALUES (...)")
    db.execute("""
        INSERT INTO outbox (aggregate_id, event_type, payload, created_at)
        VALUES (?, 'OrderCreated', ?, NOW())
    """, order_id, serialize(event))
# Both writes succeed or both fail -- atomic.

# Separate process polls outbox and publishes:
def outbox_relay():
    while True:
        events = db.query(
            "SELECT * FROM outbox WHERE published = false ORDER BY created_at LIMIT 100"
        )
        for event in events:
            message_queue.publish(event.event_type, event.payload)
            db.execute("UPDATE outbox SET published = true WHERE id = ?", event.id)
```

**Key detail:** The relay must be idempotent. If it crashes after publishing but before marking published=true, it will re-publish. Consumers must handle duplicates.

### 5.3 CDC (Change Data Capture)

Instead of polling the outbox table, stream database changes directly.

**PostgreSQL logical replication:**
```sql
-- Create a publication for the outbox table
CREATE PUBLICATION outbox_pub FOR TABLE outbox;

-- Debezium or similar reads the WAL and publishes to Kafka
```

**Debezium connector (conceptual config):**
```json
{
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "database.hostname": "db-host",
  "database.dbname": "myapp",
  "table.include.list": "public.outbox",
  "transforms": "outbox",
  "transforms.outbox.type": "io.debezium.transforms.outbox.EventRouter"
}
```

Advantages over polling: lower latency, no polling overhead, no missed events. Disadvantage: infrastructure complexity.

### 5.4 Event Sourcing

Store events (facts) as the source of truth rather than mutable state.

```
Events (append-only):
  1. AccountOpened(id=42, owner="Alice")
  2. MoneyDeposited(id=42, amount=1000)
  3. MoneyWithdrawn(id=42, amount=200)
  4. MoneyDeposited(id=42, amount=500)

Current state (projection):
  Account 42: balance=1300, owner="Alice"
```

**Implementation sketch:**
```python
# Write side: append events
def withdraw(account_id, amount):
    events = load_events(account_id)
    state = replay(events)
    if state.balance < amount:
        raise InsufficientFunds()
    append_event(account_id, MoneyWithdrawn(amount=amount))

# Read side: build projection
def get_balance(account_id):
    events = load_events(account_id)
    state = replay(events)
    return state.balance

# For performance, maintain a materialized projection
# updated asynchronously as events are appended
```

**Concurrency control for event sourcing:** Use expected version on append.
```sql
INSERT INTO events (aggregate_id, version, event_type, data)
VALUES ($1, $2, $3, $4);
-- UNIQUE constraint on (aggregate_id, version) prevents conflicts
```

### 5.5 CQRS (Command Query Responsibility Segregation)

Separate the write model (commands) from the read model (queries).

```
Commands (writes):           Queries (reads):
  ┌─────────────┐             ┌──────────────────┐
  │ Command Bus  │             │ Read-optimized DB │
  │  → Domain    │ ──events──→ │ (denormalized,    │
  │  → Event Store│            │  materialized)    │
  └─────────────┘             └──────────────────┘
```

**When to use:**
- Read and write patterns are very different (complex writes, simple reads or vice versa).
- Need to scale reads and writes independently.
- Using event sourcing (natural fit).

**When NOT to use:**
- Simple CRUD. CQRS adds significant complexity.
- Eventual consistency between write and read models is unacceptable for your use case.

---

## 6. Common Concurrency Bugs in Web Applications

### 6.1 Counter/Balance Increment

**Bug:** read balance, add in application, write back.
```python
# Two concurrent requests both read balance=100
balance = db.query("SELECT balance FROM wallets WHERE user_id = ?", uid)
db.execute("UPDATE wallets SET balance = ? WHERE user_id = ?", balance + 50, uid)
# Both write 150. Should be 200.
```

**Fix:**
```sql
UPDATE wallets SET balance = balance + 50 WHERE user_id = $1;
```

### 6.2 Inventory Oversell

**Bug:** check stock, then decrement in separate step.
```python
stock = db.query("SELECT stock FROM products WHERE id = ?", pid)
if stock > 0:
    db.execute("UPDATE products SET stock = stock - 1 WHERE id = ?", pid)
```

**Fix:**
```sql
UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock > 0
RETURNING stock;
-- Check rows_affected. If 0, item is out of stock.
```

### 6.3 Duplicate Form Submission

**Bug:** user double-clicks submit, two identical requests arrive.

**Fix -- idempotency key:**
```python
@app.post("/payments")
def create_payment(request):
    idempotency_key = request.headers["Idempotency-Key"]

    existing = db.query(
        "SELECT response FROM idempotency_store WHERE key = ?",
        idempotency_key
    )
    if existing:
        return existing.response  # return cached response

    with db.transaction():
        result = process_payment(request.body)
        db.execute(
            "INSERT INTO idempotency_store (key, response, created_at) VALUES (?, ?, NOW())",
            idempotency_key, serialize(result)
        )
    return result
```

**Implementation notes:**
- Client generates the idempotency key (UUID) and sends it in a header.
- Store the full response so duplicate requests get the same answer.
- Set a TTL on the idempotency store (e.g., 24 hours) to avoid unbounded growth.
- The INSERT must be in the same transaction as the business logic.

### 6.4 Session Race Condition

**Bug:** two concurrent requests read session, both modify, last write wins.
```
Request A: read session{cart: [item1]} → add item2 → write {cart: [item1, item2]}
Request B: read session{cart: [item1]} → add item3 → write {cart: [item1, item3]}
Result: cart = [item1, item3] -- item2 lost
```

**Fixes:**
1. **Atomic session operations:** Store session in Redis, use atomic operations.
   ```
   SADD session:123:cart item2    # atomic add to set
   ```
2. **Optimistic locking on session:**
   ```python
   session = redis.get("session:123")
   version = session["version"]
   session["cart"].append(new_item)
   session["version"] += 1
   # Use Lua script for atomic check-and-set
   ```
3. **Narrow the session scope:** Don't store mutable application state in the session. Store cart in the database with proper concurrency control.

---

## Quick Decision Guide

**Choosing a concurrency control strategy:**

```
Is the conflict rare?
  YES → Optimistic locking (version column, CAS)
  NO  → Pessimistic locking (SELECT FOR UPDATE)

Can the operation be expressed as a single atomic SQL?
  YES → Do that. No locks needed.
        (UPDATE SET x = x + 1, INSERT ON CONFLICT, etc.)
  NO  → Use a transaction with appropriate isolation.

Do you need cross-service coordination?
  YES → Saga pattern (orchestration for complex flows, choreography for simple ones)
  NO  → Database transaction is sufficient.

Do you need a distributed lock?
  YES → Do you already have Postgres? Use advisory locks.
        Need sub-millisecond? Use Redis SETNX (accept edge cases).
        Need strong correctness? Use etcd/ZooKeeper.
  NO  → In-process mutex is fine.

Are you processing messages from a queue?
  → Always implement idempotent consumers.
  → Use deduplication table in same transaction as business logic.
  → ACK after processing, never before.
```
