# Backend Security Reference

Dense reference for secure backend engineering. Covers OWASP Top 10 (2021), authentication, authorization, input validation, secrets management, security headers, CORS, and dependency security.

---

## 1. OWASP Top 10 (2021) Quick Reference

### A01: Broken Access Control

**What:** Users act outside intended permissions — accessing other users' data (IDOR), escalating privileges, bypassing access checks via URL manipulation, or CORS misconfiguration allowing unauthorized cross-origin access.

**Detection:** Look for endpoints that use client-supplied IDs without ownership verification. Search for missing authorization middleware on routes. Check for `Access-Control-Allow-Origin: *` with credentials.

**Prevention:** Default-deny all routes. Verify resource ownership server-side. Disable directory listing. Rate-limit API access. Log and alert on access control failures.

```python
# VULNERABLE: IDOR — trusts client-supplied ID
@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id: int):
    return db.query(Invoice).filter(Invoice.id == invoice_id).first()

# SECURE: verifies ownership
@app.get("/api/invoices/{invoice_id}")
def get_invoice(invoice_id: int, current_user: User = Depends(get_current_user)):
    invoice = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.user_id == current_user.id
    ).first()
    if not invoice:
        raise HTTPException(status_code=404)  # 404 not 403 — don't leak existence
    return invoice
```

### A02: Cryptographic Failures

**What:** Weak or missing encryption of sensitive data. Includes: passwords stored as MD5/SHA1, data transmitted without TLS, weak cipher suites, hardcoded encryption keys, missing at-rest encryption for PII/financial data.

**Detection:** Search for `md5(`, `sha1(`, `SHA1`, `DES`, `RC4`. Check for `http://` URLs in API calls. Look for encryption keys in source code.

**Prevention:** Use bcrypt/argon2id for passwords. TLS 1.2+ everywhere. AES-256-GCM for symmetric encryption. RSA-2048+ or Ed25519 for asymmetric. Classify data and encrypt accordingly.

```javascript
// VULNERABLE: MD5 password hash
const hash = crypto.createHash('md5').update(password).digest('hex');

// SECURE: bcrypt with cost factor 12
const hash = await bcrypt.hash(password, 12);
const isValid = await bcrypt.compare(inputPassword, storedHash);
```

### A03: Injection

**What:** Untrusted data sent to an interpreter as part of a command or query. Includes SQL, NoSQL, OS command, LDAP, template, and log injection.

**Detection:** Search for string concatenation in queries: `f"SELECT`, `"SELECT * FROM " +`, `$"DELETE FROM`, `.exec(userInput)`, `eval(`, template literals in queries.

**Prevention:** Parameterized queries everywhere. ORMs with bound parameters. Avoid `eval()`, `exec()`, `child_process.exec()`. Sanitize log inputs to prevent log forging.

```python
# VULNERABLE: SQL injection
cursor.execute(f"SELECT * FROM users WHERE email = '{email}'")

# SECURE: parameterized query
cursor.execute("SELECT * FROM users WHERE email = %s", (email,))

# SECURE: ORM (SQLAlchemy)
user = db.query(User).filter(User.email == email).first()
```

```javascript
// VULNERABLE: NoSQL injection (MongoDB)
db.users.find({ username: req.body.username, password: req.body.password });
// Attacker sends: { "username": "admin", "password": { "$ne": "" } }

// SECURE: validate types, use explicit comparison
const username = String(req.body.username);
const user = await db.users.findOne({ username });
if (!user || !(await bcrypt.compare(String(req.body.password), user.passwordHash))) {
  throw new AuthError();
}
```

```python
# VULNERABLE: command injection
os.system(f"convert {user_filename} output.png")

# SECURE: use subprocess with array args (no shell)
subprocess.run(["convert", user_filename, "output.png"], check=True, shell=False)
```

```python
# VULNERABLE: log injection — attacker injects newlines to forge log entries
logger.info(f"Login attempt for user: {username}")

# SECURE: sanitize newlines
logger.info("Login attempt for user: %s", username.replace('\n', '').replace('\r', ''))
```

