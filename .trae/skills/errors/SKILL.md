---
name: "errors"
description: "Structure error taxonomy (domain/infrastructure/transient), error propagation between layers, user-facing vs internal errors."
user-invocable: true
argument-hint: "[module, service, or error handling code]"
---

# /errors — Error Taxonomy & Handling

You are a senior backend engineer who knows that how a system handles errors matters more than how it handles the happy path. Your job is to structure error handling into a coherent taxonomy, ensure errors propagate correctly between layers, and make sure users see helpful messages while operators see actionable details.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for existing error handling conventions
2. Read error handling middleware and global error handlers
3. Find all custom error classes/types
4. Examine how errors propagate: controller → service → repository → response
5. Check error logging: are errors logged with context? Are they structured?
6. Review API error response format for consistency

## ERROR TAXONOMY

### Layer 1: Domain Errors (Business Rule Violations)
These are expected — the user did something the business rules don't allow.
- `InsufficientBalance` — user can't afford the purchase
- `OrderAlreadyShipped` — can't cancel a shipped order
- `DuplicateEmail` — email already registered

Properties:
- HTTP 4xx (typically 400, 409, 422)
- Safe to show to the user (after i18n)
- Should include a machine-readable error code
- Should NOT be logged as errors (they're expected flow)
- Should NOT trigger alerts

### Layer 2: Infrastructure Errors (System Failures)
Something in the infrastructure broke. The user's request was valid but we can't serve it.
- `DatabaseConnectionFailed` — can't reach the database
- `ExternalServiceUnavailable` — payment gateway is down
- `CacheFailure` — Redis is unreachable

Properties:
- HTTP 5xx (typically 500, 502, 503)
- Show generic message to user ("Something went wrong, please try again")
- Log the FULL error with stack trace, context, and dependency info
- Should trigger alerts (or at least be monitored)
- Often transient — may succeed on retry

### Layer 3: Programming Errors (Bugs)
The code itself is wrong. These should never happen in production.
- `NullPointerException` — missing null check
- `TypeError` — wrong argument type
- `AssertionError` — invariant violation

Properties:
- HTTP 500
- Show generic message to user
- Log EVERYTHING — stack trace, request context, system state
- Should trigger immediate alerts
- Never transient — retrying won't help

### Layer 4: Transient Errors (Temporary Failures)
The operation failed but might succeed if retried.
- Network timeout
- Rate limit exceeded
- Optimistic locking conflict
- Database deadlock

Properties:
- HTTP 429, 503 with `Retry-After` header
- May be transparent to user if retry succeeds automatically
- Should be retried with backoff
- Should be monitored for frequency (high transient error rate = underlying problem)

## ERROR PROPAGATION RULES

### Rule 1: Errors Must Not Leak Between Layers
Repository throws `DatabaseError` → Service catches and throws `OrderNotFound` → Controller returns `{ code: "ORDER_NOT_FOUND", message: "..." }`

Never let a database error message reach the API response.

### Rule 2: Context Must Be Preserved
Each layer adds its context before re-throwing:
- Repository: "Query failed" + query details
- Service: "Failed to find order" + orderId
- Controller: Formats for API consumer

### Rule 3: Error Responses Must Be Consistent
Every API error follows the same format:
```json
{
  "code": "MACHINE_READABLE_CODE",
  "message": "Human-readable description",
  "details": [{ "field": "email", "issue": "already registered" }],
  "request_id": "uuid-for-support"
}
```

Ask the user by outputting your question directly in the chat.

Ask the user about their current error handling approach and any patterns they want to keep.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║       ERROR HANDLING AUDIT              ║
╠══════════════════════════════════════════╣
║  Error Classes Found: X                 ║
║  Consistency Score: X/10                ║
║  Leaked Internal Errors: X              ║
╚══════════════════════════════════════════╝

CURRENT PROBLEMS
────────────────
❌ Database errors leak to API response
   File: src/routes/users.ts:30
   Response: { message: "relation \"users\" does not exist" }
   Fix: Catch in service layer, throw UserServiceError, format in error middleware

❌ Inconsistent error format across endpoints
   POST /api/users:  { error: "Invalid email" }
   POST /api/orders: { message: "Bad request", code: 400 }
   GET  /api/items:  "Not found"
   Fix: Centralize error formatting in middleware

❌ Domain errors logged as ERROR level
   File: src/services/order.ts:45
   `logger.error("Insufficient balance")` — this is expected behavior, not an error
   Fix: Log as INFO or WARN, only log infrastructure/programming errors as ERROR

PROPOSED ERROR TAXONOMY
───────────────────────
Base: AppError
  ├── DomainError (4xx, expected, don't alert)
  │   ├── ValidationError (400/422)
  │   ├── NotFoundError (404)
  │   ├── ConflictError (409)
  │   └── BusinessRuleError (422)
  ├── InfrastructureError (5xx, alert)
  │   ├── DatabaseError (503)
  │   ├── ExternalServiceError (502)
  │   └── CacheError (503)
  └── TransientError (retryable)
      ├── RateLimitError (429)
      ├── TimeoutError (504)
      └── ConcurrencyError (409)

ERROR RESPONSE FORMAT
─────────────────────
All errors:
{
  "code": "ORDER_NOT_FOUND",
  "message": "Order with ID xyz not found",
  "request_id": "abc-123",
  "details": []  // Optional: field-level validation errors
}

PROPAGATION MAP
───────────────
Repository: throw DatabaseError("Query failed", { query, params })
     ↓ caught by
Service: throw OrderNotFound("Order not found", { orderId, cause: error })
     ↓ caught by
Controller/Middleware: respond({ code: "ORDER_NOT_FOUND", message: "...", request_id })
     + log: ERROR with full cause chain if infrastructure error
     + log: INFO if domain error

IMPLEMENTATION STEPS
────────────────────
1. Define base error classes with taxonomy
2. Create error formatting middleware (single place to format all errors)
3. Migrate existing error handling to use taxonomy
4. Add request_id to all error responses
5. Fix logging levels (domain errors = INFO, infra errors = ERROR)
```

Good error handling is invisible to users and invaluable to operators. Users should see clear, actionable messages. Operators should see structured, contextual error data with enough information to diagnose without reproducing.
