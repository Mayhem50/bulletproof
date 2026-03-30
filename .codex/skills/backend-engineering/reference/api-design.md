# API Design Reference

Authoritative reference for backend API design: REST, GraphQL, gRPC, pagination, errors, versioning, rate limiting, security.

---

## 1. REST API Conventions

### Resource Naming

- **Plural nouns**: `/users`, `/orders`, `/line-items`
- **kebab-case** for multi-word: `/order-items`, not `/orderItems` or `/order_items`
- **No verbs in URLs**. The HTTP method is the verb.
- Nest sub-resources for ownership: `/users/{id}/addresses` (max 2 levels deep)

```
Good:  GET  /users/42/orders
Bad:   GET  /getOrdersForUser?userId=42
Bad:   GET  /user/42/order              (singular)
```

### HTTP Methods

| Method  | Semantics        | Idempotent | Safe | Typical Response  |
|---------|------------------|------------|------|-------------------|
| GET     | Read             | Yes        | Yes  | 200 with body     |
| POST    | Create           | No         | No   | 201 + Location    |
| PUT     | Full replace     | Yes        | No   | 200 or 204        |
| PATCH   | Partial update   | No*        | No   | 200 with body     |
| DELETE  | Remove           | Yes        | No   | 204               |

*PATCH is idempotent with JSON Merge Patch; not with JSON Patch (RFC 6902).

### Sub-Resources for Actions

Model non-CRUD operations as sub-resources:

```
POST /orders/{id}/cancel          -- not POST /cancelOrder
POST /users/{id}/verify-email     -- not POST /verifyUserEmail
POST /payments/{id}/refunds       -- creates a refund sub-resource
```

### Status Codes

**2xx**: 200 OK | 201 Created (+ `Location` header) | 202 Accepted (async) | 204 No Content

```
HTTP/1.1 201 Created
Location: /users/42
Content-Type: application/json

{ "id": 42, "email": "ada@example.com" }
```

**3xx**: 301 Moved Permanently | 308 Permanent Redirect (preserves method -- prefer over 301)

**4xx**: 400 Bad Request | 401 Unauthorized (+ `WWW-Authenticate`) | 403 Forbidden | 404 Not Found | 409 Conflict | 422 Unprocessable Entity | 429 Too Many Requests (+ `Retry-After`)

**5xx**: 500 Internal (never leak stack traces) | 502 Bad Gateway | 503 Service Unavailable (+ `Retry-After`) | 504 Gateway Timeout

### Content Negotiation

- Default to `application/json` when no `Accept` header is sent.
- Return `406 Not Acceptable` for unsupported media types.
- Always set `Content-Type` on responses with a body.

### HATEOAS

Useful for **public/partner APIs**; overkill for internal services:

```json
{
  "id": 42, "status": "pending",
  "_links": {
    "self": { "href": "/orders/42" },
    "cancel": { "href": "/orders/42/cancel", "method": "POST" }
  }
}
```

---

## 2. Pagination

### Offset-Based

```
GET /articles?offset=40&limit=20
→ { "data": [...], "meta": { "offset": 40, "limit": 20, "total_count": 243 } }
```

Simple, supports "jump to page N". **Downsides**: breaks under concurrent writes (rows shift), O(n) at large offsets.

### Cursor-Based (Keyset) -- Recommended

```
GET /articles?limit=20&cursor=eyJpZCI6MTAwfQ==
→ { "data": [...], "meta": { "cursor": "eyJpZCI6MTIwfQ==", "has_more": true } }
```

Cursor encodes last-seen sort key(s). DB uses `WHERE (created_at, id) > (?, ?)` -- index-backed, O(1) per page. Stable under concurrent writes.

### Design Rules

- **Default page size**: 20-50. **Max**: 100. Never unbounded.
- **Deterministic sort**: always include a unique tiebreaker (`id`) as final sort key.
- **total_count**: expensive (`COUNT(*)` = full scan). Make optional or omit for cursor pagination.

---

## 3. Filtering & Sorting

### Query Parameters

Equality: `?status=active&role=admin`
Ranges with bracket notation: `?price[gte]=100&price[lte]=500`
Common operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `starts_with`
Multiple values: `?status[in]=pending,processing`

### Sort Syntax