### A04: Insecure Design

**What:** Fundamental design flaws — not implementation bugs. Missing rate limits, mass assignment, no abuse case consideration, business logic flaws (e.g., negative quantities in cart).

**Detection:** Check for missing rate limiting on auth endpoints. Look for direct request body spread into models. Review business flows for bypass scenarios.

**Prevention:** Threat model during design. Add rate limiting. Use explicit allowlists for mass assignment. Validate business invariants server-side.

```python
# VULNERABLE: mass assignment — user can set is_admin=true
@app.post("/api/users")
def create_user(data: dict):
    user = User(**data)  # accepts any field including is_admin
    db.add(user)
    return user

# SECURE: explicit schema with allowed fields only
class CreateUserRequest(BaseModel):
    email: str
    name: str
    password: str
    # is_admin is NOT here — cannot be set by client

@app.post("/api/users")
def create_user(data: CreateUserRequest):
    user = User(**data.dict())
    db.add(user)
    return user
```

### A05: Security Misconfiguration

**What:** Debug mode in production, default credentials, verbose error messages leaking stack traces, unnecessary features enabled, permissive cloud storage policies.

**Detection:** Check `DEBUG = True`, `app.debug`, default ports with no auth (Redis 6379, Mongo 27017). Search for stack traces returned in HTTP responses.

**Prevention:** Hardened build process. Remove unused features/frameworks. Automate configuration verification. Different credentials per environment.

```python
# VULNERABLE: exposes internals in production
@app.exception_handler(Exception)
async def handler(request, exc):
    return JSONResponse({"error": str(exc), "trace": traceback.format_exc()})

# SECURE: generic message in production, details only in logs
@app.exception_handler(Exception)
async def handler(request, exc):
    logger.exception("Unhandled error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "request_id": request.state.request_id}
    )
```

### A06: Vulnerable Components

**What:** Using libraries with known CVEs. Outdated frameworks, transitive dependencies with vulnerabilities, unmaintained packages.

**Detection:** `npm audit`, `pip audit`, `cargo audit`, `trivy image scan`. Check dependency age and maintenance status.

**Prevention:** Automated dependency scanning in CI. Dependabot/Renovate for updates. Pin versions with lock files. Remove unused dependencies.

```yaml
# CI pipeline — fail build on high/critical vulnerabilities
- name: Audit dependencies
  run: |
    npm audit --audit-level=high
    # or: pip audit --desc --fix
    # or: cargo audit
```

### A07: Authentication Failures

**What:** Credential stuffing, brute force, weak password policies, session fixation, missing MFA on sensitive accounts.

**Detection:** Check for missing rate limits on `/login`. Look for session IDs that don't rotate after login. Search for passwords stored in plaintext or weak hashes.

**Prevention:** Rate-limit auth endpoints (5 attempts/min). Require strong passwords (12+ chars). Rotate session ID on login. Implement MFA. Use breach-detection password lists (HaveIBeenPwned API).

```python
# VULNERABLE: no rate limiting, no account lockout
@app.post("/login")
def login(email: str, password: str):
    user = db.query(User).filter(User.email == email).first()
    if user and verify_password(password, user.password_hash):
        return create_session(user)
    raise HTTPException(401)

# SECURE: rate limiting + constant-time comparison + session rotation
from slowapi import Limiter
limiter = Limiter(key_func=get_remote_address)

@app.post("/login")
@limiter.limit("5/minute")
def login(request: Request, creds: LoginRequest):
    user = db.query(User).filter(User.email == creds.email).first()
    if not user or not bcrypt.checkpw(creds.password.encode(), user.password_hash):
        # Same response time whether user exists or not
        raise HTTPException(401, detail="Invalid credentials")
    session = create_session(user)
    regenerate_session_id(session)  # prevent fixation
    return session
```

### A08: Data Integrity Failures

**What:** Unsigned JWTs, insecure deserialization, trusting unsigned software updates, CI/CD pipeline compromise.

**Detection:** Search for `algorithm: "none"`, `jwt.decode(token, verify=False)`, `pickle.loads(`, `yaml.load(` (without SafeLoader), `unserialize(`.

