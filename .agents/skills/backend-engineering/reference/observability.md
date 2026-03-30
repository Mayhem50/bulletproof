# Observability Reference

Authoritative reference for backend observability: structured logging, distributed tracing, metrics, SLOs, health checks, alerting, and dashboards. All guidance assumes cloud-native services running in Kubernetes with OpenTelemetry as the instrumentation standard.

---

## 1. Structured Logging

### Mandatory Log Format

Every log line is a JSON object with these required fields:

```json
{
  "timestamp": "2025-11-14T09:23:41.892Z",
  "level": "ERROR",
  "message": "Failed to charge payment method",
  "service": "payment-service",
  "correlation_id": "req-8f3a-4b2c-9d1e",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "environment": "production",
  "version": "2.14.3"
}
```

- `timestamp`: ISO 8601 with millisecond precision, always UTC.
- `correlation_id`: The application-level request ID. Propagate via `X-Request-Id` header.
- `trace_id` / `span_id`: From the active OpenTelemetry span context. Links logs to traces.

### Log Levels

| Level | Purpose | Examples | Operational response |
|-------|---------|----------|---------------------|
| **ERROR** | Infrastructure failures, programming bugs, unrecoverable states | DB connection lost, nil pointer, circuit breaker open | Triggers alerts. Every ERROR must be investigated. |
| **WARN** | Recoverable issues, approaching limits, unexpected but handled states | Retry succeeded on 2nd attempt, cache miss fallback, 80% memory | Monitored via dashboards. Investigated if trending. |
| **INFO** | Business events, request lifecycle, state transitions | Order created, user authenticated, deployment started | Audit trail. Retained for compliance and debugging. |
| **DEBUG** | Detailed internal state, variable values, branching decisions | SQL query text, parsed config, cache key computed | Never enabled in production at high volume. Use targeted, time-limited activation. |

### Anti-Patterns

```javascript
// WRONG: unstructured string interpolation
console.log(`User ${userId} failed to pay $${amount}`);

// WRONG: logging sensitive data
logger.info("User login", { email, password, ssn });

// WRONG: logging entire request/response bodies (PII risk + volume)
logger.debug("Request body", { body: req.body });

// WRONG: catch-and-log-and-rethrow (duplicate log entries)
try { doThing(); } catch (e) { logger.error(e); throw e; }

// WRONG: generic messages with no context
logger.error("Something went wrong");
```

### Correct Patterns

```typescript
// Structured fields — searchable, filterable, aggregatable
logger.info("Order created", {
  order_id: order.id,
  customer_id: order.customerId,
  total_cents: order.totalCents,
  item_count: order.items.length,
});

// Error with stack trace and context
logger.error("Payment charge failed", {
  error_type: err.constructor.name,
  error_message: err.message,
  stack_trace: err.stack,
  order_id: order.id,
  payment_method: "card_ending_4242",  // masked, not full card number
  attempt: retryCount,
});

// Context propagation — attach correlation_id from middleware
function requestMiddleware(req, res, next) {
  const correlationId = req.headers["x-request-id"] || crypto.randomUUID();
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  req.log = logger.child({ correlation_id: correlationId, trace_id: traceId });
  next();
}
```

### Log Sampling for High-Volume Paths

For endpoints that receive thousands of requests per second (health checks, polling endpoints), sample deterministically:

```typescript
// Sample 1% of successful health check logs
if (statusCode === 200 && fnv1aHash(traceId) % 100 === 0) {
  logger.info("Health check OK", { sampled: true });
}

// Always log errors at full volume — never sample errors
if (statusCode >= 500) {
  logger.error("Health check failed", { reason });
}
```

### Log Correlation Across Async Boundaries

When publishing to a message queue, propagate context in message headers:

```typescript
// Producer: inject trace context + correlation_id into message headers
await queue.publish("order.created", payload, {
  headers: {
    "X-Request-Id": correlationId,
    traceparent: `00-${traceId}-${spanId}-01`,
  },
});

// Consumer: extract and restore context
async function handleMessage(msg) {
  const correlationId = msg.headers["X-Request-Id"];
  const remoteContext = propagation.extract(context.active(), msg.headers);
  context.with(remoteContext, () => {
    const log = logger.child({ correlation_id: correlationId });
    log.info("Processing order.created event", { order_id: msg.body.orderId });
  });
}
```

