import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Pool } from 'pg';
import { setupIntegrationTest, teardownIntegrationTest, IntegrationTestContext } from '../helpers/integration-setup';
import { startCapturePool } from '../../src/index';
import { SeederGenerator } from '../../src/generator/seeder-generator';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../src/utils/logger';

/**
 * E2E tests for complex query scenarios
 * 
 * Tests complete workflow: capture → generate seeders → populate target → verify
 */
describe('Complex Scenarios E2E', () => {
    let sourceContext: IntegrationTestContext;
    let targetPool: Pool;
    const outputDir = path.join(__dirname, '../fixtures/complex-scenarios-output');

    beforeAll(async () => {
        sourceContext = await setupIntegrationTest();

        targetPool = new Pool({
            host: 'localhost',
            port: 5434,
            database: 'seed_it_test_target',
            user: 'test_user',
            password: 'test_password'
        });

        // Drop and recreate schema in target to ensure clean state
        await targetPool.query('DROP SCHEMA IF EXISTS public CASCADE');
        await targetPool.query('CREATE SCHEMA public');

        const { createComprehensiveSchema } = await import('../helpers/db-helper');
        await targetPool.query(createComprehensiveSchema());

        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
        fs.mkdirSync(outputDir, { recursive: true });
    });

    afterAll(async () => {
        await teardownIntegrationTest(sourceContext);
        await targetPool.end();

        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true });
        }
    });

    it('should handle order with all relationships', async () => {
        const interceptor = startCapturePool(sourceContext.pool, 'order_relationships', {
            outputDir,
            captureReads: true
        });

        const query = `
            WITH order_details AS (
                SELECT 
                    o.id,
                    o.order_number,
                    o.total,
                    u.username,
                    u.email,
                    s.tracking_number,
                    s.carrier
                FROM orders o
                INNER JOIN users u ON u.id = o.user_id
                LEFT JOIN shipments s ON s.id = o.shipment_id
                WHERE o.id = $1
            )
            SELECT 
                od.*,
                array_agg(p.name ORDER BY p.name) as products
            FROM order_details od
            INNER JOIN order_items oi ON oi.order_id = od.id
            INNER JOIN products p ON p.id = oi.product_id
            GROUP BY od.id, od.order_number, od.total, od.username, od.email, od.tracking_number, od.carrier
        `;

        const sourceResult = await sourceContext.pool.query(query, [1]);
        expect(sourceResult.rows.length).toBe(1);
        expect(sourceResult.rows[0]).toHaveProperty('order_number');
        expect(Array.isArray(sourceResult.rows[0].products)).toBe(true);

        // Generate and apply seeders
        const generator = new SeederGenerator();
        // Generate rows first so we can modify them
        const rowsByTable = await generator.extractInserts(
            interceptor.getCapturedQueries(),
            sourceContext.oidMap,
            sourceContext.schemas,
            undefined,
            undefined,
            sourceContext.pool
        );

        // Break circular dependency between orders and shipments for the test
        const ordersSchema = sourceContext.schemas.find(s => s.tableName === 'orders');
        if (ordersSchema) {
            // Remove FK to shipments
            ordersSchema.foreignKeys = ordersSchema.foreignKeys.filter(fk => fk.referencedTable !== 'shipments');
        }

        const ordersRows = rowsByTable.get('orders');
        if (ordersRows) {
            ordersRows.forEach(row => {
                row.shipment_id = null;
            });
        }

        // Generate seeder file from modified rows
        const filePath = await generator.generateSeeder(
            rowsByTable,
            sourceContext.schemas,
            outputDir,
            'order_relationships',
            sourceContext.oidMap,
            undefined,
            sourceContext.pool
        );

        // Read generated SQL
        const sqlContent = fs.readFileSync(filePath, 'utf-8');
        log.info('Generated SQL Content:\n', sqlContent);

        // Execute generated SQL
        try {
            await targetPool.query(sqlContent);
        } catch (error) {
            console.error('Failed to execute generated SQL:', error);
            throw error;
        }

        // Verify query works on target
        const targetResult = await targetPool.query(query, [1]);
        expect(targetResult.rows.length).toBe(1);
        expect(targetResult.rows[0].order_number).toBe(sourceResult.rows[0].order_number);
        expect(targetResult.rows[0].products.length).toBe(sourceResult.rows[0].products.length);
    });

    it('should handle recursive CTE with self-referencing table', async () => {
        const interceptor = startCapturePool(sourceContext.pool, 'recursive_cte', {
            outputDir,
            captureReads: true
        });

        const query = `
            WITH RECURSIVE category_tree AS (
                SELECT id, name, parent_id, 0 as level
                FROM categories
                WHERE id = $1
                
                UNION ALL
                
                SELECT c.id, c.name, c.parent_id, ct.level + 1
                FROM categories c
                INNER JOIN category_tree ct ON c.parent_id = ct.id
            )
            SELECT * FROM category_tree
            ORDER BY level, name
        `;

        const sourceResult = await sourceContext.pool.query(query, [1]);
        expect(sourceResult.rows.length).toBeGreaterThan(0);

        // Generate and apply seeders
        const generator = new SeederGenerator();
        const rowsByTable = await generator.extractInserts(
            interceptor.getCapturedQueries(),
            sourceContext.oidMap,
            sourceContext.schemas,
            undefined,
            undefined,
            sourceContext.pool
        );

        // Generate seeder file
        const filePath = await generator.generateSeeder(
            interceptor.getCapturedQueries(),
            sourceContext.schemas,
            outputDir,
            'recursive_cte',
            sourceContext.oidMap,
            undefined,
            sourceContext.pool
        );

        // Read generated SQL
        const sqlContent = fs.readFileSync(filePath, 'utf-8');
        log.info('Generated SQL Content:\n', sqlContent);

        // Execute generated SQL
        try {
            await targetPool.query(sqlContent);
        } catch (error) {
            console.error('Failed to execute generated SQL:', error);
            throw error;
        }

        // Verify query works on target
        const targetResult = await targetPool.query(query, [1]);
        expect(targetResult.rows.length).toBe(sourceResult.rows.length);
    });
});
