# Backend Testing Reference

Authoritative reference for backend testing strategy, patterns, and tooling.
This document is meant to be consulted by an AI coding agent when making
testing decisions. Every recommendation here assumes a production-grade
backend codebase.

---

## 1. Test Pyramid

### Distribution Target

| Layer       | Share | Speed     | Confidence scope         |
|-------------|-------|-----------|--------------------------|
| Unit        | ~70%  | < 5 ms   | Single function / class  |
| Integration | ~20%  | < 2 s    | Component + real deps    |
| E2E         | ~10%  | seconds+  | Full system, user flows  |

### Unit Tests (70%)

- Pure logic only: no I/O, no network, no filesystem.
- Deterministic: same input always yields same output.
- Fast feedback: the entire unit suite should run in under 30 seconds.
- Isolate with dependency injection; never reach into global state.

### Integration Tests (20%)

- Use real infrastructure: Postgres (not SQLite), Redis, RabbitMQ, Kafka.
- Testcontainers is the standard approach (Docker-backed, disposable).
- Test the full request lifecycle where possible: HTTP request in, DB side-effects verified, response asserted.

### E2E Tests (10%)

- Cover critical business paths only: signup, checkout, payment, core workflow.
- Run in a staging-like environment with real services.
- Keep the count low. Every E2E test you add increases maintenance cost.

### Inverted Pyramid Warning

When most tests are E2E:
- CI takes 30+ minutes (developers stop running it).
- Tests break on unrelated UI/infra changes (brittle).
- Debugging failures requires tracing through the entire stack.
- Cost of infrastructure to run them is high.

**Fix:** push coverage down. If an E2E test is catching a bug, ask: "Could a unit or integration test catch this faster?"

### Adaptation by Architecture

**Monolith:** Standard pyramid. Heavy unit + integration. E2E for smoke.

**Microservices:** Insert a contract testing layer between integration and E2E. Without contracts, integration bugs hide until deployment.

```
  E2E (few)
  Contract (per service boundary)
  Integration (per service)
  Unit (per service, heavy)
```

**CRUD-heavy apps:** The database IS the logic. Shift weight toward integration tests. Unit tests on a CRUD controller that just delegates to an ORM add little value.

```
  E2E (few)
  Integration (heavy — test real DB queries)
  Unit (validation logic, transformations only)
```

---

## 2. Unit Testing Best Practices

### Test Behavior, Not Implementation

```python
# BAD: tests implementation detail (internal method call count)
def test_process_order():
    service = OrderService(mock_repo)
    service.process(order)
    mock_repo.save.assert_called_once()  # Breaks if we refactor internals

# GOOD: tests observable behavior
def test_process_order_creates_confirmed_order():
    service = OrderService(mock_repo)
    result = service.process(order)
    assert result.status == "confirmed"
    assert result.total == Decimal("99.99")
```

### AAA Pattern: Arrange, Act, Assert

Every test follows three phases. Separate them visually.

```java
@Test
void should_apply_discount_when_order_exceeds_threshold() {
    // Arrange
    var order = OrderBuilder.anOrder()
        .withItems(item("Widget", 150.00))
        .build();
    var pricing = new PricingService(new TenPercentDiscount());

    // Act
    var result = pricing.calculate(order);

    // Assert
    assertThat(result.total()).isEqualTo(new BigDecimal("135.00"));
}
```

### One Assertion Per Test (Conceptual)

Multiple `assert` calls are fine if they verify a single logical outcome.

```python
# Fine: both assertions verify "the user was created correctly"
def test_should_create_user_when_valid_input():
    user = user_service.create(name="Alice", email="alice@example.com")
    assert user.name == "Alice"
    assert user.email == "alice@example.com"
```

Split into separate tests when verifying independent behaviors.

### Test Naming Convention

Pattern: `should_[expected_outcome]_when_[condition]`

```
should_return_empty_list_when_no_orders_exist
should_throw_validation_error_when_email_is_missing
should_apply_bulk_discount_when_quantity_exceeds_100
should_retry_three_times_when_payment_gateway_times_out
```

### Never Test Private Methods Directly

Private methods are implementation details. Test them through the public API that calls them.

If a private method is complex enough that you feel it needs direct testing, that is a signal to extract it into its own class with a public interface.

### Edge Cases Checklist

