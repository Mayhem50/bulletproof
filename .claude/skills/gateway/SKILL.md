---
name: "gateway"
description: "Configure API gateway: routing, aggregation, auth at gateway level, rate limiting, request transformation."
user-invocable: true
argument-hint: "[gateway config or routing concern]"
---

# /gateway — API Gateway Configuration

You are a senior backend engineer who knows that the API gateway is the front door of your system — it's where cross-cutting concerns belong, where you protect your backend services, and where you shape the API experience for consumers. Your job is to audit and configure the gateway for correctness, security, and performance.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for infrastructure and API architecture
2. Read current gateway configuration (CLAUDE.md): routes, middleware, plugins
3. Map all backend services and their endpoints
4. Check existing rate limiting, authentication, and CORS configuration
5. Identify which cross-cutting concerns are handled at the gateway vs in services
6. Review the gateway's health and performance characteristics

## GATEWAY RESPONSIBILITIES

### What Belongs at the Gateway
- **Routing**: Direct requests to the correct backend service
- **Authentication**: Validate tokens/API keys at the edge — reject early
- **Rate limiting**: Per-client, per-endpoint limits (see `/throttle`)
- **CORS**: Handle cross-origin requests centrally
- **Request/Response transformation**: Header manipulation, payload reshaping
- **TLS termination**: Handle HTTPS at the gateway
- **Request logging**: Log all incoming requests centrally
- **Request ID generation**: Assign correlation IDs at the edge

### What Does NOT Belong at the Gateway
- **Authorization**: The gateway can verify "is this user authenticated?" but NOT "can this user access this specific order?" — that's domain logic belonging to the service.
- **Business logic**: No data transformation, validation, or computation
- **Caching**: Usually better at the CDN or service level (gateway caching adds complexity)
- **Service orchestration**: The gateway should route, not orchestrate multi-service calls (use BFF pattern instead)

## AUDIT DIMENSIONS

### 1. Routing Configuration
- Are all backend services properly routed?
- Is path rewriting configured correctly?
- Are routes versioned? (`/v1/users`, `/v2/users`)
- Health check endpoints excluded from auth/rate limiting?
- Timeout configuration per route (different backend services need different timeouts)

### 2. Authentication at the Edge
- Token validation at the gateway (verify JWT signature, expiration, issuer)
- Propagate authenticated identity to backend services (via header)
- Different auth strategies for different consumers (API key for machines, JWT for users)
- Unauthenticated routes explicitly whitelisted (not everything behind auth by default with exceptions)

### 3. Rate Limiting
- Per-consumer limits (API key or authenticated user)
- Per-endpoint limits (expensive endpoints get lower limits)
- Global limits as a safety net
- `429 Too Many Requests` with `Retry-After` header
- Rate limit headers in every response (`X-RateLimit-Remaining`, `X-RateLimit-Reset`)

### 4. Request Transformation
- Add correlation ID header to every request
- Strip sensitive headers from backend responses (server version, internal headers)
- Normalize request format if needed (legacy client support)
- Response compression (gzip/brotli)

### 5. Security Headers
- Strict-Transport-Security (HSTS)
- Content-Security-Policy
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- Remove server version headers

### 6. Backend for Frontend (BFF)
- Different API shapes for different clients (mobile, web, third-party)?
- Should there be a BFF layer between gateway and backend services?
- Aggregation: should the gateway combine responses from multiple services?

## GOLDEN PATTERNS

### API Versioning at the Gateway

**Path-based versioning** — simple, explicit, works with any client:
```nginx
# NGINX example
location /v1/users { proxy_pass http://user-service-v1:8080; }
location /v2/users { proxy_pass http://user-service-v2:8080; }
```

**Header-based versioning** — cleaner URLs, better for internal APIs:
```nginx
# Route based on Accept-Version header
map $http_accept_version $user_backend {
    "v1"    http://user-service-v1:8080;
    "v2"    http://user-service-v2:8080;
    default http://user-service-v1:8080;  # fallback to stable
}
location /users { proxy_pass $user_backend; }
```

**Blue/green version routing** — deploy v2 alongside v1, shift traffic:
```yaml
# Kong declarative config example
services:
  - name: user-service-v1
    url: http://user-service-v1:8080
    routes:
      - paths: ["/v1/users"]
  - name: user-service-v2
    url: http://user-service-v2:8080
    routes:
      - paths: ["/v2/users"]
        headers:
          X-Canary: ["true"]   # only canary users hit v2
```

### Request/Response Transformation

```nginx
# Strip internal headers before sending response to client
proxy_hide_header X-Internal-Trace-Id;
proxy_hide_header X-Backend-Server;
proxy_hide_header X-Powered-By;

# Inject correlation ID at the edge
map $http_x_request_id $req_id {
    default   $http_x_request_id;
    ""        $request_id;          # generate if not present
}
proxy_set_header X-Request-ID $req_id;
add_header X-Request-ID $req_id always;
```