**Prevention:** Pin JWT algorithms server-side. Never use `verify=False`. Avoid native deserialization of user input. Sign CI/CD artifacts. Use SRI hashes for CDN resources.

```python
# VULNERABLE: accepts "none" algorithm
payload = jwt.decode(token, options={"verify_signature": False})

# VULNERABLE: pickle deserialization of user input
data = pickle.loads(request.body)  # arbitrary code execution

# SECURE: pin algorithm, verify signature
payload = jwt.decode(token, SECRET_KEY, algorithms=["RS256"])

# SECURE: use JSON for data exchange, never pickle/yaml from untrusted input
data = json.loads(request.body)
```

### A09: Logging & Monitoring Failures

**What:** Security events not logged, logs not monitored, PII leaked into logs, no alerting on suspicious activity.

**Detection:** Check if login failures, access denials, and input validation failures are logged. Search for passwords, tokens, or credit card numbers in log statements.

**Prevention:** Log all auth events, access control failures, server-side validation failures. Scrub PII from logs. Set up alerts for anomalous patterns. Ensure logs are tamper-evident.

```python
# VULNERABLE: logs password in plaintext
logger.info(f"Login attempt: email={email}, password={password}")

# VULNERABLE: logs nothing on failure — attacker invisible
def login(email, password):
    user = authenticate(email, password)
    if not user:
        return None

# SECURE: structured logging without PII, security events captured
logger.info("auth.login_attempt", extra={
    "email_hash": hashlib.sha256(email.encode()).hexdigest()[:16],
    "ip": request.client.host,
    "user_agent": request.headers.get("user-agent"),
    "success": False,
    "reason": "invalid_credentials"
})
```

### A10: Server-Side Request Forgery (SSRF)

**What:** Attacker supplies a URL that the server fetches, enabling access to internal services (metadata APIs, internal APIs, cloud provider credentials at 169.254.169.254).

**Detection:** Search for `requests.get(user_input)`, `fetch(userUrl)`, `urllib.urlopen(`. Any place user input controls a URL the server fetches.

**Prevention:** Allowlist permitted domains/IPs. Block RFC 1918 ranges and link-local addresses. Disable HTTP redirects or re-validate after redirect. Use a dedicated egress proxy.

```python
# VULNERABLE: fetches any URL the user provides
@app.post("/api/fetch-preview")
def fetch_preview(url: str):
    resp = requests.get(url)  # attacker sends http://169.254.169.254/latest/meta-data/
    return {"content": resp.text}

# SECURE: validate URL against allowlist, block internal ranges
import ipaddress
from urllib.parse import urlparse

BLOCKED_RANGES = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
]

def is_safe_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    try:
        ip = ipaddress.ip_address(socket.gethostbyname(parsed.hostname))
        return not any(ip in network for network in BLOCKED_RANGES)
    except (socket.gaierror, ValueError):
        return False

@app.post("/api/fetch-preview")
def fetch_preview(url: str):
    if not is_safe_url(url):
        raise HTTPException(400, "URL not allowed")
    resp = requests.get(url, allow_redirects=False, timeout=5)
    return {"content": resp.text[:10000]}
```

---

## 2. Authentication Patterns

### Password Hashing

Use **bcrypt** (cost 12+) or **argon2id** (preferred for new systems). NEVER MD5, SHA-1, SHA-256 (even salted — too fast for brute force).

```python
# bcrypt — widely supported, battle-tested
import bcrypt
hashed = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12))
valid = bcrypt.checkpw(password.encode("utf-8"), hashed)

# argon2id — memory-hard, resistant to GPU/ASIC attacks (preferred)
from argon2 import PasswordHasher
ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
hashed = ph.hash(password)
valid = ph.verify(hashed, password)  # raises on mismatch
```

### JWT Best Practices