Always test these:
- `null` / `None` / `undefined` inputs
- Empty strings, empty collections
- Boundary values (0, 1, -1, MAX_INT, MIN_INT)
- Unicode, special characters, very long strings
- Concurrent access (where applicable)
- Time zones and DST transitions (for date logic)

```typescript
describe("parseAge", () => {
  it("should_return_zero_when_input_is_zero", () => {
    expect(parseAge(0)).toBe(0);
  });
  it("should_throw_when_input_is_negative", () => {
    expect(() => parseAge(-1)).toThrow(ValidationError);
  });
  it("should_throw_when_input_exceeds_max", () => {
    expect(() => parseAge(200)).toThrow(ValidationError);
  });
  it("should_throw_when_input_is_null", () => {
    expect(() => parseAge(null)).toThrow(ValidationError);
  });
});
```

### Don't Mock What You Don't Own

Mocking third-party libraries (HTTP clients, ORMs, AWS SDKs) couples tests to that library's API. When the library updates, tests break without a real bug.

**Instead:** wrap external dependencies in your own interface. Mock that.

```python
# Your own interface
class PaymentGateway(Protocol):
    def charge(self, amount: Decimal, token: str) -> ChargeResult: ...

# Production implementation wraps Stripe
class StripeGateway:
    def charge(self, amount: Decimal, token: str) -> ChargeResult:
        return stripe.Charge.create(amount=int(amount * 100), source=token)

# In tests: mock YOUR interface
class FakeGateway:
    def charge(self, amount: Decimal, token: str) -> ChargeResult:
        return ChargeResult(success=True, transaction_id="fake-txn-123")
```

---

## 3. Integration Testing

### Use Real Databases

```java
// Testcontainers — spins up a real Postgres in Docker
@Container
static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16")
    .withDatabaseName("testdb")
    .withUsername("test")
    .withPassword("test");

@DynamicPropertySource
static void configureProperties(DynamicPropertyRegistry registry) {
    registry.add("spring.datasource.url", postgres::getJdbcUrl);
    registry.add("spring.datasource.username", postgres::getUsername);
    registry.add("spring.datasource.password", postgres::getPassword);
}
```

Never substitute SQLite for Postgres in tests. Query behavior, type coercion, constraint enforcement, and JSON operators all differ. You will miss real bugs.

### Full Request Lifecycle Tests

```python
# FastAPI + httpx example
@pytest.fixture
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    with TestClient(app) as c:
        yield c

def test_should_create_and_return_order(client, db_session):
    # Act
    response = client.post("/orders", json={
        "customer_id": "cust-1",
        "items": [{"sku": "WIDGET", "qty": 2}]
    })

    # Assert HTTP response
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "pending"
    assert len(body["items"]) == 1

    # Assert DB side-effect
    order = db_session.query(Order).filter_by(id=body["id"]).one()
    assert order.status == "pending"
    assert order.customer_id == "cust-1"
```

### Factories Over Fixtures

**Fixtures** (static JSON/SQL files): good for reference data that rarely changes (countries, currencies, roles).

**Factories** (programmatic builders): preferred for test-specific data. Each test creates exactly the data it needs.

```python
# Factory pattern with factory_boy
class OrderFactory(factory.Factory):
    class Meta:
        model = Order

    id = factory.LazyFunction(uuid4)
    customer_id = factory.Sequence(lambda n: f"cust-{n}")
    status = "pending"
    created_at = factory.LazyFunction(datetime.utcnow)

class OrderItemFactory(factory.Factory):
    class Meta:
        model = OrderItem

    sku = factory.Sequence(lambda n: f"SKU-{n:04d}")
    quantity = 1
    unit_price = Decimal("9.99")

# Usage in tests
def test_should_calculate_total():
    order = OrderFactory(items=[
        OrderItemFactory(quantity=2, unit_price=Decimal("10.00")),
        OrderItemFactory(quantity=1, unit_price=Decimal("5.00")),
    ])
    assert order.total == Decimal("25.00")
```

### Test Isolation

Each test must start with a clean, predictable state. Two strategies:

**Transaction rollback** (faster): wrap each test in a transaction, roll back after.

```python
@pytest.fixture(autouse=True)
def db_session(engine):
    connection = engine.connect()
    transaction = connection.begin()
    session = Session(bind=connection)
    yield session
    session.close()
    transaction.rollback()
    connection.close()
```

**Truncate** (simpler, needed when testing commits): truncate all tables between tests.

