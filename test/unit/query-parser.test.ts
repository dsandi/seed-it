
import { QueryParser } from '../../src/parser/query-parser';

describe('QueryParser', () => {
    let parser: QueryParser;

    beforeEach(() => {
        parser = new QueryParser();
    });

    it('should identify tables in a simple SELECT query', () => {
        const query = 'SELECT * FROM users';
        const result = parser.parse(query);
        expect(result).not.toBeNull();
        expect(result?.referencedTables).toContain('users');
    });

    it('should identify tables in a JOIN query', () => {
        const query = 'SELECT * FROM orders o JOIN users u ON o.user_id = u.id';
        const result = parser.parse(query);
        expect(result).not.toBeNull();
        expect(result?.referencedTables).toContain('orders');
        expect(result?.referencedTables).toContain('users');
    });

    it('should identify tables in a CTE (WITH clause)', () => {
        const query = `
            WITH order_details AS (
                SELECT 
                    o.id, u.username
                FROM orders o
                JOIN users u ON o.user_id = u.id
            )
            SELECT * FROM order_details
        `;
        const result = parser.parse(query);
        expect(result).not.toBeNull();
        expect(result?.referencedTables).toContain('orders');
        expect(result?.referencedTables).toContain('users');
        // It might also contain 'order_details' depending on implementation, but we care about source tables
    });

    it('should identify tables in complex CTEs with multiple joins', () => {
        const query = `
            WITH order_details AS (
                SELECT 
                    o.id as order_id,
                    o.order_number,
                    u.username,
                    p.name as product_name,
                    oi.quantity
                FROM orders o
                JOIN users u ON o.user_id = u.id
                JOIN order_items oi ON o.id = oi.order_id
                JOIN products p ON oi.product_id = p.id
                WHERE o.id = $1
            )
            SELECT * FROM order_details
        `;
        const result = parser.parse(query);
        expect(result).not.toBeNull();
        expect(result?.referencedTables).toContain('orders');
        expect(result?.referencedTables).toContain('users');
        expect(result?.referencedTables).toContain('order_items');
        expect(result?.referencedTables).toContain('products');
    });

    it('should parse WITH RECURSIVE CTE', () => {
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

        const result = parser.parse(query);
        expect(result).toBeDefined();
        expect(result!.referencedTables).toContain('categories');
    });
});