```
GET /users?sort=-created_at,name      # - prefix = descending
```

### Security

- **Allowlist** filter/sort fields. Reject unknown fields with 400.
- **Parameterized queries only**. Never interpolate filter values into SQL.
- Limit to **indexed columns**. Unindexed filters/sorts = DoS vector.

---

## 4. Error Response Design (RFC 7807)

### Standard Format

```json
{
  "type": "https://api.example.com/errors/insufficient-funds",
  "title": "Insufficient Funds",
  "status": 422,
  "detail": "Account balance is $10.00 but transfer requires $50.00.",
  "instance": "/transfers/abc-123"
}
```

| Field    | Purpose                                              | Required |
|----------|------------------------------------------------------|----------|
| type     | URI identifying error type (dereferenceable for docs)| Yes      |
| title    | Short summary, stable across occurrences             | Yes      |
| status   | HTTP status code                                     | Yes      |
| detail   | Human-readable explanation of this occurrence        | No       |
| instance | URI for this occurrence (log correlation)            | No       |

### Validation Errors

```json
{
  "type": "https://api.example.com/errors/validation",
  "title": "Validation Error",
  "status": 422,
  "code": "VALIDATION_FAILED",
  "errors": [
    { "field": "email", "code": "INVALID_FORMAT", "message": "Must be a valid email" },
    { "field": "age", "code": "OUT_OF_RANGE", "message": "Must be between 18 and 120" }
  ]
}
```

### Error Examples

**401**: `{ "type": "…/unauthorized", "title": "Unauthorized", "status": 401, "detail": "Bearer token expired." }`
**403**: `{ "type": "…/forbidden", "title": "Forbidden", "status": 403, "detail": "Role 'viewer' cannot delete." }`
**409**: `{ "type": "…/conflict", "title": "Conflict", "status": 409, "code": "DUPLICATE_EMAIL" }`
**429**: `{ "type": "…/rate-limit", "title": "Too Many Requests", "status": 429 }` + `Retry-After: 32`

### i18n Strategy

- `code` values (`VALIDATION_FAILED`) are for machines -- stable, never change.
- `detail`/`message` are for humans. Clients use `code` to look up localized strings.
- Never string-match error messages for control flow.

---

## 5. Versioning Strategies

### URL Versioning (Recommended)

```
GET /v1/users/42
GET /v2/users/42
```

Explicit, visible in logs, easy to route at gateway. Slight downside: URL proliferation.

### Header Versioning

```
Accept: application/vnd.myapi.v2+json
```

Clean URLs but harder to test/debug. More complex routing.

### Breaking vs Non-Breaking Changes

**Non-breaking**: adding optional response field, optional query param, new endpoint, new enum value.
**Breaking**: removing/renaming field, changing type, making optional field required, changing URL structure.

**The additive change rule**: you can always add, never remove or rename.

### Deprecation & Sunset

```
Deprecation: Sat, 01 Feb 2025 00:00:00 GMT
Sunset: Sat, 01 Aug 2025 00:00:00 GMT
Link: <https://api.example.com/v2/users>; rel="successor-version"
```

Timeline: **Announce** (add headers, notify) → **Dual support** (monitor old traffic) → **Sunset** (return 410 Gone). Minimum 6 months public, 2-4 weeks internal.

---

## 6. GraphQL Conventions

### Schema Design

```graphql
type Query {
  user(id: ID!): User
  users(filter: UserFilter, first: Int, after: String): UserConnection!
}
type Mutation {
  createUser(input: CreateUserInput!): CreateUserPayload!
}
```

### Naming: camelCase fields, PascalCase types, SCREAMING_SNAKE enums. Input types: `<Action><Resource>Input`. Payloads: `<Action><Resource>Payload`.

### Input Types

Always wrap mutation args in a single `input` argument for forward compatibility:

```graphql
input CreateUserInput { email: String!, displayName: String!, role: UserRole = VIEWER }
type CreateUserPayload { user: User, errors: [UserError!]! }
type UserError { field: [String!], message: String!, code: ErrorCode! }
```

### Connections (Relay Pagination)

```graphql
type UserConnection { edges: [UserEdge!]!, pageInfo: PageInfo!, totalCount: Int }
type UserEdge { node: User!, cursor: String! }
type PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean!, startCursor: String, endCursor: String }
```

