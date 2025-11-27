/**
 * Example: Mocha test file that saves captured data
 * 
 * This shows how to access the global interceptor registry
 * from your test file to save data in the after() hook
 */

const { interceptors } = require('seed-it');
const { pool1, pool2 } = require('./db-setup');

describe('My Tests', function () {

    it('should query users', async function () {
        const result = await pool1.query('SELECT * FROM users WHERE id = $1', [123]);
        // Your test assertions...
    });

    it('should query orders', async function () {
        const result = await pool2.query('SELECT * FROM orders WHERE user_id = $1', [123]);
        // Your test assertions...
    });

    // More tests...
});

// Global after hook - runs once after ALL tests
after(async function () {
    console.log('Saving captured data...');

    // Save all captured queries from all interceptors
    await interceptors.saveAll();

    console.log('Captured data saved to ./output/captured-data.json');
});
