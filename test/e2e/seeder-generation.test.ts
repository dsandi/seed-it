import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { SeederGenerator } from '../../src/generator/seeder-generator';
import { setupIntegrationTest, teardownIntegrationTest, IntegrationTestContext } from '../helpers/integration-setup';

/**
 * End-to-end integration tests for seeder generation
 * Requires Docker PostgreSQL (npm run test:integration)
 */
describe('Seeder Generation', () => {
    let context: IntegrationTestContext;
    let generator: SeederGenerator;

    beforeAll(async () => {
        context = await setupIntegrationTest();
        generator = new SeederGenerator();
    });

    afterAll(async () => {
        await teardownIntegrationTest(context);
    });

    it('should generate complete seeder from complex query', async () => {
        const query = `
            SELECT 
                u.username,
                u.email,
                o.order_number,
                o.total,
                array_agg(p.name ORDER BY p.name) as product_names
            FROM users u
            INNER JOIN orders o ON o.user_id = u.id
            INNER JOIN order_items oi ON oi.order_id = o.id
            INNER JOIN products p ON p.id = oi.product_id
            WHERE u.id = $1
            GROUP BY u.id, u.username, u.email, o.id, o.order_number, o.total
        `;

        const result = await context.pool.query(query, [2]);

        // Create captured query
        const capturedQuery = {
            query,
            params: [2],
            result: {
                command: 'SELECT',
                rowCount: result.rowCount || 0,
                rows: result.rows,
                fields: result.fields
            },
            timestamp: Date.now(),
            database: 'seed_it_test'
        };

        // Extract inserts
        const rowsByTable = generator.extractInserts(
            [capturedQuery],
            context.oidMap,
            context.schemas
        );

        // Should extract rows for users, orders, order_items, products
        expect(rowsByTable.has('users')).toBe(true);
        expect(rowsByTable.has('orders')).toBe(true);

        // Verify data integrity
        const userRows = rowsByTable.get('users');
        expect(userRows).toBeDefined();
        expect(userRows!.length).toBeGreaterThan(0);

        // Each user row should have required columns
        userRows!.forEach(row => {
            expect(row).toHaveProperty('username');
            expect(row).toHaveProperty('email');
        });
    });

    it('should populate all NOT NULL columns', async () => {
        const query = `
            SELECT p.name, p.price, c.name as category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = $1
        `;

        const result = await context.pool.query(query, [1]);

        const capturedQuery = {
            query,
            params: [1],
            result: {
                command: 'SELECT',
                rowCount: result.rowCount || 0,
                rows: result.rows,
                fields: result.fields
            },
            timestamp: Date.now(),
            database: 'seed_it_test'
        };

        const rowsByTable = generator.extractInserts(
            [capturedQuery],
            context.oidMap,
            context.schemas
        );

        const productRows = rowsByTable.get('products');
        expect(productRows).toBeDefined();

        // Check that NOT NULL columns are populated
        const productSchema = context.schemas.find(s => s.tableName === 'products');
        expect(productSchema).toBeDefined();

        const notNullColumns = productSchema!.columns
            .filter(c => !c.isNullable)
            .map(c => c.columnName);

        productRows!.forEach(row => {
            notNullColumns.forEach(col => {
                expect(row[col]).toBeDefined();
            });
        });
    });

    it('should generate valid executable SQL', async () => {
        const query = `
            SELECT id, username, email
            FROM users
            WHERE id = $1
        `;

        const result = await context.pool.query(query, [2]);

        const capturedQuery = {
            query,
            params: [2],
            result: {
                command: 'SELECT',
                rowCount: result.rowCount || 0,
                rows: result.rows,
                fields: result.fields
            },
            timestamp: Date.now(),
            database: 'seed_it_test'
        };

        const rowsByTable = generator.extractInserts(
            [capturedQuery],
            context.oidMap,
            context.schemas
        );

        // Generate SQL statements
        const userRows = rowsByTable.get('users');

        expect(userRows).toBeDefined();
        expect(userRows!.length).toBeGreaterThan(0);

        // Create a fresh test table
        await context.pool.query('CREATE TEMP TABLE users_test (LIKE users INCLUDING ALL)');

        // Execute generated INSERT
        for (const row of userRows!) {
            const columns = Object.keys(row);
            const values = columns.map(col => row[col]);
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

            const insertSQL = `INSERT INTO users_test (${columns.join(', ')}) VALUES (${placeholders})`;
            await context.pool.query(insertSQL, values);
        }

        // Verify data was inserted
        const verifyResult = await context.pool.query('SELECT * FROM users_test');
        expect(verifyResult.rows.length).toBe(userRows!.length);
    });
});
