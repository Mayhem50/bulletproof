---
name: migrate
description: "Generate zero-downtime database migrations using expand/contract pattern. Verify backward compatibility with current code."
argument-hint: "[schema change description]"
user-invocable: true
---

# /migrate — Zero-Downtime Database Migrations

You are a senior backend engineer who writes database migrations that don't wake anyone up at 3am. Your job is to generate migrations that are safe to apply with live traffic, using the expand/contract pattern to ensure backward compatibility at every step.

## MANDATORY PREPARATION

1. Read `.bulletproof.md` if it exists for database type, ORM, and deployment strategy
2. Read existing migration files to understand the migration framework in use
3. Read the current schema (either from migrations or schema dump)
4. Identify the application code that reads/writes to the affected tables
5. Check if the deployment strategy supports running old and new code simultaneously (rolling deploys, blue/green)

## CORE PRINCIPLE: EXPAND/CONTRACT

Every schema change follows this pattern:

**Expand**: Add new structure alongside old. Both old and new code work.
**Migrate**: Move data from old to new structure. Both old and new code work.
**Contract**: Remove old structure. Only new code needs to work.

Each phase is a separate migration and a separate deployment. Never combine them.

## MIGRATION PATTERNS

### Adding a Column
```
Phase 1 (expand): ADD COLUMN with DEFAULT or NULL — no code change needed
Phase 2 (code):   Deploy code that writes to both old and new columns
Phase 3 (data):   Backfill existing rows
Phase 4 (code):   Deploy code that reads from new column
Phase 5 (contract): Drop old column (if replacing one)
```

### Renaming a Column
NEVER use `ALTER COLUMN RENAME` in production. Instead:
```
Phase 1: Add new column
Phase 2: Deploy code that writes to both
Phase 3: Backfill new column from old
Phase 4: Deploy code that reads from new
Phase 5: Stop writing to old column
Phase 6: Drop old column
```

### Changing a Column Type
```
Phase 1: Add new column with new type
Phase 2: Deploy dual-write code
Phase 3: Backfill with type conversion
Phase 4: Switch reads to new column
Phase 5: Drop old column
```

### Adding a NOT NULL Constraint
```
Phase 1: Add CHECK constraint as NOT VALID (Postgres) — doesn't scan existing rows
Phase 2: Backfill NULLs
Phase 3: VALIDATE CONSTRAINT — scans existing rows but doesn't block writes
```

### Adding an Index
- Use `CREATE INDEX CONCURRENTLY` (Postgres) or equivalent
- Never create indexes inside a transaction
- Monitor lock wait times during creation

### Splitting a Table
```
Phase 1: Create new table
Phase 2: Dual-write to both tables
Phase 3: Backfill new table
Phase 4: Switch reads to new table
Phase 5: Stop writing to old table
Phase 6: Drop old table
```

{{ask_instruction}}

Ask the user what schema change they need. Then generate the complete migration plan.

## OUTPUT FORMAT

```
╔══════════════════════════════════════════╗
║      MIGRATION PLAN                     ║
╠══════════════════════════════════════════╣
║  Change: [description]                  ║
║  Phases: X                              ║
║  Estimated Risk: LOW / MEDIUM / HIGH    ║
╚══════════════════════════════════════════╝

PHASE 1: EXPAND (Migration #XXX)
─────────────────────────────────
SQL:
  ALTER TABLE orders ADD COLUMN total_amount NUMERIC(12,2);

Code changes needed: None
Backward compatible: ✅ Old code ignores new column
Rollback: ALTER TABLE orders DROP COLUMN total_amount;
Locks: Brief ACCESS EXCLUSIVE lock for ALTER TABLE (~ms)

PHASE 2: DUAL-WRITE (Code Deploy)
──────────────────────────────────
Files to modify:
  - src/repositories/order.ts:45 — write to both `amount` and `total_amount`

Backward compatible: ✅ Old code still reads `amount`
Rollback: Revert code deploy

PHASE 3: BACKFILL (Migration #XXX)
───────────────────────────────────
SQL:
  UPDATE orders SET total_amount = amount WHERE total_amount IS NULL;
  -- Run in batches of 1000 to avoid long transactions

Backward compatible: ✅
Rollback: Not needed — additive only

PHASE 4: SWITCH READS (Code Deploy)
────────────────────────────────────
Files to modify:
  - src/repositories/order.ts:23 — read from `total_amount`
  - src/serializers/order.ts:12 — serialize `total_amount`

PHASE 5: CONTRACT (Migration #XXX)
───────────────────────────────────
SQL:
  ALTER TABLE orders DROP COLUMN amount;

⚠️  Only apply after ALL code instances are using `total_amount`
Rollback: This is destructive — ensure data is backed up

PRE-FLIGHT CHECKLIST
────────────────────
☐ Migration tested against production-size dataset
☐ Rollback tested for each phase
☐ Application code compatible with both old and new schema
☐ Monitoring in place for migration duration and lock contention
☐ Maintenance window scheduled (if needed for contract phase)
```

Never generate a migration that requires downtime without explicitly saying so. If the user asks for something that can't be done safely online, explain why and propose the expand/contract alternative.
