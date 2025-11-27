/**
 * Example: Database setup with Pools and Clients
 * 
 * Shows both Pool and Client usage patterns
 */

const { Pool, Client } = require('pg');
const { startCapturePool, startCaptureClient } = require('seed-it');

// Option 1: Using Pools (recommended for connection pooling)
const pool1 = new Pool({
    host: 'localhost',
    database: 'test_db_1',
    user: 'user',
    password: 'password',
    port: 5432
});

const pool2 = new Pool({
    host: 'localhost',
    database: 'test_db_2',
    user: 'user',
    password: 'password',
    port: 5432
});

// Wrap pools - automatically registered globally
startCapturePool(pool1, 'test_db_1', {
    outputDir: './output',
    verbose: false
});

startCapturePool(pool2, 'test_db_2', {
    outputDir: './output',
    verbose: false
});

// Option 2: Using Clients (for single connections)
const client1 = new Client({
    host: 'localhost',
    database: 'test_db_3',
    user: 'user',
    password: 'password',
    port: 5432
});

// Connect the client
async function setupClients() {
    await client1.connect();

    // Wrap client - automatically registered globally
    startCaptureClient(client1, 'test_db_3', {
        outputDir: './output',
        verbose: false
    });
}

setupClients();

// Export for use in tests
module.exports = { pool1, pool2, client1 };