```python
@pytest.fixture(autouse=True)
def clean_db(db_session):
    yield
    for table in reversed(Base.metadata.sorted_tables):
        db_session.execute(text(f"TRUNCATE {table.name} CASCADE"))
    db_session.commit()
```

### External Service Doubles

For HTTP dependencies you do not control:

| Tool        | Language  | Approach                          |
|-------------|-----------|-----------------------------------|
| WireMock    | Java/any  | Standalone HTTP mock server       |
| MockServer  | Java/any  | Expectation-based HTTP mock       |
| responses   | Python    | In-process request interception   |
| nock        | Node.js   | In-process HTTP interception      |
| httpretty   | Python    | Socket-level interception         |

```python
# Python responses library
@responses.activate
def test_should_handle_payment_gateway_timeout():
    responses.add(
        responses.POST,
        "https://api.payment.com/charge",
        body=requests.exceptions.Timeout()
    )
    result = payment_service.charge(Decimal("50.00"), "tok_123")
    assert result.status == "failed"
    assert result.error == "gateway_timeout"
```

---

## 4. Contract Testing

### Consumer-Driven Contracts (Pact)

The consumer defines the minimal API surface it depends on. The provider verifies it can satisfy that contract.

**Step 1 — Consumer writes a test:**

```python
# order-service (consumer) tests against user-service (provider)
@pact.given("user 123 exists")
@pact.upon_receiving("a request for user 123")
@pact.with_request("GET", "/users/123")
@pact.will_respond_with(200, body={
    "id": "123",
    "name": Like("Alice"),       # type matching
    "email": Like("alice@x.com")
})
def test_get_user(pact):
    user = user_client.get_user("123")
    assert user.name == "Alice"
```

**Step 2 — Publish pact to broker:**

```bash
pact-broker publish pacts/ --consumer-app-version=$(git rev-parse HEAD) --broker-base-url=https://pact.internal
```

**Step 3 — Provider verifies:**

```python
def test_provider_honors_pact():
    verifier = Verifier(provider="user-service", provider_base_url="http://localhost:8080")
    output, _ = verifier.verify_pacts(
        broker_url="https://pact.internal",
        enable_pending=True,
        provider_version=git_sha,
    )
    assert output == 0
```

**Step 4 — CI gate:**

```bash
pact-broker can-i-deploy --pacticipant order-service --version $(git rev-parse HEAD) --to production
```

### Event/Message Contracts

For async communication, use a schema registry with compatibility checks:

- **Avro + Confluent Schema Registry:** enforce backward/forward compatibility on Kafka topics.
- **JSON Schema + custom registry:** validate event payloads before publishing.
- **Pact message contracts:** same Pact workflow but for async messages instead of HTTP.

### Provider-Driven (OpenAPI)

When the provider owns the contract via an OpenAPI spec:

```bash
# Validate that the running server matches the spec
schemathesis run openapi.yaml --base-url=http://localhost:8080 --stateful=links
```

Consumers generate clients from the spec and test against it.

### When to Use

Apply contract testing at every service-to-service boundary. If service A calls service B, there must be a contract. No exceptions for "internal" services.

---

## 5. Testing Async / Event-Driven Systems

### Testing Message Consumers

**Layer 1 — Unit test the handler:**

```python
def test_should_update_inventory_when_order_placed():
    handler = InventoryHandler(repo=FakeInventoryRepo(stock={"SKU-1": 10}))
    handler.handle(OrderPlacedEvent(sku="SKU-1", quantity=3))
    assert handler.repo.get_stock("SKU-1") == 7
```

**Layer 2 — Integration test with real broker:**

```python
@pytest.fixture
def kafka(testcontainers_kafka):
    return KafkaProducer(bootstrap_servers=testcontainers_kafka.bootstrap_server)

def test_should_consume_order_event_from_kafka(kafka, inventory_consumer):
    kafka.send("orders", OrderPlacedEvent(sku="SKU-1", quantity=3).to_bytes())
    kafka.flush()

    # Poll until processed or timeout
    assert_eventually(
        lambda: inventory_repo.get_stock("SKU-1") == 7,
        timeout=10,
        interval=0.5
    )
```

**Layer 3 — Verify published messages:**

```python
def test_should_publish_shipment_event_when_order_fulfilled():
    capture = MessageCapture()
    service = FulfillmentService(publisher=capture)
    service.fulfill(order_id="ord-1")

    assert len(capture.messages) == 1
    event = capture.messages[0]
    assert event.type == "ShipmentCreated"
    assert event.order_id == "ord-1"
```