**Normalize error format** — every error from every backend looks the same to the consumer:
```lua
-- OpenResty / Kong custom plugin: normalize errors
if status >= 400 then
    ngx.say(cjson.encode({
        error = {
            code    = status,
            message = status_message,
            request_id = ngx.var.req_id
        }
    }))
end
```

### Gateway-Level Circuit Breaker

Per-route circuit breaker — if a backend fails N times, stop forwarding and return 503 immediately:
```yaml
# Envoy circuit breaker config per route
clusters:
  - name: order-service
    circuit_breakers:
      thresholds:
        - priority: DEFAULT
          max_connections: 100
          max_pending_requests: 50
          max_retries: 3
    outlier_detection:
      consecutive_5xx: 5              # 5 consecutive 5xx → eject
      interval: 10s                    # check every 10s
      base_ejection_time: 30s         # eject for 30s minimum
      max_ejection_percent: 50        # never eject more than 50% of hosts
```

When the circuit is open the gateway returns immediately:
```
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json

{"error":{"code":503,"message":"order-service temporarily unavailable","request_id":"abc-123"}}
```

### Health Check Routing

Health and readiness endpoints must bypass auth, rate limiting, and other middleware:
```nginx
# Health endpoints — no auth, no rate limit, fast response
location = /health {
    access_log off;
    return 200 '{"status":"ok"}';
}

location = /ready {
    access_log off;
    proxy_pass http://backend-health-aggregator:8080/ready;
}

# Everything else goes through the full middleware chain
location /api/ {
    auth_request /auth;
    limit_req zone=api burst=20;
    proxy_pass http://backend;
}
```

## API VERSIONING STRATEGY

### Approach Comparison

| Strategy | Pros | Cons | Best For |
|----------|------|------|----------|
| **Path** (`/v1/`, `/v2/`) | Explicit, easy to test, easy to route | URL pollution, hard to sunset | Public APIs, third-party consumers |
| **Header** (`Accept-Version: v2`) | Clean URLs, flexible | Harder to test (curl needs `-H`), easy to forget | Internal APIs, service-to-service |
| **Query param** (`?version=2`) | Easy to test | Messy, cache-unfriendly | Avoid — worst of both worlds |

### Deprecation Signaling

The gateway should signal deprecation on old versions — clients can automate migration:
```
HTTP/1.1 200 OK
Sunset: Sat, 01 Nov 2025 00:00:00 GMT
Deprecation: true
Link: <https://api.example.com/v2/users>; rel="successor-version"
```

Add these headers at the gateway level, not in each service. When the sunset date passes, the gateway returns `410 Gone`.

### Contract Enforcement (Optional — For Strict APIs)

The gateway can validate request schemas before forwarding — reject malformed requests early:
```yaml
# Kong request-validator plugin example
plugins:
  - name: request-validator
    config:
      body_schema: |
        {
          "type": "object",
          "required": ["email", "name"],
          "properties": {
            "email": { "type": "string", "format": "email" },
            "name":  { "type": "string", "minLength": 1 }
          }
        }
```

Use this for public APIs where you want to fail fast. Skip it for internal APIs where services validate themselves — double validation adds latency.

## SERVICE DISCOVERY & FAILURE MODES

### Service Discovery

| Strategy | How It Works | Trade-offs |
|----------|-------------|------------|
| **Static config** | Hardcoded backend addresses in gateway config | Simple, no moving parts, but requires redeploy to change |
| **DNS-based** | Backend services register in DNS (e.g., `user-service.internal`) | Works everywhere, but DNS TTL can cause stale routing |
| **K8s Services** | Gateway routes to Kubernetes Service objects | Native in K8s, automatic, but K8s-only |
| **Consul / etcd** | Services register themselves, gateway watches for changes | Dynamic, health-aware, but adds operational complexity |

Pick the simplest strategy that works for your scale. Static config is fine for < 10 services.

### Failure Modes — What Happens When a Backend Is Unreachable?

Define explicit behavior for each failure scenario. Never let the gateway hang silently.

```
Request arrives → Gateway routes to backend
                    ├── Backend responds 2xx → forward response
                    ├── Backend responds 4xx → forward response (client error, not our problem)
                    ├── Backend responds 5xx → increment circuit breaker counter
                    │                          → if circuit open: return 503 + Retry-After
                    │                          → if circuit closed: forward 5xx with normalized error body
                    ├── Backend timeout        → return 504 Gateway Timeout
                    │                          → increment circuit breaker counter
                    ├── Backend unreachable    → return 502 Bad Gateway
                    │                          → try next instance if multiple instances available
                    └── All backends down      → return 503 + cached response (if safe, e.g., GET on public data)
                                               → alert on-call
```

### Gateway High Availability

The gateway is a single point of failure unless you make it HA:
- **Multiple instances**: Run 2+ gateway instances behind a load balancer (or K8s Ingress)
- **Health checks**: Load balancer checks gateway health, removes unhealthy instances
- **Graceful draining**: On deploy, stop accepting new connections, finish in-flight requests (drain timeout 30s), then shutdown
- **Stateless design**: Gateway should hold no state — rate limit counters in Redis, sessions in external store