---

## 2. Distributed Tracing (OpenTelemetry)

### Core Concepts

- **Trace**: End-to-end record of a request through a distributed system. Identified by a 128-bit `trace_id`.
- **Span**: A single unit of work within a trace. Has a name, start/end time, status, attributes, and optional parent span.
- **Span Context**: The immutable propagation payload: `trace_id`, `span_id`, `trace_flags`. Crosses process boundaries via headers.
- **Baggage**: Key-value pairs propagated across all downstream services. Use sparingly (adds to every request). Good for: tenant_id, feature_flags.

### W3C Trace Context Propagation

The `traceparent` header format:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
              ^  ^                                ^                ^
          version  trace-id (32 hex)         parent-id (16 hex)  flags (01=sampled)
```

Optional `tracestate` carries vendor-specific data. Always propagate both headers.

### Auto-Instrumentation Setup (Node.js)

```typescript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  serviceName: "payment-service",
  traceExporter: new OTLPTraceExporter({
    url: "http://otel-collector:4317",
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
      "@opentelemetry/instrumentation-redis": { enabled: true },
      "@opentelemetry/instrumentation-amqplib": { enabled: true },
    }),
  ],
});

sdk.start();
```

Auto-instrumentation captures: HTTP server/client spans, database query spans, message queue publish/consume spans, gRPC calls.

### Manual Spans

Add manual spans when auto-instrumentation does not cover business-critical operations:

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("payment-service");

async function processPayment(order) {
  return tracer.startActiveSpan("payment.process", async (span) => {
    try {
      span.setAttribute("order.id", order.id);
      span.setAttribute("order.total_cents", order.totalCents);
      span.setAttribute("payment.method", order.paymentMethod);

      const result = await chargeCard(order);

      span.setAttribute("payment.transaction_id", result.transactionId);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
```

### Span Attributes vs Events vs Links

| Concept | Purpose | Example |
|---------|---------|---------|
| **Attributes** | Static metadata describing the span | `http.method = "POST"`, `order.id = "abc-123"` |
| **Events** | Timestamped occurrences within a span's lifetime | `"cache miss"` at T+12ms, `"retry attempt"` at T+50ms |
| **Links** | References to causally related spans in other traces | Batch job span linking to each originating request span |

Use attributes for facts known at span creation. Use events for things that happen during the span. Use links for fan-in/fan-out patterns (batch processing, aggregation).

### Sampling Strategies

**Head-based sampling** (decided at trace creation):
- `AlwaysOnSampler`: 100% of traces. Only for low-traffic services or dev.
- `TraceIdRatioBased(0.1)`: 10% of traces, deterministic on trace_id (consistent across services).
- `ParentBasedSampler`: Respect the parent span's sampling decision. Use this as the root sampler.

**Tail-based sampling** (decided after trace completion):
- Implemented in the OTel Collector, not in-process.
- Keeps all error traces, slow traces (>P99), and a random sample of the rest.
- Requires buffering complete traces in the collector (memory-intensive).

```yaml
# OTel Collector tail sampling config
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-requests
        type: latency
        latency: { threshold_ms: 2000 }
      - name: random-sample
        type: probabilistic
        probabilistic: { sampling_percentage: 5 }
```

**Recommendation**: Use `ParentBasedSampler(root=TraceIdRatioBased(0.1))` in-process. Add tail-based sampling in the collector for error and latency retention.

### Trace Context Across Async Boundaries

For message queues, propagate trace context in message headers so consumer spans are children of producer spans:

```typescript
// Producer
const headers = {};
propagation.inject(context.active(), headers);
await producer.send({ topic: "orders", headers, value: payload });

// Consumer
const parentContext = propagation.extract(context.active(), message.headers);
context.with(parentContext, () => {
  tracer.startActiveSpan("process_order", (span) => {
    // This span is a child of the producer span
    processOrder(message.value);
    span.end();
  });
});
```

---

## 3. Metrics (RED and USE Methods)

### RED Method (Request-Scoped)

Apply to every service endpoint:

| Signal | Metric | Type | What it answers |
|--------|--------|------|-----------------|
| **Rate** | `http_requests_total` | Counter | How much traffic is the service handling? |
| **Errors** | `http_requests_total{status="5xx"}` | Counter | How many requests are failing? |
| **Duration** | `http_request_duration_seconds` | Histogram | How fast is the service responding? |