### Testing Sagas

Test each step independently, plus the full compensation path:

```python
def test_saga_compensates_on_payment_failure():
    saga = OrderSaga(
        inventory=FakeInventory(will_succeed=True),
        payment=FakePayment(will_succeed=False),  # simulate failure
        shipping=FakeShipping(),
    )
    result = saga.execute(order)

    assert result.status == "failed"
    assert saga.inventory.was_released()   # compensation ran
    assert not saga.shipping.was_called()  # never reached
```

Test timeout behavior:

```python
def test_saga_times_out_and_compensates():
    saga = OrderSaga(
        payment=SlowPayment(delay=30),  # exceeds timeout
        saga_timeout=5,
    )
    result = saga.execute(order)
    assert result.status == "timed_out"
    assert saga.inventory.was_released()
```

### Eventual Consistency: Poll, Don't Sleep

```python
# BAD
def test_bad():
    publish_event(order_created)
    time.sleep(5)  # Arbitrary, too slow on fast machines, too short on slow ones
    assert read_model.get_order(order_id) is not None

# GOOD
def assert_eventually(condition, timeout=10, interval=0.3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(interval)
    raise AssertionError(f"Condition not met within {timeout}s")

def test_good():
    publish_event(order_created)
    assert_eventually(lambda: read_model.get_order(order_id) is not None)
```

### Idempotency Testing

```python
def test_should_be_idempotent_on_duplicate_message():
    handler = PaymentHandler(repo=real_repo)
    event = PaymentReceivedEvent(order_id="ord-1", amount=Decimal("100.00"))

    handler.handle(event)
    handler.handle(event)  # duplicate

    payments = real_repo.get_payments_for_order("ord-1")
    assert len(payments) == 1  # not 2
```

---

## 6. Chaos Engineering

### Principles

1. **Hypothesize:** "If Redis goes down, the app falls back to DB cache and latency increases by < 200ms."
2. **Experiment:** Kill Redis.
3. **Measure:** Observe latency, error rate, fallback behavior.
4. **Learn:** Confirm or disprove hypothesis. Fix gaps.

### Failure Categories

| Category        | Examples                                          |
|-----------------|---------------------------------------------------|
| Infrastructure  | Node failure, disk full, network partition         |
| Dependency      | DB down, third-party API timeout, DNS failure      |
| Application     | Memory leak, thread pool exhaustion, deadlock      |
| Data            | Corrupted payload, schema mismatch, clock skew     |

### Tools

| Tool           | Scope           | Notes                                      |
|----------------|-----------------|---------------------------------------------|
| Chaos Toolkit  | General         | Declarative experiments, extensible          |
| Litmus         | Kubernetes      | CRD-based, good for K8s-native chaos        |
| Gremlin        | SaaS            | Commercial, broad attack surface             |
| toxiproxy      | Network         | Simulate latency, jitter, bandwidth limits   |
| pumba          | Docker          | Kill/pause/delay containers                  |

### Toxiproxy Example

```python
# Add 500ms latency to Postgres connections
toxiproxy_client.create(name="postgres", upstream="localhost:5432", listen="localhost:15432")
toxic = toxiproxy_client.get_proxy("postgres").add_toxic(
    name="latency", type="latency", attributes={"latency": 500}
)

# Run your test suite against localhost:15432
# Verify timeouts, retries, circuit breakers behave correctly

toxic.remove()
```

### Game Day Checklist

1. **Preparation:** Define blast radius. Notify stakeholders. Prepare rollback.
2. **Execution:** Run experiments. Monitor dashboards in real time.
3. **Stop condition:** If error rate exceeds X% or latency exceeds Y, abort immediately.
4. **Debrief:** Document findings. Create tickets for gaps. Schedule fixes.

### Progression

Start in **dev** with unit-level fault injection. Move to **staging** with infrastructure chaos. Graduate to **production canary** only with mature observability and a kill switch.

---

## 7. Load / Performance Testing

### Scenario Types

| Scenario | Pattern                   | Purpose                              |
|----------|---------------------------|--------------------------------------|
| Smoke    | 1-2 VUs, 1 min            | Verify script works                  |
| Load     | Normal traffic, 15-30 min | Baseline performance                 |
| Stress   | Ramp beyond capacity      | Find breaking point                  |
| Spike    | Sudden burst              | Test autoscaling / queue behavior    |
| Soak     | Sustained load, 2-8 hours | Detect memory leaks, connection leaks|