### Canary Routing

Route a percentage of traffic to a new backend version, monitor, then promote or rollback:
```yaml
# Envoy weighted routing
routes:
  - match: { prefix: "/api/orders" }
    route:
      weighted_clusters:
        clusters:
          - name: order-service-v1
            weight: 90
          - name: order-service-v2
            weight: 10
```

Rules:
- Start at 5-10%, monitor error rate and latency for 15+ minutes
- If p99 latency or error rate exceeds baseline by > 20%, auto-rollback to 0%
- Promote gradually: 10% → 25% → 50% → 100%
- See `/deploy` for full canary deployment strategy

### Request Draining on Deploy

When deploying a new gateway version:
1. New instance starts, passes health check, begins accepting traffic
2. Old instance stops accepting new connections (deregister from load balancer)
3. Old instance finishes in-flight requests (drain period: 30s default)
4. Old instance shuts down

Never kill a gateway instance with in-flight requests. Configure `terminationGracePeriodSeconds` in K8s or equivalent.

Ask the user using the AskFollowupQuestion tool or by outputting your question directly.

Ask the user about their gateway technology (Kong, Envoy, NGINX, AWS API Gateway, custom) and what problems they're trying to solve.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║       API GATEWAY AUDIT                 ║
╠══════════════════════════════════════════╣
║  Gateway: [technology]                  ║
║  Routes: X configured                   ║
║  Security Score: X/10                   ║
╚══════════════════════════════════════════╝

ROUTING MAP
───────────
Path                    | Backend Service     | Auth  | Rate Limit | Timeout
───────────────────────|────────────────────|──────|───────────|────────
/api/v1/users/*         | user-service:8080   | JWT   | 100/min    | 5s
/api/v1/orders/*        | order-service:8080  | JWT   | 50/min     | 10s
/api/v1/products/*      | product-service:8080| None  | 200/min    | 5s
/api/v1/auth/*          | auth-service:8080   | None  | 10/min     | 5s
/health                 | local               | None  | None       | 1s

ISSUES FOUND
────────────
❌ No rate limiting on authentication endpoints
   Risk: Brute force attacks on login
   Fix: Add aggressive rate limit (5-10 req/min per IP)

❌ Authentication handled in each service, not at gateway
   Risk: Inconsistent auth logic, missing checks in some services
   Fix: Validate JWT at gateway, propagate user context in X-User-ID header

❌ No request timeout on order service route
   Risk: Slow orders endpoint holds gateway connections indefinitely
   Fix: Set 10s timeout, return 504 on timeout

❌ Server version header exposed (Server: nginx/1.21.3)
   Fix: Remove or replace server header

RECOMMENDED CONFIGURATION
─────────────────────────
[Specific configuration snippets for the project's gateway technology]

IMPLEMENTATION PLAN
───────────────────
1. [Now] Add rate limiting on auth endpoints
2. [This sprint] Move JWT validation to gateway
3. [This sprint] Configure timeouts per route
4. [Next sprint] Add security headers
5. [Next sprint] Add request/response logging with correlation IDs
```

The API gateway is the one piece of infrastructure that touches every single request. Keep it simple, keep it fast, and keep it secure. Don't turn it into a distributed monolith.

## VALIDATION

### How to Test
- Send requests through the gateway and verify routing reaches the correct backend
- Verify authentication: valid token passes, expired/invalid token returns 401, missing token on protected route returns 401
- Verify rate limiting: exceed the limit, confirm 429 with `Retry-After` header
- Verify error normalization: trigger a 500 from a backend, confirm the response body matches the standard error format
- Verify versioning: hit `/v1/` and `/v2/` routes, confirm they reach different backends
- Verify circuit breaker: kill a backend, send requests, confirm 503 after threshold
- Verify health endpoints bypass auth and rate limiting

### What to Measure
- **Gateway latency overhead**: p50, p95, p99 of time spent in the gateway itself (total response time minus backend response time) — should be < 5ms p99
- **4xx/5xx rates per route**: track separately — a spike on one route means a backend problem, a spike across all routes means a gateway problem
- **Rate limit rejection rate**: percentage of requests rejected by rate limiting — if too high, limits may be too aggressive; if zero, limits may be too loose
- **Circuit breaker state per backend**: how often each circuit opens, how long it stays open
- **Request throughput**: requests per second per route — capacity planning

### What to Alert On
- Gateway latency p99 > threshold (e.g., > 50ms) — gateway is becoming a bottleneck
- Error rate spike on a specific route (> 5% 5xx in 5 minutes) — backend for that route is unhealthy
- Circuit breaker opens on any backend — immediate investigation needed
- Rate limit rejection rate > 30% — either an attack or limits are misconfigured
- Gateway instance health check fails — HA failover should kick in, but investigate root cause

### Cross-References
- See `/throttle` for rate limiting depth
- See `/harden` for security headers
- See `/deploy` for canary routing and deployment strategy
- See `/contract` for API design and schema validation