| Rule | Detail |
|------|--------|
| Algorithm pinning | Always specify `algorithms=["RS256"]` on decode. Never allow `"none"`. |
| Short-lived access tokens | 15-30 minute expiration. |
| Refresh token rotation | Issue new refresh token on each use. Invalidate the old one. |
| Refresh token storage | Store in DB with user association. Enable revocation. |
| Client storage | HttpOnly, Secure, SameSite=Strict cookies. NEVER localStorage (XSS vulnerable). |
| Claims | Minimal payload: sub, exp, iat, jti. No secrets in payload (it is base64, not encrypted). |

```python
# Token generation
access_token = jwt.encode(
    {"sub": user.id, "exp": datetime.utcnow() + timedelta(minutes=15), "jti": str(uuid4())},
    PRIVATE_KEY,
    algorithm="RS256"
)
refresh_token = secrets.token_urlsafe(64)
db.store_refresh_token(user_id=user.id, token_hash=sha256(refresh_token), expires=timedelta(days=30))

# Token verification — always pin algorithm
payload = jwt.decode(access_token, PUBLIC_KEY, algorithms=["RS256"])

# Refresh rotation
def refresh(old_refresh_token: str):
    token_record = db.get_refresh_token(hash=sha256(old_refresh_token))
    if not token_record or token_record.revoked or token_record.expired:
        # Possible token reuse attack — revoke entire family
        db.revoke_all_tokens(user_id=token_record.user_id)
        raise HTTPException(401)
    db.revoke_refresh_token(token_record.id)
    new_refresh = secrets.token_urlsafe(64)
    db.store_refresh_token(user_id=token_record.user_id, token_hash=sha256(new_refresh), ...)
    new_access = generate_access_token(token_record.user_id)
    return new_access, new_refresh
```

### Session Management: Sessions vs JWT

| Aspect | Server-Side Sessions | JWT |
|--------|---------------------|-----|
| Storage | Server (Redis/DB) | Client (cookie/header) |
| Revocation | Immediate (delete from store) | Hard (need blocklist or short expiry) |
| Scalability | Requires shared session store | Stateless — any server can verify |
| Best for | Traditional web apps, need instant revocation | Microservices, short-lived auth |

### OAuth 2.0 / OIDC

For SPAs and mobile apps, use **Authorization Code flow with PKCE**. Never use Implicit flow (tokens in URL fragment — leaked in history/logs).

Key rules:
- Validate `state` parameter to prevent CSRF.
- Validate `id_token` signature and claims (iss, aud, exp, nonce).
- Exchange authorization code server-side when possible.
- Store tokens securely (backend-for-frontend pattern preferred for SPAs).

### API Key Authentication

Use when: machine-to-machine, simple integrations, webhook verification.
Do NOT use as sole auth for user-facing endpoints.

Rules:
- Scope keys to specific permissions/resources.
- Hash keys in DB (store only prefix + hash, e.g., `sk_live_abc...` display, SHA-256 for lookup).
- Set expiration and support rotation (allow two active keys during transition).
- Transmit in headers (`Authorization: Bearer <key>` or `X-API-Key`), never in query strings (logged in access logs).

---

## 3. Authorization Patterns

### RBAC (Role-Based Access Control)

Simple, effective for most applications. Users get roles, roles get permissions.

```python
# Middleware approach
ROLE_PERMISSIONS = {
    "admin": {"users:read", "users:write", "invoices:read", "invoices:write", "settings:write"},
    "manager": {"users:read", "invoices:read", "invoices:write"},
    "viewer": {"invoices:read"},
}

def require_permission(permission: str):
    def decorator(func):
        @wraps(func)
        async def wrapper(request: Request, *args, **kwargs):
            user = request.state.user
            user_perms = ROLE_PERMISSIONS.get(user.role, set())
            if permission not in user_perms:
                raise HTTPException(403)
            return await func(request, *args, **kwargs)
        return wrapper
    return decorator

@app.delete("/api/users/{user_id}")
@require_permission("users:write")
async def delete_user(request: Request, user_id: int):
    ...
```

### ABAC (Attribute-Based Access Control)

Flexible policies based on user attributes, resource attributes, and environment.

