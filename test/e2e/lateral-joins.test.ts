import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';

/**
 * E2E tests for LATERAL joins
 * 
 * Uses e2e-helper to orchestrate: setup → capture → generate → seed → verify
 */
describe('LATERAL Joins E2E', () => {
    let context: E2ETestContext;

    beforeAll(async () => {
        context = await setupE2EContext('lateral-joins');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should generate seeders that make LATERAL join query work', async () => {
        await runE2EScenario(context, {
            name: 'lateral_join_recent_orders',
            setupData: async (pool: Pool) => {
                // Insert test data
                await pool.query('TRUNCATE users, orders, products, categories CASCADE');
                await pool.query(`
                    INSERT INTO users (id, email, username, full_name) 
                    VALUES (1, 'user1@test.com', 'user1', 'User One'),
                    (2, 'user2@test.com', 'user2', 'User Two')
                `);

                await pool.query(`
                    INSERT INTO orders (id, order_number, user_id, status, subtotal, total) 
                    VALUES (1, 'ORD-001', 2, 'completed', 100, 100),
                           (2, 'ORD-002', 2, 'completed', 200, 200),
                           (3, 'ORD-003', 2, 'pending', 300, 300)
                `);
            },
            query: `
                SELECT u.username, recent_orders.*
                FROM users u
                CROSS JOIN LATERAL (
                    SELECT o.order_number, o.total, o.status
                    FROM orders o
                    WHERE o.user_id = u.id
                    ORDER BY o.created_at DESC
                    LIMIT 3
                ) recent_orders
                WHERE u.id = $1
            `,
            params: [2]
        });
    });

    it.skip('should handle LATERAL join with aggregates', async () => {
        await runE2EScenario(context, {
            name: 'lateral_join_aggregates',
            setupData: async (pool: Pool) => {
                await pool.query('TRUNCATE users, orders, products, categories CASCADE');
                await pool.query(`
                    INSERT INTO categories (id, name, slug) 
                    VALUES (1, 'Electronics', 'electronics'),
                           (2, 'Books', 'books')
                `);

                await pool.query(`
                    INSERT INTO products (id, name, slug, price, category_id) 
                    VALUES (1, 'Laptop', 'laptop', 999.99, 1),
                           (2, 'Mouse', 'mouse', 29.99, 1),
                           (3, 'Book', 'book', 19.99, 2)
                `);
            },
            query: `
                SELECT 
                    c.name as category_name,
                    product_stats.*
                FROM categories c
                CROSS JOIN LATERAL (
                    SELECT 
                        COUNT(*) as product_count,
                        AVG(price) as avg_price,
                        MAX(price) as max_price
                    FROM products p
                    WHERE p.category_id = c.id
                ) product_stats
                WHERE c.id = $1
            `,
            params: [1]
        });
    });
});