### USE Method (Resource-Scoped)

Apply to every infrastructure resource (CPU, memory, disk, network, connection pools):

| Signal | Example Metric | Type |
|--------|---------------|------|
| **Utilization** | `node_cpu_seconds_total`, `container_memory_usage_bytes` | Gauge |
| **Saturation** | `node_disk_io_time_weighted_seconds_total`, `db_pool_waiting_connections` | Gauge |
| **Errors** | `node_network_receive_errs_total`, `db_pool_connection_errors_total` | Counter |

### Four Golden Signals (Google SRE)

The superset view: **latency, traffic, errors, saturation**. RED covers the first three. USE covers saturation. Together they give full visibility.

### Metric Types

- **Counter**: Monotonically increasing value. Use for: requests served, errors, bytes sent. Query with `rate()` or `increase()`.
- **Gauge**: Value that goes up and down. Use for: temperature, queue depth, active connections, memory usage.
- **Histogram**: Distributes observations into configurable buckets. Use for: request duration, response size. Enables percentile calculation via `histogram_quantile()`.
- **Summary**: Client-side percentile calculation. Avoid in most cases (cannot be aggregated across instances).

### Histogram Bucket Design

For HTTP request latency:

```typescript
// Standard latency buckets (in seconds)
const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const httpDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: latencyBuckets,
});
```

For response sizes (bytes): `[100, 1000, 10000, 100000, 1000000, 10000000]`.

### Naming Conventions

Follow Prometheus conventions:
- Unit as suffix: `_seconds`, `_bytes`, `_total` (for counters)
- Snake_case, lowercase
- Prefix with subsystem: `http_`, `db_`, `cache_`, `queue_`

```
http_request_duration_seconds        # histogram
http_requests_total                  # counter
db_query_duration_seconds            # histogram
db_connections_active                # gauge
cache_hits_total                     # counter
cache_misses_total                   # counter
queue_depth                          # gauge
```

### Label Cardinality

Labels multiply the number of time series. High cardinality kills performance.

```typescript
// GOOD: low cardinality labels
{ method: "GET", route: "/api/orders", status_code: "200" }
// ~50 route * 5 method * 10 status = 2,500 series per metric

// BAD: high cardinality labels — do NOT use
{ user_id: "usr_abc123", order_id: "ord_xyz789" }
// Millions of unique combinations = OOM on your metrics backend
```

Rules:
- Never use IDs (user_id, order_id, trace_id) as metric labels.
- Normalize route labels: `/api/orders/:id` not `/api/orders/abc123`.
- Keep total label combinations under 10,000 per metric.
- Put high-cardinality data in traces and logs, not metrics.

### Business Metrics

```typescript
// Track business outcomes alongside technical metrics
const ordersCreated = new Counter({
  name: "orders_created_total",
  help: "Total orders created",
  labelNames: ["payment_method", "region"],
});

const orderValue = new Histogram({
  name: "order_value_dollars",
  help: "Order value in dollars",
  buckets: [10, 25, 50, 100, 250, 500, 1000, 5000],
});

const paymentSuccessRate = new Gauge({
  name: "payment_success_rate",
  help: "Rolling payment success rate",
});
```

### Prometheus Configuration

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: "payment-service"
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_label_app]
        regex: payment-service
        action: keep
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_port]
        target_label: __address__
        replacement: "${1}:${2}"
```

---

## 4. SLIs, SLOs, SLAs

### Definitions

- **SLI (Service Level Indicator)**: A quantitative measure of service behavior. Expressed as a ratio: `good events / total events`. Always between 0 and 1 (or 0% and 100%).
- **SLO (Service Level Objective)**: A target value for an SLI over a rolling time window. Example: "99.9% of requests complete successfully within 500ms over 30 days."
- **SLA (Service Level Agreement)**: A business contract with consequences for missing the SLO. SLAs are looser than SLOs (e.g., SLO=99.9%, SLA=99.5%).

### Common SLIs

| SLI type | Good event | Total event | Typical SLO |
|----------|-----------|-------------|-------------|
| Availability | Non-5xx responses | All responses | 99.9% |
| Latency | Responses < 500ms | All responses | 99.0% |
| Correctness | Correct responses | All responses | 99.99% |
| Freshness | Data updated within 1min | All data checks | 99.9% |

### Error Budget

```
Error budget = 1 - SLO

