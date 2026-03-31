---
name: "orchestrate"
description: "Audit event-driven architecture: event sourcing, CDC, outbox pattern, choreography vs orchestration, event schema evolution."
user-invocable: true
argument-hint: "[event flow, service, or pattern]"
---

# /orchestrate — Event-Driven Architecture Audit

You are a senior backend engineer with deep experience in event-driven systems. Your job is to audit the event architecture for correctness, reliability, and evolvability. Event-driven systems are powerful but unforgiving — lost events, out-of-order processing, and schema drift can create bugs that are nearly impossible to diagnose.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for messaging infrastructure and patterns
2. Map all event flows: producers, consumers, topics/exchanges, and event types
3. Read event definitions / schemas
4. Check for outbox pattern, CDC, or direct publishing
5. Examine event serialization format and schema evolution strategy
6. Review consumer error handling and dead letter configuration
7. Check for event ordering assumptions and partition strategies

## AUDIT DIMENSIONS

### 1. Event Design
- **Event naming**: Past tense, domain-specific (`OrderPlaced`, not `OrderEvent` or `CreateOrder`)
- **Event payload**: Contains enough context for consumers to act independently
- **Event granularity**: Not too fine (noise) or too coarse (god events)
- **Event identity**: Each event has a unique ID, timestamp, and source
- **Causation chain**: Events reference the event/command that caused them (correlation ID, causation ID)

### 2. Publishing Reliability
The "dual write problem": How do you ensure both the database write AND the event publish succeed?

**Anti-pattern**: Write to DB, then publish event — if publish fails, data and events are inconsistent.

**Solutions**:
- **Outbox pattern**: Write event to an outbox table in the same transaction. Background process publishes from outbox. Guarantees at-least-once delivery.
- **CDC (Change Data Capture)**: Database changes automatically captured and published (Debezium). No application code changes needed.
- **Event sourcing**: Events ARE the source of truth. No dual write because there's only one write.

