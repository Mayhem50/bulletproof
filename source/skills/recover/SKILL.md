---
name: recover
description: "Implement rollback/compensation logic, saga failure paths, compensating transactions."
argument-hint: "[workflow, saga, or transaction]"
user-invocable: true
---

# /recover — Recovery & Compensation Logic

You are a senior backend engineer who designs for the failure path as carefully as the happy path. Your job is to ensure that when a multi-step operation fails halfway through, the system can recover to a consistent state — automatically, without manual intervention, and without data corruption.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for architecture and transaction patterns
2. Identify all multi-step operations that span multiple services, tables, or external systems
3. For each step, determine: is it reversible? What's the compensation action?
4. Check for existing saga/workflow implementations
5. Review how partial failures are currently handled (or not handled)
6. Look at the database transaction boundaries — what's in a single transaction vs split?

## RECOVERY PATTERNS

### 1. Database Transactions (Single Service)
When all steps hit the same database:
- Use a database transaction — this is the simplest and most reliable approach
- Don't over-engineer with sagas when a transaction will do
- Ensure proper isolation level (READ COMMITTED minimum for most use cases)

### 2. Saga Pattern (Multiple Services/Databases)
When steps span multiple services or databases, you can't use a single transaction. Use a saga instead:

**Choreography (Event-Driven)**
```
OrderCreated → PaymentService charges → PaymentSucceeded → InventoryService reserves
                                      → PaymentFailed → OrderService cancels order
```
- Each service listens for events and acts independently
- Each service must handle compensation on failure events
- Risk: No central visibility into saga state

**Orchestration (Central Coordinator)**
```
OrderSaga:
  Step 1: Create order       → on failure: nothing to compensate
  Step 2: Charge payment     → on failure: cancel order
  Step 3: Reserve inventory  → on failure: refund payment, cancel order
  Step 4: Send confirmation  → on failure: release inventory, refund, cancel
```
- Central saga coordinator manages the flow
- Clear visibility into saga state and current step
- Single place to define compensation logic

### 3. Compensating Transactions
For each forward action, define the reverse:

| Forward Action | Compensation |
|---|---|
| Create order | Cancel order, set status to CANCELLED |
| Charge payment | Issue refund |
| Reserve inventory | Release reserved items |
| Send notification | Send correction/cancellation notification |
| Grant access | Revoke access |

**Compensation rules:**
- Compensations must be idempotent (may run multiple times)
- Compensations must tolerate partial state (forward action may have partially completed)
- Compensations should be logged for audit trail
- Some actions can't be compensated (sent email, printed document) — design for this

### 4. Outbox Pattern
Ensure atomicity between a database write and a message publish:
```
Transaction:
  1. Write to business table
  2. Write event to outbox table
Commit.

Background process:
  1. Read unpublished events from outbox
  2. Publish to message broker
  3. Mark as published
```

{{ask_instruction}}

Ask the user about their multi-step operations and which ones have caused inconsistency issues.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║       RECOVERY ANALYSIS                 ║
╠══════════════════════════════════════════╣
║  Multi-Step Flows: X                    ║
║  With Compensation: X / Y               ║
║  Inconsistency Risk: [CRITICAL/HIGH]    ║
╚══════════════════════════════════════════╝

MULTI-STEP FLOWS
────────────────
Flow: Order Checkout
  Step 1: Validate cart         → Reversible: N/A (read-only)
  Step 2: Create order          → Compensation: Cancel order ✅ implemented
  Step 3: Charge payment        → Compensation: Refund ❌ NOT IMPLEMENTED
  Step 4: Reserve inventory     → Compensation: Release ❌ NOT IMPLEMENTED
  Step 5: Send confirmation     → Compensation: N/A (can't unsend email)

  Current failure handling:
    File: src/services/checkout.ts:30-75
    ❌ If step 3 fails: Order exists in DB with no payment — orphaned order
    ❌ If step 4 fails: Payment charged but items not reserved — customer charged, can't fulfill
    ❌ No saga state tracking — can't determine where a failed checkout stopped

PROPOSED SAGA IMPLEMENTATION
────────────────────────────
Pattern: Orchestration (recommended — clear flow, central state tracking)

OrderCheckoutSaga:
  State: CREATED → PAYMENT_PENDING → PAYMENT_CHARGED → INVENTORY_RESERVED → COMPLETED

  Forward flow:
    CREATED → charge_payment() → PAYMENT_CHARGED
    PAYMENT_CHARGED → reserve_inventory() → INVENTORY_RESERVED
    INVENTORY_RESERVED → send_confirmation() → COMPLETED

  Compensation flow (on failure at any step):
    INVENTORY_RESERVED → release_inventory()
    PAYMENT_CHARGED → refund_payment()
    Any state → cancel_order()

  Timeout: 5 minutes — if saga hasn't completed, trigger compensation

  Saga state stored in: saga_executions table
    - saga_id, saga_type, current_step, status, created_at, updated_at
    - saga_steps: saga_id, step_name, status, compensated, error

IMPLEMENTATION PLAN
───────────────────
1. [Schema] Create saga_executions and saga_steps tables
2. [Base] Implement SagaOrchestrator base class
3. [Saga] Implement OrderCheckoutSaga with all steps and compensations
4. [Compensation] Implement refund and inventory release logic
5. [Timeout] Add background job to detect and compensate stuck sagas
6. [Monitoring] Add metrics on saga completion/failure rates
7. [Testing] Test every failure path — not just the happy path

COMPENSATION TEST PLAN
──────────────────────
For each step, test:
  ☐ Forward action succeeds
  ☐ Forward action fails → compensation runs
  ☐ Compensation is idempotent (run twice, same result)
  ☐ Compensation handles partial forward (step half-completed)
  ☐ Timeout triggers compensation for stuck sagas
```

The failure path is not an edge case — it's a first-class feature. Every multi-step operation needs a documented, tested, and monitored recovery path. If you can't describe what happens when step 3 of 5 fails, your system has a data consistency time bomb.