```python
# Policy: "managers can approve invoices under $10k in their own department"
def can_approve_invoice(user, invoice):
    return (
        user.role == "manager"
        and invoice.department == user.department
        and invoice.amount < 10_000
        and not invoice.is_approved
    )
```

### ReBAC (Relationship-Based Access Control)

Based on Google Zanzibar. Good for: documents, social features, shared resources. Define authorization as relationships: `user:123 is editor of document:456`.

Services: SpiceDB, Ory Keto, Authzed, AWS Verified Permissions.

### Key Principles

- **Default deny:** Every endpoint must explicitly declare required permissions. Unauthenticated/unauthorized = 403 by default.
- **Enforce at service layer**, not just middleware. Defense in depth.
- **IDOR prevention:** Always filter queries by the authenticated user's ownership/relationship. Never trust client-supplied resource IDs alone.

---

## 4. Input Validation

### Principles

- Validate at **system boundaries** (API layer). Internal code can trust validated data.
- **Allowlist** (accept known good) always beats **blocklist** (reject known bad). Blocklists are incomplete by definition.
- Validate **type, length, format, range** — in that order.

### SQL Injection Prevention

```python
# ALWAYS: parameterized queries
cursor.execute("SELECT * FROM products WHERE category = %s AND price < %s", (category, max_price))

# NEVER: string concatenation or f-strings
cursor.execute(f"SELECT * FROM products WHERE category = '{category}'")
```

### XSS Prevention

- **Output encoding:** Encode all dynamic content when rendering HTML. Frameworks like React auto-escape by default; avoid `dangerouslySetInnerHTML`.
- **Content-Security-Policy:** Restrict script sources to prevent injected scripts from executing.

```javascript
// VULNERABLE: inserting raw HTML
element.innerHTML = userInput;

// SECURE: use textContent for plain text
element.textContent = userInput;

// SECURE: React auto-escapes (safe by default)
return <div>{userInput}</div>;

// VULNERABLE: React escape hatch
return <div dangerouslySetInnerHTML={{ __html: userInput }} />;
```

### Path Traversal

```python
import os

# VULNERABLE
file_path = f"/uploads/{user_supplied_filename}"
with open(file_path) as f:  # user sends "../../etc/passwd"
    return f.read()

# SECURE: resolve and verify the path stays within allowed directory
UPLOAD_DIR = os.path.realpath("/uploads")
requested = os.path.realpath(os.path.join(UPLOAD_DIR, user_supplied_filename))
if not requested.startswith(UPLOAD_DIR + os.sep):
    raise HTTPException(400, "Invalid path")
with open(requested) as f:
    return f.read()
```

### Mass Assignment

Always use explicit schemas/allowlists for incoming request data (covered in A04 above). Never spread raw request bodies into database models.

---

## 5. Secrets Management

### Rules

1. **Never hardcode secrets.** Environment variables are the minimum. A secrets vault is preferred.
2. **Rotate on exposure.** If a secret appears in git history, logs, or error messages — rotate immediately.
3. **Secrets in git history persist forever.** Removing from code does not remove from history. Always rotate after accidental commit.

### Detection Patterns

```
# Common secret patterns to scan for
AWS keys:        AKIA[0-9A-Z]{16}
Stripe:          sk_live_[a-zA-Z0-9]{24,}
GitHub PAT:      ghp_[a-zA-Z0-9]{36}
Generic secret:  (?i)(secret|password|token|api_key)\s*[:=]\s*['"][^'"]{8,}
Private key:     -----BEGIN (RSA |EC )?PRIVATE KEY-----
Connection str:  (mysql|postgres|mongodb)://[^:]+:[^@]+@
```

### Pre-Commit Hooks

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks
```

Tools: **gitleaks** (fastest, regex-based), **detect-secrets** (baseline approach), **git-secrets** (AWS-focused), **trufflehog** (high entropy + verified secrets).

### Vault Patterns

```python
# HashiCorp Vault
import hvac
client = hvac.Client(url="https://vault.internal:8200", token=os.environ["VAULT_TOKEN"])
secret = client.secrets.kv.v2.read_secret_version(path="myapp/db")
db_password = secret["data"]["data"]["password"]

