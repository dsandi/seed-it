/**
 * Example: Database setup with Pools and Clients
 * 
 * Shows both pool.query() and pool.connect() patterns
 */

const { Pool, Client } = require('pg');
const { startCapturePool, startCaptureClient } = require('seed-it');

// ============================================
// OPTION 1: Direct pool.query() pattern
// ============================================
// Use this if you call pool.query() directly

const pool1 = new Pool({
    host: 'localhost',
    database: 'test_db_1',
    user: 'user',
    password: 'password',
    port: 5432
});

startCapturePool(pool1, 'test_db_1', {
    outputDir: './seed-it-output',
    verbose: false
});

// ============================================
// OPTION 2: pool.connect() pattern (RECOMMENDED)
// ============================================
// Use this if you use pool.connect() to get clients

const pool2 = new Pool({
    host: 'localhost',
    database: 'test_db_2',
    user: 'user',
    password: 'password',
    port: 5432
});

// Wrap pool.connect() to intercept all clients
const originalConnect = pool2.connect.bind(pool2);

pool2.connect = async function (...args) {
    const client = await originalConnect(...args);

    // Wrap each client from the pool
    startCaptureClient(client, 'test_db_2', {
        outputDir: './seed-it-output',
        verbose: false
    });

    return client;
};

// ============================================
// OPTION 3: Standalone Client
// ============================================

const client1 = new Client({
    host: 'localhost',
    database: 'test_db_3',
    user: 'user',
    password: 'password',
    port: 5432
});

async function setupClient() {
    await client1.connect();

    startCaptureClient(client1, 'test_db_3', {
        outputDir: './seed-it-output',
        verbose: false
    });
}

setupClient();

// Export for use in tests
module.exports = { pool1, pool2, client1 };