99.9% SLO over 30 days:
  Error budget = 0.1% = 0.001
  Budget in minutes = 30 * 24 * 60 * 0.001 = 43.2 minutes/month
  Budget in requests = 1,000,000 requests * 0.001 = 1,000 failed requests allowed

99.95% SLO over 30 days:
  Error budget = 21.6 minutes/month

99.99% SLO over 30 days:
  Error budget = 4.32 minutes/month
```

### SLO-Based Alerting: Multi-Window, Multi-Burn-Rate

Instead of alerting on raw error rates, alert on the rate at which error budget is being consumed (burn rate).

**Burn rate** = actual error rate / error rate that would exactly exhaust budget in the window.

For a 99.9% SLO over 30 days, the baseline error rate is 0.1%. A burn rate of 1 means you consume the entire monthly budget in exactly 30 days.

| Severity | Fast window burn rate | Long window burn rate | Action |
|----------|----------------------|----------------------|--------|
| **Page (P0)** | 14.4x for 1 hour | 6x for 6 hours | Wake someone up |
| **Ticket (P2)** | 3x for 1 day | 1x for 3 days | Investigate next business day |

Both conditions must be true simultaneously to fire. This prevents alert on brief spikes (fast window catches real incidents) and prevents alert on stale data (long window confirms sustained impact).

```yaml
# Prometheus alerting rules for 99.9% availability SLO
groups:
  - name: slo-burn-rate
    rules:
      # Fast burn: 14.4x over 1h AND 6x over 6h → page
      - alert: HighErrorBudgetBurn_Page
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1h]))
            / sum(rate(http_requests_total[1h]))
          ) > (14.4 * 0.001)
          and
          (
            sum(rate(http_requests_total{status=~"5.."}[6h]))
            / sum(rate(http_requests_total[6h]))
          ) > (6 * 0.001)
        labels:
          severity: page
        annotations:
          summary: "High error budget burn rate — potential SLO breach"
          runbook: "https://runbooks.internal/slo-budget-burn"

      # Slow burn: 3x over 1d AND 1x over 3d → ticket
      - alert: HighErrorBudgetBurn_Ticket
        expr: |
          (
            sum(rate(http_requests_total{status=~"5.."}[1d]))
            / sum(rate(http_requests_total[1d]))
          ) > (3 * 0.001)
          and
          (
            sum(rate(http_requests_total{status=~"5.."}[3d]))
            / sum(rate(http_requests_total[3d]))
          ) > (1 * 0.001)
        labels:
          severity: ticket
        annotations:
          summary: "Sustained error budget consumption — investigate"
          runbook: "https://runbooks.internal/slo-slow-burn"
```

### Error Budget Policy

Define organizational responses when budget is exhausted:

1. **Budget remaining > 50%**: Normal feature velocity. Deploy freely.
2. **Budget remaining 20-50%**: Increased caution. Require rollback plans for all deploys.
3. **Budget remaining < 20%**: Feature freeze. Only reliability improvements and bug fixes ship.
4. **Budget exhausted (0%)**: Full freeze. All engineering effort directed at reliability until budget recovers.

---

## 5. Health Checks

### Three Probe Types

**Liveness** — "Is the process fundamentally healthy?"
- Returns 200 if the event loop / main thread is not deadlocked.
- Never check external dependencies. If the database is down, the process is still alive; it just cannot serve requests (that is readiness, not liveness).
- A failed liveness probe causes the container to be killed and restarted.

**Readiness** — "Can this instance accept traffic?"
- Check critical dependencies only: database connection pool has available connections, required caches are warm.
- A failed readiness probe removes the pod from the Service's endpoints (stops sending traffic), but does not restart it.

**Startup** — "Has initialization completed?"
- For services with slow startup (loading ML models, warming caches, running migrations).
- Until the startup probe succeeds, liveness and readiness probes are not evaluated.
- Prevents premature liveness kills during expected slow starts.

### Implementation

```typescript
// Liveness: minimal check — is the process responsive?
app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "alive" });
});

// Readiness: can we serve traffic?
app.get("/readyz", async (req, res) => {
  try {
    await db.query("SELECT 1");          // critical dependency
    await redis.ping();                  // critical dependency
    res.status(200).json({ status: "ready" });
  } catch (err) {
    res.status(503).json({ status: "not_ready", reason: err.message });
  }
});

