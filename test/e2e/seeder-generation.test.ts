import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { CapturedQuery } from '../../src/types';
import * as fs from 'fs';
import * as path from 'path';
import { SeederGenerator } from '../../src/generator/seeder-generator';
import { setupIntegrationTest, teardownIntegrationTest, IntegrationTestContext } from '../helpers/integration-setup';
import { log } from '../../src/utils/logger';

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
        const rowsByTable = await generator.extractInserts(
            [capturedQuery],
            context.oidMap,
            context.schemas,
            undefined,
            undefined,
            context.pool
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

    it('should populate all columns (not just NOT NULL)', async () => {
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

        const rowsByTable = await generator.extractInserts(
            [capturedQuery],
            context.oidMap,
            context.schemas,
            undefined,
            undefined,
            context.pool
        );

        const productRows = rowsByTable.get('products');
        expect(productRows).toBeDefined();

        // Check that ALL columns are populated
        const productSchema = context.schemas.find(s => s.tableName === 'products');
        expect(productSchema).toBeDefined();

        const allColumns = productSchema!.columns.map(c => c.columnName);

        productRows!.forEach(row => {
            allColumns.forEach(col => {
                expect(row).toHaveProperty(col);
                // We don't check for undefined because null is a valid value for nullable columns
                // But the key must exist
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

        // Create a fresh test table
        await context.pool.query('CREATE TEMP TABLE users_test (LIKE users INCLUDING ALL)');

        // Generate seeder file
        const outputDir = path.join(__dirname, '../../fixtures/seeder-generation-output');
        const filePath = await generator.generateSeeder(
            [capturedQuery],
            context.schemas,
            outputDir,
            'valid_sql_test',
            context.oidMap,
            undefined,
            context.pool
        );

        // Read generated SQL
        let sqlContent = fs.readFileSync(filePath, 'utf-8');
        log.info('Generated SQL Content:\n', sqlContent);
        expect(sqlContent).toContain('INSERT INTO users');
        expect(sqlContent).toContain('ON CONFLICT');

        // Replace table name for test
        sqlContent = sqlContent.replace(/INSERT INTO users /g, 'INSERT INTO users_test ');

        // Execute generated SQL
        try {
            await context.pool.query(sqlContent);
        } catch (error) {
            console.error('Failed to execute generated SQL:', error);
            throw error;
        }

        // Verify data was inserted
        const verifyResult = await context.pool.query('SELECT * FROM users_test');
        // Expect 1 row because of deduplication/ON CONFLICT
        expect(verifyResult.rows.length).toBe(1);

        // Clean up
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
    });
});