### k6 Example

```javascript
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  stages: [
    { duration: "2m",  target: 50 },   // ramp up
    { duration: "10m", target: 50 },   // hold
    { duration: "2m",  target: 200 },  // stress
    { duration: "5m",  target: 200 },  // hold stress
    { duration: "2m",  target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ["p(95)<300", "p(99)<500"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function () {
  // Realistic user journey, not single-endpoint hammering
  const loginRes = http.post(`${BASE_URL}/auth/login`, JSON.stringify({
    email: "loadtest@example.com",
    password: "test1234",
  }), { headers: { "Content-Type": "application/json" } });

  check(loginRes, { "login succeeded": (r) => r.status === 200 });
  const token = loginRes.json("token");

  sleep(Math.random() * 3 + 1); // Think time: 1-4 seconds

  const ordersRes = http.get(`${BASE_URL}/orders`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(ordersRes, { "orders loaded": (r) => r.status === 200 });

  sleep(Math.random() * 2 + 1);
}
```

### Metrics to Watch

| Metric              | Target (typical API)          |
|---------------------|-------------------------------|
| p50 latency         | < 100 ms                      |
| p95 latency         | < 300 ms                      |
| p99 latency         | < 500 ms                      |
| Error rate          | < 0.1%                        |
| Throughput          | Meets SLA (e.g., 1000 rps)    |
| CPU utilization     | < 70% at normal load           |
| Memory utilization  | Stable (no upward trend)       |
| DB connection pool  | < 80% utilized                 |

### Capacity Planning

1. Run a stress test to find the breaking point.
2. Plan infrastructure for **3x expected peak** traffic.
3. Revalidate after every major architectural change.
4. Automate performance tests in CI on a nightly schedule (not on every PR -- too slow).

---

## 8. Test Infrastructure

### CI Integration

- All unit + integration tests run on every PR. Non-negotiable.
- E2E tests run on merge to main or on a nightly schedule.
- Performance tests run nightly or weekly.

### Parallelization

```yaml
# GitHub Actions: split tests across parallel workers
strategy:
  matrix:
    shard: [1, 2, 3, 4]
steps:
  - run: pytest --shard-id=${{ matrix.shard }} --num-shards=4
```

Target: PR feedback in under 10 minutes. If tests take longer, split or parallelize.

### Flaky Test Policy

A flaky test is worse than no test: it trains developers to ignore failures.

**Policy:**
1. When a test is identified as flaky, tag it with `@flaky` and create a ticket.
2. The team has **1 week** to fix or delete it.
3. After 1 week, the test is automatically skipped and the ticket is escalated.
4. Track flaky rate as a team metric. Healthy: < 1%.

### Test Data Management

```python
# Builder pattern for complex test objects
class UserBuilder:
    def __init__(self):
        self._name = "Default User"
        self._email = f"user-{uuid4().hex[:8]}@test.com"
        self._role = "viewer"

    def with_name(self, name): self._name = name; return self
    def with_role(self, role): self._role = role; return self
    def admin(self): self._role = "admin"; return self

    def build(self) -> User:
        return User(name=self._name, email=self._email, role=self._role)

# Usage
user = UserBuilder().with_name("Alice").admin().build()
```

### Database Seeding

Separate concerns:
- **Reference data seed** (always loaded): countries, currencies, permission types. Loaded once before all tests.
- **Test-specific data**: created per test via factories. Never shared across tests.

### Secrets in Tests

- Never use production credentials. Ever.
- Use test-specific credentials with minimal permissions.
- Store test secrets in CI secret manager (GitHub Secrets, Vault).
- For local dev, use `.env.test` (gitignored) or testcontainers (no external credentials needed).

---

## 9. Mutation Testing

### Concept

Mutation testing modifies your production code (creates "mutants") and re-runs your tests. If tests still pass after a mutation, the mutant "survived" -- meaning your tests do not cover that logic path.

### Example Mutations

| Original                  | Mutant                        |
|---------------------------|-------------------------------|
| `if (a > b)`              | `if (a >= b)`                 |
| `return x + y`            | `return x - y`                |
| `if (isValid)`            | `if (true)`                   |
| `list.add(item)`          | `/* removed */`               |

### Tools