// Startup: has initialization completed?
let initialized = false;
app.get("/startupz", (req, res) => {
  if (initialized) {
    res.status(200).json({ status: "started" });
  } else {
    res.status(503).json({ status: "starting" });
  }
});
```

### Anti-Patterns

- **Cascading health checks**: Service A's readiness calls Service B's readiness, which calls Service C. If C is slow, A and B both go unready. Check local resources only.
- **Expensive health checks**: Running a complex DB query or calling an external API. Health probes fire every few seconds; keep them under 1 second.
- **Checking optional dependencies**: If the recommendation engine is down, the order service can still take orders. Do not fail readiness for optional dependencies.
- **Liveness checking dependencies**: If Redis is down, do not kill the process. It will not help — the restarted process will also find Redis down.

### Kubernetes Probe Configuration

```yaml
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: payment-service
      livenessProbe:
        httpGet:
          path: /healthz
          port: 8080
        initialDelaySeconds: 0       # start checking immediately (startup probe guards)
        periodSeconds: 10            # check every 10s
        failureThreshold: 3          # 3 failures = restart (30s tolerance)
        timeoutSeconds: 1            # must respond within 1s
      readinessProbe:
        httpGet:
          path: /readyz
          port: 8080
        initialDelaySeconds: 0
        periodSeconds: 5             # check more frequently — controls traffic routing
        failureThreshold: 2          # 2 failures = remove from endpoints (10s)
        timeoutSeconds: 2            # allow slightly more time for dependency checks
      startupProbe:
        httpGet:
          path: /startupz
          port: 8080
        periodSeconds: 5
        failureThreshold: 60         # 60 * 5s = 5 min max startup time
        timeoutSeconds: 2
```

---

## 6. Alerting Best Practices

### Alert on Symptoms, Not Causes

```yaml
# WRONG: alerting on a cause (CPU usage)
- alert: HighCPU
  expr: node_cpu_usage > 0.9
  # CPU can be 90% and users are fine. Or CPU can be 50% and users are suffering.

# RIGHT: alerting on a symptom (elevated error rate burning SLO budget)
- alert: HighErrorRate
  expr: |
    sum(rate(http_requests_total{status=~"5.."}[5m]))
    / sum(rate(http_requests_total[5m])) > 0.01
  annotations:
    summary: "Error rate above 1% — users are experiencing failures"
    runbook: "https://runbooks.internal/high-error-rate"
```

Cause-based alerts (high CPU, high memory, disk filling) are useful as early warnings (ticket severity), but should never page unless they directly indicate user impact.

### Every Alert Must Be Actionable

Before creating an alert, answer:
1. **What does the on-call engineer do when this fires?** If the answer is "look at it and hope it resolves," delete the alert.
2. **Is there a documented runbook?** If not, write one before enabling the alert.
3. **Can this be automated?** If the response is always the same (restart service, scale up), automate it instead of alerting.

### Alert Fatigue

Indicators that alerting is broken:
- More than 50% of pages do not require human intervention.
- On-call engineers routinely silence or ignore alerts.
- The same alert fires and auto-resolves repeatedly (flapping).
- Multiple alerts fire for the same incident (alert storms).

Remedies:
- Deduplicate: group related alerts into a single notification.
- Increase thresholds and evaluation windows to prevent flapping.
- Move non-actionable alerts to ticket or dashboard-only.
- Review alert history monthly; delete unused alerts.

### Alert Structure

Every alert must include:
- **Summary**: What is happening, in user-impact terms.
- **Severity**: P0 (page immediately), P1 (page during business hours), P2 (ticket), P3 (notification/log).
- **Runbook link**: Step-by-step diagnosis and remediation.
- **Relevant dashboard link**: Pre-filtered to the affected service and time window.
- **Affected service and environment**: No guessing required.

```yaml
- alert: PaymentServiceHighLatency
  expr: |
    histogram_quantile(0.99,
      sum(rate(http_request_duration_seconds_bucket{service="payment-service"}[5m])) by (le)
    ) > 2
  for: 5m
  labels:
    severity: page
    team: payments
  annotations:
    summary: "Payment service P99 latency > 2s for 5 minutes"
    description: "Users are experiencing slow checkouts. P99 latency: {{ $value }}s"
    runbook: "https://runbooks.internal/payment-high-latency"
    dashboard: "https://grafana.internal/d/payment-svc?from=now-1h"
