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

Wrap your `pool.connect()` method to intercept clients. This is the most reliable way to capture all queries.

```javascript
const { Pool } = require('pg');
const { startCaptureClient, interceptors } = require('seed-it');

const pool = new Pool({ database: 'db1' });

// Wrap pool.connect() to intercept all clients
const originalConnect = pool.connect.bind(pool);

pool.connect = async function(...args) {
  const client = await originalConnect(...args);
  
  // Wrap each client (automatically registers with global registry)
  // Default outputDir is './seed-it-output'
  startCaptureClient(client, 'db1'); 
  
  return client;
};

module.exports = { pool };
```

### Step 2: Save Data After Tests

In your test suite's global teardown (e.g., `after` in Mocha/Jest):

```javascript
const { interceptors } = require('seed-it');

// Save captured data after all tests
after(async function() {
  // Saves to ./seed-it-output/captured-data.json by default
  await interceptors.saveAll();
  console.log('Captured data saved!');
});
```

### Step 3: Configure

Create `seed-it.config.js` in your project root. This tells `seed-it` how to connect to your **remote/dev** database to introspect the schema.

```javascript
module.exports = {
  // Remote/Dev databases (where tests run)
  databases: [
    { 
      name: 'db1', 
      host: 'dev-db.example.com', 
      port: 5432, 
      user: 'dev_user', 
      password: 'dev_password',
      ssl: { rejectUnauthorized: false } // Enable SSL for remote DBs
    }
  ],

  // Optional: Generator configuration
  generate: {
    // Default values shown below:
    // inputFile: './seed-it-output/captured-data.json',
    // outputDir: './seed-it-output',
    // migrationName: 'initial_schema',
    // seederName: 'initial_data',
    // splitSeeders: false,
    // deduplicateRows: true,
    // handleCircularDeps: true
  }
};
```

### Step 4: Generate Seeders

Run the CLI command:

```bash
npx seed-it generate
```

This will:
1. Read captured data from `./seed-it-output/captured-data.json`
2. Connect to your remote database(s) to analyze schema
3. **Automatically infer column mappings** from query structure
4. Generate SQL files in `./seed-it-output/`

**Output Structure:**
```
seed-it-output/
├── db1/
│   ├── migrations/
│   │   ├── 20231127120000_initial_schema.up.sql
│   │   └── 20231127120000_initial_schema.down.sql
│   └── seeders/
│       └── 20231127120000_initial_data.sql
└── db2/
    ├── ...
```

### Step 5: Apply to Local Database

Apply the generated SQL files to your **local** database:

```bash
# Apply migration (create tables)
psql -h localhost -U localuser -d local_db1 -f seed-it-output/db1/migrations/*.up.sql

# Apply seeder (insert data)
psql -h localhost -U localuser -d local_db1 -f seed-it-output/db1/seeders/*.sql
```

## Remote vs Local Databases

**Important distinction:**

- **Remote/Dev Database** (in `seed-it.config.js`):
  - Where you run your integration tests (e.g., Jenkins, CI/CD)
  - Where seed-it connects to introspect schema during `generate`

- **Local Database** (not in config):
  - Your local PostgreSQL instance
  - Where you manually apply the generated SQL files

## Automatic Column Mapping

seed-it automatically handles calculated fields (e.g., `array_agg`, `CASE` statements) by parsing your SQL queries.

### Example: Array Aggregation

Your query:
```sql
SELECT kd.record_id, array_agg(kcd.ref_id) AS categories
FROM main_table kd
LEFT JOIN related_table kcd ON kcd.main_table_id_fk = kd.id
GROUP BY kd.record_id
```

seed-it automatically:
1. Detects `categories` is `array_agg(kcd.ref_id)`
2. Parses the JOIN to find `related_table` table
3. Extracts the foreign key relationship from `ON kcd.main_table_id_fk = kd.id`
4. Generates correct INSERTs:

```sql
INSERT INTO related_table (ref_id, main_table_id_fk) VALUES (101, 'test-rec-2741208312314');
INSERT INTO related_table (ref_id, main_table_id_fk) VALUES (101, 'test-rec-all');
INSERT INTO related_table (ref_id, main_table_id_fk) VALUES (102, 'test-rec-all');
-- etc.
```

**No configuration required!**

## API Reference

### `startCapturePool(pool, databaseName, config?)` / `startCaptureClient(client, databaseName, config?)`

Wraps a `pg.Pool` or `pg.Client` instance.

**Config Options:**
- `outputDir` - Directory to save captured data (default: `'./seed-it-output'`)
- `captureReads` - Capture SELECT queries (default: `true`)
- `captureWrites` - Capture INSERT/UPDATE/DELETE (default: `false`)
- `verbose` - Log captured queries (default: `false`)

### `interceptors` (Global Registry)

- `interceptors.saveAll()` - Save all captured queries to a single file.

## CLI Reference

### `seed-it generate`

Generates migrations and seeders. Reads from `seed-it.config.js`.

**Options:**
- `-c, --config <path>` - Path to configuration file
- `-i, --input <file>` - Input file (default: `./seed-it-output/captured-data.json`)
- `-o, --output <dir>` - Output directory (default: `./seed-it-output`)
- `--debug` - Enable debug logging

## Troubleshooting

### Debug Mode

If you encounter issues (e.g., empty seeders, missing data), enable debug logging:

```bash
npx seed-it generate --debug
```

This creates a `seed-it-debug.json` file in your output directory containing detailed information about:
- Which queries were processed
- Which queries were ignored and why
- Table name extraction results
- Row counts
- Skipped columns (calculated fields without mappings)

## Performance & Large Datasets

seed-it is optimized for large test suites (10,000+ tests):
- Streaming writes for large datasets
- Chunked processing to avoid OOM
- Progress logging

## License

MIT