### Error Handling

GraphQL always returns 200. Errors in response body. Partial results are valid (`data` + `errors` coexist). For mutation validation, return errors in the payload, not the top-level errors array:

```json
{ "data": { "createUser": { "user": null, "errors": [{ "field": ["email"], "code": "DUPLICATE" }] } } }
```

### N+1 Prevention

Use **DataLoader** (or equivalent) for every field resolving a related entity. Batches and deduplicates within a single tick.

### Depth/Complexity Limiting

- **Max depth**: 5-10 levels.
- **Complexity scoring**: assign cost per field, reject queries exceeding threshold (e.g., 1000 points).
- **Rate limit by complexity**: expensive queries consume more quota.

---

## 7. gRPC Conventions

### Naming & Organization

```protobuf
syntax = "proto3";
package myapp.users.v1;

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
}
```

Services/methods: PascalCase. Fields: snake_case. Types: `<Method>Request`/`<Method>Response`.
Organize: `proto/myapp/users/v1/user_service.proto` with shared types in `proto/myapp/common/v1/`.

### Streaming

| Pattern         | Use Case                                   |
|-----------------|--------------------------------------------|
| Unary           | Standard request-response (default)        |
| Server stream   | Large results, real-time feeds             |
| Client stream   | File uploads, telemetry ingestion          |
| Bidi stream     | Chat, collaborative editing                |

### Error Model

gRPC → HTTP mapping: OK→200, INVALID_ARGUMENT→400, UNAUTHENTICATED→401, PERMISSION_DENIED→403, NOT_FOUND→404, ALREADY_EXISTS→409, RESOURCE_EXHAUSTED→429, INTERNAL→500, UNAVAILABLE→503, DEADLINE_EXCEEDED→504.

### Deadline Propagation

Always set deadlines (missing = can hang forever). Propagate remaining budget across service boundaries, minus network overhead.

### Health Checking

Implement `grpc.health.v1.Health` with `Check` and `Watch` RPCs. Return `SERVING`, `NOT_SERVING`, or `UNKNOWN`. Used by K8s for liveness/readiness probes.

---

## 8. Rate Limiting Headers

### Standard Headers

```
X-RateLimit-Limit: 1000          # max requests in window
X-RateLimit-Remaining: 742       # remaining in window
X-RateLimit-Reset: 1704067200    # unix epoch when window resets
Retry-After: 32                  # seconds to wait (on 429)
```

### 429 Response

```
HTTP/1.1 429 Too Many Requests
Retry-After: 32
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0

{ "type": "…/rate-limit", "title": "Too Many Requests", "status": 429 }
```

### Tiered Limits

Anonymous: 60/hr (by IP) | Free: 1K/hr | Pro: 10K/hr | Internal: 100K/hr (by service identity).

### Algorithms

- **Token bucket**: smooth, allows bursts. Best default.
- **Sliding window**: precise, no bursts. For strict fairness.
- **Fixed window**: simple but 2x burst at boundaries. Avoid for public APIs.

---

## 9. API Security Surface

### No Sensitive Data in URLs

URLs are logged by proxies, CDNs, browsers. Secrets go in headers or request body only.

```
Bad:   GET /users?api_key=sk_live_abc123
Good:  Authorization: Bearer eyJhbGc...
```

### Input Validation at the Boundary

Validate every field before business logic: type checking, length limits, format (email/UUID/ISO 8601), range, enum membership. Reject unknown fields in strict mode.

### Output Encoding

- Set `Content-Type: application/json` (prevents HTML interpretation).
- Add `X-Content-Type-Options: nosniff`.
- Never reflect user input without encoding.

### CORS

```
Access-Control-Allow-Origin: https://app.example.com   # strict allowlist
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

**Never** `Access-Control-Allow-Origin: *` with credentials. Maintain a strict origin allowlist. Expose rate limit headers via `Access-Control-Expose-Headers`.

### Request Size Limits

- Default `max_body_size` at gateway: 1MB. File uploads: explicit higher limit (e.g., 50MB).
- Reject oversized `Content-Length` before reading body.
- Guard against decompression bombs on gzip requests.

### Security Headers

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store
```
