# seed-it

Capture PostgreSQL query results from your integration tests and generate seeders.

## Problem

Running 10,000+ integration tests against remote databases is slow. You want to run PostgreSQL locally, but need seeders to populate your local database with the data your tests expect.

## Solution

**seed-it** captures SELECT query results from your `pg.Pool` instances during test execution and generates SQL seeder files.

## Installation

```bash
npm install --save-dev seed-it
```

## Quick Start

### Step 1: Set Up Your Database Connections

**Recommended: Wrap clients from `pool.connect()`**

Most applications use `pool.connect()` to get clients. Wrap the connect method:

```javascript
const { Pool } = require('pg');
const { startCaptureClient } = require('seed-it');

const pool = new Pool({ database: 'db1' });

// Wrap pool.connect() to intercept all clients
const originalConnect = pool.connect.bind(pool);
let clientCounter = 0;

pool.connect = async function(...args) {
  const client = await originalConnect(...args);
  
  // Wrap each client
  startCaptureClient(client, 'db1', { outputDir: './output' });
  
  return client;
};

module.exports = { pool };
```

**Alternative: Direct pool wrapping** (if you use `pool.query()` directly):

```javascript
const { startCapturePool } = require('seed-it');
const pool = new Pool({ database: 'db1' });
startCapturePool(pool, 'db1', { outputDir: './output' });
```

**Alternative: Standalone clients:**

```javascript
const { Client } = require('pg');
const { startCaptureClient } = require('seed-it');

const client = new Client({ database: 'db1' });
await client.connect();
startCaptureClient(client, 'db1', { outputDir: './output' });
```

### Step 2: Save Data After Tests

In your test file:

```javascript
const { interceptors } = require('seed-it');
const { pool } = require('./db');

describe('My Tests', function() {
  it('should work', async function() {
    const client = await pool.connect();
    await client.query('SELECT * FROM users WHERE id = $1', [123]);
    client.release();
  });
});

// Save captured data after all tests
after(async function() {
  await interceptors.saveAll();
  console.log('Saved to ./output/captured-data.json');
});
```

### Step 3: Run Your Tests

Run your test suite. All SELECT query results are captured automatically.

### Step 4: Generate Seeders

```bash
npx seed-it generate \
  --db-name your_db \
  --db-user your_user \
  --db-password your_password
```

This generates:
- `./output/migrations/TIMESTAMP_initial_schema.up.sql` - Creates tables
- `./output/migrations/TIMESTAMP_initial_schema.down.sql` - Drops tables
- `./output/seeders/TIMESTAMP_initial_data.sql` - Inserts data

### Step 5: Use Generated Files

Run the migration on your local database:

```bash
psql -U your_user -d your_db -f output/migrations/*_initial_schema.up.sql
```

Run the seeder:

```bash
psql -U your_user -d your_db -f output/seeders/*_initial_data.sql
```

Done! Your local database now has the schema and data your tests need.

## Remote vs Local Databases

**Important distinction:**

- **Remote/Dev Database** (in `seed-it.config.js`):
  - Where you run your integration tests (e.g., Jenkins, CI/CD)
  - Where seed-it connects to introspect schema during `generate`
  - Example: `dev-server.example.com:5432`

- **Local Database** (not in config):
  - Your local PostgreSQL instance
  - Where you manually apply the generated SQL files
  - Example: `localhost:5432`

**Workflow:**
```
1. Tests run on REMOTE → Capture data
2. seed-it generate → Connects to REMOTE to get schema
3. You apply SQL → To your LOCAL database
```

**Example:**
```javascript
// seed-it.config.js - REMOTE databases
module.exports = {
  databases: [
    { 
      name: 'db1', 
      host: 'dev-server.example.com',  // Remote!
      port: 5432,
      user: 'dev_user',
      password: 'dev_password'
    }
  ]
};
```

```bash
# Apply to LOCAL database
psql -h localhost -U localuser -d localdb \
  -f seed-it-output/db1/migrations/initial_schema.up.sql
```

## Configuration

Create `seed-it.config.js` in your project root:

```javascript
module.exports = {
    // Remote/Dev databases (for schema introspection during generation)
    databases: [
        {
            name: 'db1',
            host: 'dev-server.example.com',  // Your remote dev/test server
            port: 5432,
            user: 'your_username',
            password: 'your_password'
        },
        {
            name: 'db2',
            host: 'dev-server.example.com',  // Your remote dev/test server
            port: 5432,
            user: 'your_username',
            password: 'your_password'
        }
    ],

    // Generator configuration
    generate: {
        inputFile: './seed-it-output/captured-data.json',
        outputDir: './seed-it-output',
        migrationName: 'initial_schema',
        seederName: 'initial_data',
        splitSeeders: false,
        deduplicateRows: true,
        handleCircularDeps: true
    }
};
```

Then simply run:

```bash
npx seed-it generate
```

## API Reference

### `startCapturePool(pool, databaseName, config?)`

Intercepts a `pg.Pool` instance to capture SELECT query results. **Automatically registers the interceptor globally.**

**Parameters:**
- `pool` - pg.Pool instance
- `databaseName` - Name of the database (used in output and as registry key)
- `config` - Optional configuration:
  - `outputDir` - Output directory (default: `'./output'`)
  - `databases` - Array of database names to capture (default: `[databaseName]`)
  - `captureReads` - Capture SELECT queries (default: `true`)
  - `captureWrites` - Capture INSERT/UPDATE/DELETE (default: `false`)
  - `verbose` - Log captured queries (default: `false`)

**Returns:** PoolInterceptor instance

### `startCaptureClient(client, databaseName, config?)`

Intercepts a `pg.Client` instance to capture SELECT query results. **Automatically registers the interceptor globally.**

**Parameters:**
- `client` - pg.Client instance
- `databaseName` - Name of the database (used in output and as registry key)
- `config` - Same options as `startCapturePool`

**Returns:** ClientInterceptor instance

### `interceptors` (Global Registry)

Access all registered interceptors from anywhere in your code.

**Methods:**
- `interceptors.saveAll()` - Save all captured queries to a single file (uses outputDir from config)
- `interceptors.getAllQueries()` - Get all captured queries from all interceptors
- `interceptors.get(name)` - Get a specific interceptor by database name
- `interceptors.getAll()` - Get array of all interceptors
- `interceptors.clearAll()` - Clear all captured queries

**Example:**
```javascript
// In your test teardown
after(async function() {
  await interceptors.saveAll();
});
```

## CLI Commands

### `seed-it generate`

Generates migrations and seeders from captured data.

```bash
npx seed-it generate [options]

Options:
  -c, --config <path>           Path to configuration file
  -i, --input <file>            Input file with captured data (default: ./output/captured-data.json)
  -o, --output <dir>            Output directory (default: ./output)
  --migration-name <name>       Migration name (default: initial_schema)
  --seeder-name <name>          Seeder name (default: initial_data)
  --split-seeders               Generate one seeder file per table
  --db-host <host>              Database host (default: localhost)
  --db-port <port>              Database port (default: 5432)
  --db-name <name>              Database name (required)
  --db-user <user>              Database user (required)
  --db-password <password>      Database password
```

## How It Works

1. **Interception**: Wraps `pg.Pool.query()` to capture all SELECT queries and their results
2. **Schema Analysis**: Introspects database to get table structures, PKs, FKs, indexes
3. **Dependency Resolution**: Uses topological sort to order tables by FK dependencies
4. **Deduplication**: Removes duplicate rows based on primary keys
5. **Generation**: Creates SQL files with proper ordering and formatting

## Features

- ✅ **Captures SELECT results** - Gets actual data returned by your queries
- ✅ **Supports Views** - Can query views (data comes from underlying tables)
- ✅ **Multiple databases** - Can capture from multiple PostgreSQL databases
- ✅ **Deduplication** - Removes duplicate rows based on primary keys
- ✅ **FK dependency resolution** - Orders INSERT statements correctly
- ✅ **Circular dependency detection** - Warns about problematic relationships
- ✅ **Zero test changes** - Just wrap your pools/clients, no test modifications needed

## Views Support

Views are **read-only** but seed-it handles them correctly:

- ✅ **Captures data** when you query views
- ✅ **Includes CREATE VIEW** statements in migrations
- ✅ **Seeds underlying tables** - Data goes into base tables, not views
- ✅ **Proper ordering** - Views are created AFTER tables in migrations