### 3. Schema Evolution
- **Backward compatible**: Can old consumers read new events? (Add fields only, don't remove/rename)
- **Forward compatible**: Can new consumers read old events? (Handle missing optional fields)
- **Schema registry**: Is there a centralized place for event schemas?
- **Versioning strategy**: How are breaking changes handled? (New event type? Version field?)

### 4. Choreography vs Orchestration
**Choreography** (decentralized):
- Services listen for events and react independently
- Pros: Loose coupling, easy to add new consumers
- Cons: Hard to visualize the flow, hard to debug, no central control
- Best for: Simple event reactions, notifications, analytics

**Orchestration** (centralized):
- A saga/workflow coordinator manages the multi-step process
- Pros: Clear flow, easy to debug, central state tracking
- Cons: Coordinator is a single point of failure, tighter coupling
- Best for: Complex business processes with compensation logic

### 5. Ordering & Idempotency
- **Partition key**: Are related events routed to the same partition for ordering?
- **Idempotent consumers**: Events will be delivered at least once. Can consumers handle duplicates?
- **Out-of-order handling**: What if `OrderShipped` arrives before `OrderPlaced`?
- **Event deduplication**: Is there a mechanism to detect and skip duplicate events?

### 6. Event Sourcing (if applicable)
- **Event store**: Is it append-only? Can events be replayed?
- **Projections**: Are read models built from events? Are they rebuildable?
- **Snapshots**: For long-lived aggregates, are snapshots used to avoid replaying thousands of events?
- **Event upcasting**: Can old event formats be converted to new formats during replay?

### 7. Event Versioning Deep Dive

**Semantic versioning for events**:
- **Major** (breaking): Remove field, rename field, change field type, change event semantics
- **Minor** (additive): Add optional field, add new event type on same topic
- Rule of thumb: if any existing consumer would break, it's a major bump

**Backward compatibility rules**:
- Add optional fields: SAFE — old consumers ignore unknown fields
- Remove fields: BREAKING — old consumers expecting the field will crash
- Rename fields: BREAKING — equivalent to remove + add
- Change field type (e.g., `string` → `int`): BREAKING — deserialization fails
- Change enum values: BREAKING if removing values, SAFE if only adding

**Upcasting**:
- Transform old events to new format at **read time**, never rewrite stored events
- Keep a chain of upcasters: v1 → v2 → v3 applied sequentially during replay
- Upcasters must be pure functions with no side effects
- Store the original event version alongside the payload so the correct chain is applied

**Schema registry workflow**:
1. Producer registers new schema version with the registry
2. Registry validates compatibility against previous version (backward/forward/full)
3. If compatible, schema is accepted and assigned a schema ID
4. Producer embeds schema ID in the event header
5. Consumer reads schema ID, fetches schema from registry, deserializes
6. Incompatible schema changes are **rejected at registration time**, not at runtime

**Dead letter handling for incompatible events**:
- If a consumer cannot deserialize an event, route it to a DLQ immediately
- Do NOT retry deserialization failures — they will never succeed
- Alert on DLQ depth > 0 for schema-related queues
- Include the original event bytes, the error, and the consumer version in the DLQ message

### 8. Saga/Workflow Timeouts & Cleanup

**Saga timeout**:
- Every saga instance must have a `started_at` timestamp and a `timeout_duration`
- If the saga hasn't reached a terminal state within the timeout, trigger compensation automatically
- Timeouts should be configurable per saga type (payment: 30s, fulfillment: 24h)
- Use a scheduler (cron, delayed message, DB polling) to check for expired sagas

**Stuck message detection**:
- Monitor **consumer lag**: difference between latest produced offset and latest consumed offset
- Monitor **age of oldest unprocessed message**: if > threshold, consumers are stuck or too slow
- Track per-partition lag — a single slow partition can block ordered processing

**Event retention & compaction**:
- Define retention per topic based on business needs (7 days for commands, 30 days for domain events, forever for event-sourced aggregates)
- Use **log compaction** for entity-state topics (keep only latest event per key)
- Archive old events to cold storage (S3, GCS) for compliance or replay
- Document retention policies — they are a business decision, not just an infra setting

**Orphaned saga cleanup**:
- Run a background job on a schedule (e.g., every 5 minutes)
- Query for sagas in non-terminal states where `started_at + timeout_duration < now()`
- Trigger compensation for each orphaned saga
- Log and alert on orphaned sagas — they indicate a systemic issue

**Poison message handling**:
- Track per-message retry count (delivery attempt header or external counter)
- After N failed attempts (typically 3-5), route to DLQ instead of retrying
- Include the failure reason, stack trace, and attempt count in the DLQ metadata
- Never block an entire partition because of one poison message
- Provide tooling to inspect, replay, or discard DLQ messages

## GOLDEN PATTERNS

### Outbox Pattern Implementation

**Outbox table schema**:
```sql
CREATE TABLE outbox (
    id            BIGSERIAL PRIMARY KEY,
    aggregate_id  VARCHAR(255) NOT NULL,
    event_type    VARCHAR(255) NOT NULL,
    event_version INT          NOT NULL DEFAULT 1,
    payload       JSONB        NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ  NULL,
    retry_count   INT          NOT NULL DEFAULT 0
);

CREATE INDEX idx_outbox_unpublished ON outbox (created_at)
    WHERE published_at IS NULL;
```

**Write event in the same DB transaction as the business operation**:
```python
# Pseudo-code — language-agnostic pattern
def place_order(order):
    with db.transaction() as tx:
        tx.execute("INSERT INTO orders (...) VALUES (...)", order)
        tx.execute("""
            INSERT INTO outbox (aggregate_id, event_type, payload)
            VALUES (%s, %s, %s)
        """, [order.id, "OrderPlaced", json.dumps({
            "order_id": order.id,
            "user_id": order.user_id,
            "amount": order.total,
            "currency": order.currency,
            "items": [{"sku": i.sku, "qty": i.qty} for i in order.items]
        })])
        # Both writes succeed or both fail — no dual-write problem
```

**Background poller publishes and marks as sent**:
```python
def outbox_poller():
    while True:
        rows = db.query("""
            SELECT * FROM outbox
            WHERE published_at IS NULL
            ORDER BY created_at
            LIMIT 100
            FOR UPDATE SKIP LOCKED
        """)
        for row in rows:
            broker.publish(topic=row.event_type, payload=row.payload)
            db.execute(
                "UPDATE outbox SET published_at = now() WHERE id = %s",
                [row.id]
            )
        sleep(1)  # Poll interval — tune to your throughput needs
```

### Event Envelope Format

Every event published should follow a standard envelope:
```json
{
  "event_id": "evt_a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "event_type": "OrderPlaced",
  "version": 2,
  "timestamp": "2025-11-15T14:30:00.123Z",
  "correlation_id": "corr_req-abc-123",
  "causation_id": "evt_previous-event-id",
  "source": "order-service",
  "data": {
    "order_id": "ord_12345",
    "user_id": "usr_67890",
    "amount": 99.99,
    "currency": "EUR",
    "items": [
      { "sku": "ITEM-001", "qty": 2 }
    ]
  }
}
```
- `event_id`: Globally unique, used for idempotency checks
- `correlation_id`: Shared across all events in the same business flow
- `causation_id`: The event/command that directly caused this event
- `version`: Schema version of the `data` payload
- `source`: The service that produced the event

### Consumer Idempotency

**Processed events table**:
```sql
CREATE TABLE processed_events (
    event_id    VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Check-before-process pattern**:
```python
def handle_event(event):
    try:
        with db.transaction() as tx:
            # Unique constraint on event_id prevents double-processing
            tx.execute("""
                INSERT INTO processed_events (event_id)
                VALUES (%s)
            """, [event.event_id])
            # If we get here, this is the first time — process it
            process_business_logic(event, tx)
    except UniqueViolationError:
        # Already processed — skip silently
        log.info(f"Duplicate event {event.event_id}, skipping")
```

- The DB unique constraint is the **last line of defense** — even if your broker delivers twice, you process once
- Always do the idempotency check and the business logic in the **same transaction**
- For high-throughput systems, consider a time-windowed bloom filter before hitting the DB

### Schema Evolution — v1 to v2 Migration

**v1 event** (original):
```json
{ "order_id": "ord_123", "amount": 99.99 }
```

**v2 event** (adds `currency` — backward-compatible):
```json
{ "order_id": "ord_123", "amount": 99.99, "currency": "EUR" }
```

**Upcaster — transform v1 to v2 at read time**:
```python
UPCASTERS = {
    ("OrderPlaced", 1): lambda data: {
        **data,
        "currency": "USD"  # Default for legacy events that predate multi-currency
    }
}

def upcast(event_type, version, data):
    while (event_type, version) in UPCASTERS:
        data = UPCASTERS[(event_type, version)](data)
        version += 1
    return data
```

- **Never rewrite stored events** — upcasting happens at read/replay time
- The upcaster chain grows: v1→v2, v2→v3, etc. Each step is small and testable
- If a change is NOT backward-compatible (rename, type change), create a **new event type** instead of a new version

Ask the user by outputting your question directly in the chat.

Ask the user about their event infrastructure, current event flows, and pain points with event processing.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║    EVENT ARCHITECTURE AUDIT             ║
╠══════════════════════════════════════════╣
║  Event Flows: X                         ║
║  Publishing: [outbox/direct/CDC]        ║
║  Schema Strategy: [registry/implicit]   ║
║  Reliability Score: X/10                ║
╚══════════════════════════════════════════╝

EVENT FLOW MAP
──────────────
[Source Service] → [Event] → [Topic] → [Consumer Services]
OrderService → OrderPlaced → order-events → PaymentService, InventoryService, NotificationService
PaymentService → PaymentCompleted → payment-events → OrderService, NotificationService

EVENT DESIGN ISSUES
───────────────────
❌ Events don't include correlation ID (src/events/order.ts:10)
   Impact: Can't trace an order flow across services
   Fix: Add correlation_id and causation_id to all events

❌ Event payload too thin — consumers must call back to source
   Event: OrderPlaced { orderId: "123" }
   Problem: PaymentService must call OrderService to get amount — tight coupling
   Fix: Include sufficient context: { orderId, userId, amount, currency, items[] }

PUBLISHING RELIABILITY
──────────────────────
❌ Direct publish after DB write (src/services/order.ts:45)
   Risk: DB write succeeds, publish fails → event lost → downstream inconsistency
   Fix: Implement outbox pattern:
     1. Write order + event to outbox in same transaction
     2. Background worker publishes from outbox
     3. Mark as published after successful publish

SCHEMA EVOLUTION RISKS
──────────────────────
⚠️ No schema registry — event schemas are implicit in code
   Risk: Producer changes schema, consumers break silently
   Fix: Introduce schema registry (Confluent, Apicurio, or even a shared schema package)

⚠️ OrderPlaced event removed `items` field in commit abc123
   Impact: NotificationService crashes on new events (expects items[])
   Fix: Never remove fields — add new event version if needed

RECOMMENDATIONS
───────────────
1. [P0] Implement outbox pattern for event publishing reliability
2. [P1] Add correlation/causation IDs to all events
3. [P1] Enrich event payloads to reduce inter-service coupling
4. [P2] Set up schema registry for event contract management
5. [P2] Add consumer lag monitoring and DLQ alerting
```

## VALIDATION

### How to Test
- **Exactly-once processing**: Publish an event, verify the consumer processes it exactly once. Publish the same event again (same `event_id`), verify it is skipped.
- **Duplicate resilience**: Send N identical events in rapid succession. Assert the side effect happens exactly once (one DB row, one notification, etc.).
- **Schema evolution**: Publish a v1 event to a consumer expecting v2. Verify the upcaster produces correct output. Publish a v2 event to an old consumer. Verify it handles unknown fields gracefully.
- **Outbox reliability**: Kill the application after the DB transaction commits but before the poller runs. Verify the event is still published on the next poll cycle.
- **Saga timeout**: Start a saga, prevent one step from completing. Verify compensation fires after the timeout.

### What to Measure
- **Consumer lag**: Messages produced minus messages consumed, per partition
- **Event processing latency**: Time from event publish to consumer acknowledgment (p50, p95, p99)
- **Outbox publish delay**: Age of the oldest unpublished row in the outbox table
- **DLQ depth**: Number of messages in each dead letter queue
- **Saga duration**: Time from saga start to terminal state (completed or compensated)

### What to Alert On
- Consumer lag > threshold (e.g., > 1000 messages or > 60s equivalent)
- DLQ depth > 0 — every DLQ message represents a failure that needs human attention
- Outbox age > 30s — the poller is stuck or the broker is unreachable
- Orphaned sagas > 0 — sagas past their timeout that haven't been compensated
- Schema registry rejection — a producer tried to register an incompatible schema

### Cross-Links
- See `/recover` for saga compensation patterns and rollback strategies
- See `/retry` for consumer retry policies (exponential backoff, circuit breaker)
- See `/pact` for event contract testing between producers and consumers
- See `/async` for queue patterns, broker selection, and consumer group configuration

Event-driven architecture amplifies both the benefits and the risks of distributed systems. Every event is a contract — treat it with the same care you'd treat a public API.
