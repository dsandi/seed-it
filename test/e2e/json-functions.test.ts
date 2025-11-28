import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';

/**
 * E2E tests for JSON functions
 */
describe('JSON Functions E2E', () => {
    let context: E2ETestContext;

    beforeAll(async () => {
        context = await setupE2EContext('json-functions');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should generate seeders for json_build_object queries', async () => {
        await runE2EScenario(context, {
            name: 'json_build_object',
            setupData: async (pool: Pool) => {
                await pool.query('TRUNCATE users, orders, products, order_items CASCADE');
                await pool.query(`
                    INSERT INTO users (id, email, username) 
                    VALUES (1, 'user@test.com', 'testuser')
                `);

                await pool.query(`
                    INSERT INTO orders (id, order_number, user_id, status, subtotal, total) 
                    VALUES (1, 'ORD-001', 1, 'completed', 100, 110)
                `);
            },
            query: `
                SELECT 
                    o.order_number,
                    json_build_object(
                        'user', u.username,
                        'total', o.total,
                        'status', o.status
                    ) as order_info
                FROM orders o
                INNER JOIN users u ON u.id = o.user_id
                WHERE o.id = $1
            `,
            params: [1]
        });
    });

    it.skip('should generate seeders for json_agg with complex objects', async () => {
        await runE2EScenario(context, {
            name: 'json_agg',
            setupData: async (pool: Pool) => {
                await pool.query('TRUNCATE users, orders, products, order_items CASCADE');
                await pool.query(`
                    INSERT INTO users (id, email, username) 
                    VALUES (1, 'user@test.com', 'testuser')
                `);

                await pool.query(`
                    INSERT INTO orders (id, order_number, user_id, status, subtotal, total) 
                    VALUES (1, 'ORD-001', 1, 'completed', 100, 110)
                `);

                await pool.query(`
                    INSERT INTO products (id, name, slug, price) 
                    VALUES (1, 'Product A', 'product-a', 50),
                           (2, 'Product B', 'product-b', 60)
                `);

                await pool.query(`
                    INSERT INTO order_items (order_id, product_id, quantity, unit_price, total_price) 
                    VALUES (1, 1, 2, 50, 100),
                           (1, 2, 1, 60, 60)
                `);
            },
            query: `
                SELECT 
                    o.order_number,
                    json_agg(
                        json_build_object(
                            'product', p.name,
                            'quantity', oi.quantity,
                            'price', oi.unit_price
                        )
                    ) as items
                FROM orders o
                INNER JOIN order_items oi ON oi.order_id = o.id
                INNER JOIN products p ON p.id = oi.product_id
                WHERE o.id = $1
                GROUP BY o.id, o.order_number
            `,
            params: [1]
        });
    });
});
