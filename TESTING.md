# Testing Guide

## Test Structure

```
test/
├── unit/      # Parser and logic tests (no database)
├── e2e/       # All database tests (pg-mem + Docker PostgreSQL)
├── helpers/   # Shared test utilities
└── scripts/   # Test management scripts
```

### Unit Tests (`test/unit/`)
- Test parsers, mappers, and logic in isolation
- No database required
- Run: `npm run test:unit`

### E2E Tests (`test/e2e/`)
Contains two types of tests:

**Quick Tests (pg-mem)**
- Files: `case-subquery-integration.test.ts`, `comprehensive-queries.test.ts`, `param-extraction.test.ts`, `traffic-capture.test.ts`
- Fast in-memory PostgreSQL for quick feedback
- Some limitations (no LATERAL, json_build_object)
- Good for development

**Full Tests (Docker PostgreSQL)**
- Files: `lateral-joins.test.ts`, `json-functions.test.ts`, `seeder-generation.test.ts`, `complex-scenarios.test.ts`
- Complete PostgreSQL feature support
- Tests full seed-it workflow
- Requires Docker

## Running Tests

```bash
# All tests (requires Docker for full E2E)
npm test

# Unit tests only (fastest, no Docker)
npm run test:unit

# All E2E tests (starts/stops Docker automatically)
npm run test:e2e

# Watch mode (start Docker first)
./test/scripts/test-db.sh start
npm run test:e2e:watch
```

## Docker PostgreSQL

E2E tests use **two databases** to simulate the real workflow:
- **Source DB** (port 5433) - Simulates remote/production DB with data
- **Target DB** (port 5434) - Simulates local DB where seeders are applied

### Prerequisites
- Docker and Docker Compose installed
- Ports 5433 and 5434 available

### Management

```bash
./test/scripts/test-db.sh start     # Start both containers
./test/scripts/test-db.sh stop      # Stop both containers
./test/scripts/test-db.sh restart   # Restart
./test/scripts/test-db.sh clean     # Remove volumes
./test/scripts/test-db.sh psql      # Connect with psql (prompts for source/target)
```

### Connection Details

**Source DB (remote simulation):**
- Host: localhost
- Port: 5433
- Database: seed_it_test
- User: test_user
- Password: test_password

**Target DB (local simulation):**
- Host: localhost
- Port: 5434
- Database: seed_it_test_target
- User: test_user
- Password: test_password