# AWS Secrets Manager
import boto3
client = boto3.client("secretsmanager")
secret = json.loads(
    client.get_secret_value(SecretId="myapp/db")["SecretString"]
)
```

---

## 6. Security Headers

Apply on every HTTP response. Use middleware/reverse proxy (nginx, Caddy, CloudFront).

```python
# FastAPI middleware example
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # Remove headers that leak server info
    response.headers.pop("Server", None)
    response.headers.pop("X-Powered-By", None)
    return response
```

```nginx
# nginx equivalent
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
server_tokens off;
```

| Header | Purpose | Value |
|--------|---------|-------|
| Strict-Transport-Security | Force HTTPS | `max-age=31536000; includeSubDomains; preload` |
| Content-Security-Policy | Restrict resource loading | `default-src 'self'` (customize per app) |
| X-Content-Type-Options | Prevent MIME sniffing | `nosniff` |
| X-Frame-Options | Prevent clickjacking | `DENY` |
| Referrer-Policy | Control referrer leakage | `strict-origin-when-cross-origin` |
| Permissions-Policy | Disable browser features | `camera=(), microphone=(), geolocation=()` |

---

## 7. CORS

### Rules

1. **Never** use `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`. Browsers block this, but misconfigurations in custom CORS handling can bypass it.
2. **Allowlist specific origins.** Do not reflect the `Origin` header back without validation.
3. **Cache preflight:** Set `Access-Control-Max-Age` to reduce OPTIONS requests (e.g., 7200 seconds).

```python
# VULNERABLE: reflects any origin
@app.middleware("http")
async def cors(request, call_next):
    response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = request.headers.get("origin", "*")
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response

# SECURE: explicit allowlist
ALLOWED_ORIGINS = {"https://app.example.com", "https://admin.example.com"}

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-Id"],
    max_age=7200,
)
```

---

## 8. Dependency Security

### Automated Auditing

Run in CI. Fail builds on high/critical severity.

```bash
# Node.js
npm audit --audit-level=high
# Python
pip audit --desc
# Rust
cargo audit
# Go
govulncheck ./...
# Docker images
trivy image myapp:latest --severity HIGH,CRITICAL
```

### Automated Updates

Use **Dependabot** or **Renovate** to receive PRs for dependency updates. Configure:
- Auto-merge for patch updates with passing CI.
- Group related updates (e.g., all AWS SDK packages).
- Schedule: weekly for non-critical, immediate for security patches.

### Lock Files

Always commit lock files (`package-lock.json`, `poetry.lock`, `Cargo.lock`, `go.sum`). They pin exact transitive dependency versions, preventing supply chain attacks via malicious updates.

### Supply Chain Security

- Use `npm --ignore-scripts` during CI install to prevent postinstall attacks.
- Verify package checksums against lock file.
- Consider private registries or mirroring for critical dependencies.
- Enable npm provenance / sigstore verification where available.
- Review new dependencies before adoption: check maintenance activity, download count, known vulnerabilities.

```json
// package.json — restrict install scripts
{
  "scripts": {
    "preinstall": "npx only-allow pnpm"
  }
}

// .npmrc — restrict lifecycle scripts in CI
ignore-scripts=true
```

---

## Quick Checklist

Use this as a code review security gate:

- [ ] All endpoints require authentication (unless explicitly public)
- [ ] Resource access checks verify ownership (no IDOR)
- [ ] Passwords hashed with bcrypt (12+) or argon2id
- [ ] JWTs have algorithm pinning and short expiry
- [ ] All database queries use parameterized inputs
- [ ] User input validated with allowlist schemas at API boundary
- [ ] No secrets in source code or logs
- [ ] Security headers set on all responses
- [ ] CORS configured with explicit origin allowlist
- [ ] Dependencies audited in CI pipeline
- [ ] Auth failures and access denials logged (without PII)
- [ ] Rate limiting on authentication endpoints
- [ ] TLS 1.2+ enforced for all external communication
- [ ] Error responses do not leak internal details