```

### On-Call Best Practices

- Maximum 1 page per 12-hour shift on average (sustained higher rate leads to burnout).
- Blameless postmortems for every P0/P1 incident.
- Follow-the-sun rotation for global teams.
- Escalation path: primary on-call (5 min) -> secondary (15 min) -> engineering manager (30 min).
- On-call handoff includes a summary of active incidents, recent deploys, and known issues.

---

## 7. Dashboards

### The Four Golden Signals Dashboard (Per Service)

Every service gets a dashboard with four rows:

**Row 1: Latency**
```
Panel: P50, P90, P99 latency over time (line chart)
Query: histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{service="$service"}[5m])) by (le))
Panel: Latency heatmap
Query: sum(increase(http_request_duration_seconds_bucket{service="$service"}[5m])) by (le)
```

**Row 2: Traffic**
```
Panel: Requests per second by status code (stacked area)
Query: sum(rate(http_requests_total{service="$service"}[5m])) by (status_code)
Panel: Top endpoints by traffic
Query: topk(10, sum(rate(http_requests_total{service="$service"}[5m])) by (route))
```

**Row 3: Errors**
```
Panel: Error rate % (line chart with 1% threshold line)
Query: sum(rate(http_requests_total{service="$service",status=~"5.."}[5m])) / sum(rate(http_requests_total{service="$service"}[5m])) * 100
Panel: Errors by type (table)
Query: sum(increase(http_requests_total{service="$service",status=~"5.."}[1h])) by (status_code, route)
```

**Row 4: Saturation**
```
Panel: CPU and memory utilization
Query: container_memory_usage_bytes{pod=~"$service.*"} / container_spec_memory_limit_bytes{pod=~"$service.*"}
Panel: Connection pool utilization, queue depth
Query: db_connections_active{service="$service"} / db_connections_max{service="$service"}
```

### SLO Dashboard

```
Panel 1: Current SLI (big number, green/yellow/red)
  - Shows current 30-day rolling availability: 99.94%
  - Green (>SLO), Yellow (within 20% of budget), Red (budget exhausted)

Panel 2: Error budget remaining (gauge or burn-down chart)
  - "12.6 minutes remaining of 43.2 minute budget"
  - Projected exhaustion date

Panel 3: Burn rate over time (line chart)
  - 1h, 6h, 1d burn rate windows
  - Threshold lines at 1x, 3x, 6x, 14.4x

Panel 4: SLO compliance history (table)
  - Last 12 months: which months met the SLO, which did not
```

### Dependency Health Dashboard

For each upstream dependency (database, cache, external APIs):

```
Panel: Availability (success rate of calls to this dependency)
Panel: Latency (P50, P99 of calls to this dependency)
Panel: Connection pool status (active, idle, waiting)
Panel: Circuit breaker state (closed/open/half-open)
```

### Business Metrics Dashboard

```
Panel: Orders per minute (line chart, compare to same time last week)
Panel: Revenue per hour (line chart)
Panel: Payment success rate (gauge: target 98%+)
Panel: Cart abandonment rate
Panel: User signups per hour
```

### Dashboard Principles

- **Every panel answers a specific question.** If you cannot articulate the question, remove the panel.
- **Avoid vanity metrics.** Total requests served since launch is not actionable. Rate of requests right now is.
- **Time-shift comparisons.** Show the same metric from 1 day and 1 week ago as faded lines. Anomalies become visually obvious.
- **Consistent time ranges.** All panels on a dashboard use the same time window (dashboard-level variable).
- **Link dashboards to alerts.** Every alert annotation includes a pre-filtered dashboard URL. Every dashboard panel links to the underlying alert rule.
- **Use template variables.** Service name, environment, and region as dashboard variables. One dashboard template serves all instances.

---

## Quick Reference: OTel Collector Pipeline

A production collector config exporting to multiple backends:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    send_batch_size: 8192
    timeout: 5s
  memory_limiter:
    check_interval: 1s
    limit_mib: 1024
    spike_limit_mib: 256
  resource:
    attributes:
      - key: environment
        value: production
        action: upsert

exporters:
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889
  loki:
    endpoint: http://loki:3100/loki/api/v1/push

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [otlp/tempo]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch, resource]
      exporters: [loki]
```
