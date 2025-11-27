/**
 * Example configuration file for seed-it
 * 
 * IMPORTANT: These are your REMOTE/DEV database connections
 * (where you run tests and capture data)
 * 
 * The generated SQL files will be applied to your LOCAL database manually
 */
module.exports = {
    // Remote/Dev databases (for schema introspection during generation)
    databases: [
        {
            name: 'db1',
            host: 'dev-server.example.com',  // Your remote dev/test server
            port: 5432,
            user: 'your_username',
            password: 'your_password',
            ssl: { rejectUnauthorized: false } // Required for many remote databases (RDS, Neon, etc.)
        },
        {
            name: 'db2',
            host: 'dev-server.example.com',  // Your remote dev/test server
            port: 5432,
            user: 'your_username',
            password: 'your_password',
            ssl: { rejectUnauthorized: false }
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

/*
 * WORKFLOW:
 * 
 * 1. Run tests against REMOTE databases (captures data)
 * 2. Run `npx seed-it generate` (connects to REMOTE to introspect schema)
 * 3. Apply generated SQL to LOCAL database:
 *    psql -U localuser -d localdb -f seed-it-output/db1/migrations/*.up.sql
 *    psql -U localuser -d localdb -f seed-it-output/db1/seeders/*.sql
 */
