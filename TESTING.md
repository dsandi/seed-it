# Testing Guide

## Test Structure

```
test/
├── unit/      # Parser and logic tests (no database)
├── e2e/       # End-to-end tests with Docker PostgreSQL
├── helpers/   # Shared test utilities
└── scripts/   # Test management scripts
```

### Unit Tests (`test/unit/`)
- Test parsers, mappers, and logic in isolation
- No database required
- Run: `npm run test:unit`

### E2E Tests (`test/e2e/`)
- Test complete seed-it workflow with Docker PostgreSQL
- Uses two databases: source (remote simulation) and target (local simulation)
- Tests: capture query → generate seeders → apply to target → verify results match
- Run: `npm run test:e2e`

## Running Tests

```bash
# All tests (requires Docker for E2E)
npm test

# Unit tests only (fast, no Docker)
npm run test:unit

# E2E tests (starts/stops Docker automatically)
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

## Writing E2E Tests

Use the `e2e-helper` to write simple, focused tests:

```typescript
import { setupE2EContext, teardownE2EContext, runE2EScenario } from '../helpers/e2e-helper';

describe('My Feature E2E', () => {
    let context;

    beforeAll(async () => {
        context = await setupE2EContext('my-feature');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should test my scenario', async () => {
        await runE2EScenario(context, {
            name: 'my_scenario',
            setupData: async (pool) => {
                // Insert test data
                await pool.query(`INSERT INTO users ...`);
            },
            query: `SELECT ... FROM users WHERE id = $1`,
            params: [1]
        });
    });
});
```

The helper automatically:
1. Sets up data in source DB
2. Executes query and captures results
3. Generates seeders
4. Applies seeders to target DB
5. Verifies query returns same results
6. Logs detailed information at each step