**How it works:**
```sql
-- Migration creates the view
CREATE VIEW active_users AS 
  SELECT * FROM users WHERE active = true;

-- Your test queries the view
SELECT * FROM active_users WHERE id = 123;

-- Seeder populates the underlying table
INSERT INTO users (id, name, active) VALUES (123, 'John', true);

-- View automatically shows the data
SELECT * FROM active_users; -- Returns John
```

## Multiple Databases

If you capture from multiple databases (e.g., `db1` and `db2`), seed-it **automatically handles them**:

**Setup in `seed-it.config.js`:**
```javascript
module.exports = {
  databases: [
    { name: 'db1', host: 'localhost', port: 5432, user: 'user', password: 'pass' },
    { name: 'db2', host: 'localhost', port: 5432, user: 'user', password: 'pass' }
  ]
};
```

**Run once:**
```bash
npx seed-it generate
```

**What happens:**
1. ✅ Analyzes schema for each database separately
2. ✅ Generates separate migrations: `db1_initial_schema.up.sql`, `db2_initial_schema.up.sql`
3. ✅ Generates separate seeders: `db1_initial_data.sql`, `db2_initial_data.sql`
4. ✅ Filters captured queries by database automatically

**Output:**
```
============================================================
Processing database: db1 (1/2)
============================================================
✓ Analyzed 15 tables
✓ Generated migration: seed-it-output/db1/migrations/initial_schema.up.sql
✓ Generated seeder: seed-it-output/db1/seeders/initial_data.sql

============================================================
Processing database: db2 (2/2)
============================================================
✓ Analyzed 12 tables
✓ Generated migration: seed-it-output/db2/migrations/initial_schema.up.sql
✓ Generated seeder: seed-it-output/db2/seeders/initial_data.sql
```

**Directory structure:**
```
seed-it-output/
├── db1/
│   ├── migrations/
│   │   ├── 20231127120000_initial_schema.up.sql
│   │   └── 20231127120000_initial_schema.down.sql
│   └── seeders/
│       └── 20231127120000_initial_data.sql
└── db2/
    ├── migrations/
    │   ├── 20231127120000_initial_schema.up.sql
    │   └── 20231127120000_initial_schema.down.sql
    └── seeders/
        └── 20231127120000_initial_data.sql
```

## Performance & Large Datasets

### Handling 10,000+ Tests

seed-it is optimized for large test suites:

**Memory Management:**
- ✅ Streaming writes for datasets > 1,000 queries
- ✅ Chunked processing (1,000 queries per chunk)
- ✅ Progress logging every 5,000 queries
- ✅ Avoids loading entire dataset into memory

**Example output:**
```
[seed-it] Writing 15000 queries in chunks...
[seed-it] Wrote 5000/15000 queries...
[seed-it] Wrote 10000/15000 queries...
[seed-it] Wrote 15000/15000 queries...
[seed-it] Saved 15000 queries to ./output/captured-data.json
```

**File Size Estimates:**
- 1,000 queries ≈ 500KB - 2MB
- 10,000 queries ≈ 5MB - 20MB
- 100,000 queries ≈ 50MB - 200MB

**Tips for Very Large Datasets:**
1. Run tests in batches and merge captured data
2. Use `--split-seeders` to generate one file per table
3. Filter captured data by database before generating
4. Consider sampling if you have millions of rows

## Limitations

- **PostgreSQL only** (Snowflake support planned)
- **Requires schema access** to introspect database structure
- **SELECT queries only** - Captures query results, not writes

## Example: Integration with Your Test Suite

```javascript
// test-setup.js
const { Pool } = require('pg');
const { startCapturePool } = require('seed-it');

// Create your pools
const pool1 = new Pool({ database: 'test_db_1' });
const pool2 = new Pool({ database: 'test_db_2' });

// Wrap with interceptors
const interceptor1 = startCapturePool(pool1, 'test_db_1', {
  outputDir: './output',
  verbose: false
});

const interceptor2 = startCapturePool(pool2, 'test_db_2', {
  outputDir: './output',
  verbose: false
});

// Export for use in tests
module.exports = { pool1, pool2, interceptor1, interceptor2 };

// In your test teardown:
// const { interceptor1, interceptor2 } = require('./test-setup');
// const allQueries = [...interceptor1.getCapturedQueries(), ...interceptor2.getCapturedQueries()];
// interceptor1.clear();
// allQueries.forEach(q => interceptor1.capturedQueries.push(q));
// await interceptor1.save();
```

## License

MIT
