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

In your database setup file (e.g., `db.js`):

**Option A: Using Pools (recommended)**
```javascript
const { Pool } = require('pg');
const { startCapturePool } = require('seed-it');

const pool1 = new Pool({ database: 'db1', /* ... */ });
const pool2 = new Pool({ database: 'db2', /* ... */ });

// Wrap pools (automatically registered globally)
startCapturePool(pool1, 'db1', { outputDir: './output' });
startCapturePool(pool2, 'db2', { outputDir: './output' });

module.exports = { pool1, pool2 };
```

**Option B: Using Clients**
```javascript
const { Client } = require('pg');
const { startCaptureClient } = require('seed-it');

const client1 = new Client({ database: 'db1', /* ... */ });
const client2 = new Client({ database: 'db2', /* ... */ });

await client1.connect();
await client2.connect();

// Wrap clients (automatically registered globally)
startCaptureClient(client1, 'db1', { outputDir: './output' });
startCaptureClient(client2, 'db2', { outputDir: './output' });

module.exports = { client1, client2 };
```

### Step 2: Save Data After Tests

In your test file:

```javascript
const { interceptors } = require('seed-it');
const { pool1, pool2 } = require('./db');

describe('My Tests', function() {
  it('should work', async function() {
    await pool1.query('SELECT * FROM users WHERE id = $1', [123]);
    // Your tests...
  });
});

// Save captured data after all tests
after(async function() {
  await interceptors.saveAll('./output');
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

## Configuration

Create `seed-it.config.js` in your project root:

```javascript
module.exports = {
  database: {
    host: 'localhost',
    port: 5432,
    name: 'your_db',
    user: 'your_user',
    password: 'your_password'
  },
  generate: {
    inputFile: './output/captured-data.json',
    outputDir: './output',
    migrationName: 'initial_schema',
    seederName: 'initial_data',
    splitSeeders: false, // Set to true to generate one file per table
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
- `interceptors.saveAll(outputDir?)` - Save all captured queries to a single file
- `interceptors.getAllQueries()` - Get all captured queries from all interceptors
- `interceptors.get(name)` - Get a specific interceptor by database name
- `interceptors.getAll()` - Get array of all interceptors
- `interceptors.clearAll()` - Clear all captured queries

**Example:**
```javascript
// In your test teardown
after(async function() {
  await interceptors.saveAll('./output');
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

If you capture from multiple databases (e.g., `db1` and `db2`), the tool will:
1. Include data from all databases in the seeder
2. Use ONE database for schema introspection (specify with `--db-name`)
3. Warn you if multiple databases are detected

**Recommendation**: If your databases have different schemas, run `seed-it generate` separately for each database:

```bash
# Generate for db1
npx seed-it generate --db-name db1 --db-user user --seeder-name db1_data

# Generate for db2  
npx seed-it generate --db-name db2 --db-user user --seeder-name db2_data
```

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