| Tool    | Language   | Notes                                 |
|---------|------------|---------------------------------------|
| Stryker | JS/TS/C#   | Mature, good reporting                |
| PIT     | Java       | Fast, integrates with Maven/Gradle    |
| mutmut  | Python     | Simple, works with pytest             |
| cargo-mutants | Rust | Cargo-native                         |

### Running PIT (Java)

```xml
<plugin>
    <groupId>org.pitest</groupId>
    <artifactId>pitest-maven</artifactId>
    <configuration>
        <targetClasses>
            <param>com.example.domain.*</param>
        </targetClasses>
        <targetTests>
            <param>com.example.domain.*Test</param>
        </targetTests>
        <mutationThreshold>80</mutationThreshold>
    </configuration>
</plugin>
```

```bash
mvn org.pitest:pitest-maven:mutationCoverage
```

### Where to Apply

- **Do:** Critical business logic (pricing, permissions, validation, state machines).
- **Don't:** Boilerplate (DTOs, configuration, generated code). The signal-to-noise ratio is too low.

---

## 10. Test Anti-Patterns

### Testing Implementation Details

**Symptom:** Tests break every time you refactor, even though behavior is unchanged.

```python
# ANTI-PATTERN: testing that a specific internal method was called
mock_repo.save.assert_called_with(expected_entity)

# BETTER: test the observable outcome
result = service.create_order(input)
assert result.id is not None
assert db.query(Order).filter_by(id=result.id).one().status == "created"
```

### Excessive Mocking

**Symptom:** Tests pass but the system breaks in integration.

If you are mocking more than 2 dependencies in a single test, the test is
probably not testing anything meaningful. Consider writing an integration test
instead.

```python
# ANTI-PATTERN: mocking everything
def test_with_too_many_mocks():
    service = OrderService(
        repo=Mock(), pricing=Mock(), inventory=Mock(),
        notifications=Mock(), audit=Mock()
    )
    # This test tells you nothing about real behavior
```

### Shared Mutable Test State

**Symptom:** Tests pass individually but fail when run together, or pass only in a specific order.

```python
# ANTI-PATTERN: module-level mutable state shared across tests
_orders = []

class TestOrderService:
    def test_add(self):
        _orders.append(Order(id="1"))
        assert len(_orders) == 1

    def test_count(self):
        assert len(_orders) == 0  # FAILS — previous test polluted state
```

**Fix:** Each test creates its own state. Use fixtures with function scope.

### Ignoring Flaky Tests

**Symptom:** Team develops "retry and hope" culture. CI results are not trusted.

A flaky test that is not fixed within a week should be deleted. A missing test
is better than a test that randomly fails, because the missing test does not
erode confidence in the entire suite.

### 100% Coverage Goal

**Symptom:** Team writes meaningless tests to hit a coverage number.

```python
# Written only to increase coverage — tests nothing useful
def test_repr():
    user = User(name="Alice")
    assert "Alice" in repr(user)
```

Coverage measures which lines were executed, not whether the assertions are
meaningful. Target 80-90% coverage on business logic. Do not set a global
coverage gate above 80%.

### Slow Test Suites

**Symptom:** Developers push without running tests. Broken code reaches main.

| Suite time | Developer behavior                        |
|------------|-------------------------------------------|
| < 5 min    | Runs tests before every push              |
| 5-15 min   | Runs tests occasionally                   |
| 15-30 min  | Runs tests only when CI forces it         |
| > 30 min   | Stops caring about test results entirely  |

**Fix:** Parallelize. Move slow tests to a separate stage. Profile the suite
and optimize the slowest tests first (usually integration tests with bad
setup/teardown or missing indexes in test DB).

---

## Quick Decision Matrix

| Question                                      | Answer                                           |
|-----------------------------------------------|--------------------------------------------------|
| Pure function with no deps?                   | Unit test                                        |
| Business logic with DB queries?               | Integration test with testcontainers             |
| API endpoint end-to-end?                      | Integration test (TestClient + real DB)           |
| Service calls another service?                | Contract test (Pact)                             |
| Critical user journey (signup, payment)?      | E2E test (keep count low)                        |
| Async message handling?                       | Unit test handler + integration test with broker |
| "Will it survive 10x traffic?"                | Load test with k6/Gatling                        |
| "Will it degrade gracefully under failure?"   | Chaos experiment                                 |
| "Do my tests actually catch bugs?"            | Mutation testing on critical paths               |
