import { newDb, IMemoryDb } from 'pg-mem';
import { Pool } from 'pg';

export interface TestDbSetup {
    db: IMemoryDb;
    pool: Pool;
}

export async function createTestDb(schema: string): Promise<TestDbSetup> {
    const db = newDb();

    // Execute schema
    db.public.none(schema);

    // Get a pg-compatible pool
    const { Pool: PgMemPool } = db.adapters.createPg();
    const pool = new PgMemPool() as unknown as Pool;

    return { db, pool };
}

export function createTestSchema(): string {
    return `
        CREATE TABLE table_a (
            id SERIAL PRIMARY KEY,
            code TEXT NOT NULL,
            parent_id INTEGER,
            flag_all BOOLEAN DEFAULT FALSE
        );
        
        CREATE TABLE table_b (
            ref_id INTEGER PRIMARY KEY,
            parent_id INTEGER
        );
        
        CREATE TABLE table_a_b (
            table_a_id INTEGER REFERENCES table_a(id),
            ref_id INTEGER,
            PRIMARY KEY (table_a_id, ref_id)
        );
    `;
}

/**
 * Comprehensive e-commerce schema with ~20 tables for realistic testing
 */
export function createComprehensiveSchema(): string {
    return `
        -- Users and Authentication
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            username TEXT NOT NULL UNIQUE,
            full_name TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            is_active BOOLEAN DEFAULT TRUE,
            metadata JSONB DEFAULT '{}'
        );

        CREATE TABLE user_profiles (
            user_id INTEGER PRIMARY KEY REFERENCES users(id),
            bio TEXT,
            avatar_url TEXT,
            phone TEXT,
            address_line1 TEXT,
            address_line2 TEXT,
            city TEXT,
            state TEXT,
            zip_code TEXT,
            country TEXT DEFAULT 'US'
        );

        -- Self-referencing: user followers
        CREATE TABLE user_followers (
            follower_id INTEGER REFERENCES users(id),
            following_id INTEGER REFERENCES users(id),
            followed_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (follower_id, following_id)
        );

        -- Categories with hierarchy (self-referencing)
        CREATE TABLE categories (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            parent_id INTEGER REFERENCES categories(id),
            description TEXT,
            display_order INTEGER DEFAULT 0
        );

        -- Products
        CREATE TABLE products (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            description TEXT,
            price NUMERIC NOT NULL,
            cost NUMERIC,
            sku TEXT UNIQUE,
            stock_quantity INTEGER DEFAULT 0,
            category_id INTEGER REFERENCES categories(id),
            created_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW(),
            is_active BOOLEAN DEFAULT TRUE,
            tags TEXT[] DEFAULT '{}',
            attributes JSONB DEFAULT '{}'
        );

        -- Product images
        CREATE TABLE product_images (
            id SERIAL PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            url TEXT NOT NULL,
            alt_text TEXT,
            display_order INTEGER DEFAULT 0,
            is_primary BOOLEAN DEFAULT FALSE
        );

        -- Product variants (e.g., size, color)
        CREATE TABLE product_variants (
            id SERIAL PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            sku TEXT UNIQUE,
            name TEXT NOT NULL,
            price_adjustment NUMERIC DEFAULT 0,
            stock_quantity INTEGER DEFAULT 0,
            attributes JSONB DEFAULT '{}'
        );

        -- Orders
        CREATE TABLE orders (
            id SERIAL PRIMARY KEY,
            order_number TEXT NOT NULL UNIQUE,
            user_id INTEGER NOT NULL REFERENCES users(id),
            status TEXT NOT NULL DEFAULT 'pending',
            subtotal NUMERIC NOT NULL,
            tax NUMERIC DEFAULT 0,
            shipping NUMERIC DEFAULT 0,
            total NUMERIC NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            notes TEXT,
            metadata JSONB DEFAULT '{}'
        );

        -- Order items
        CREATE TABLE order_items (
            id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES orders(id),
            product_id INTEGER REFERENCES products(id),
            product_variant_id INTEGER REFERENCES product_variants(id),
            quantity INTEGER NOT NULL,
            unit_price NUMERIC NOT NULL,
            total_price NUMERIC NOT NULL,
            product_snapshot JSONB
        );

        -- Shipments (circular dependency with orders)
        CREATE TABLE shipments (
            id SERIAL PRIMARY KEY,
            order_id INTEGER NOT NULL REFERENCES orders(id),
            tracking_number TEXT,
            carrier TEXT,
            status TEXT DEFAULT 'pending',
            shipped_at TIMESTAMP,
            delivered_at TIMESTAMP,
            address_line1 TEXT NOT NULL,
            address_line2 TEXT,
            city TEXT NOT NULL,
            state TEXT NOT NULL,
            zip_code TEXT NOT NULL,
            country TEXT DEFAULT 'US'
        );

        -- Add shipment_id to orders (circular dependency)
        ALTER TABLE orders ADD COLUMN shipment_id INTEGER REFERENCES shipments(id);

        -- Reviews
        CREATE TABLE reviews (
            id SERIAL PRIMARY KEY,
            product_id INTEGER NOT NULL REFERENCES products(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            order_id INTEGER REFERENCES orders(id),
            rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
            title TEXT,
            comment TEXT,
            is_verified_purchase BOOLEAN DEFAULT FALSE,
            helpful_count INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );

        -- Review votes
        CREATE TABLE review_votes (
            review_id INTEGER REFERENCES reviews(id),
            user_id INTEGER REFERENCES users(id),
            is_helpful BOOLEAN NOT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (review_id, user_id)
        );

        -- Wishlists
        CREATE TABLE wishlists (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            is_public BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE wishlist_items (
            wishlist_id INTEGER REFERENCES wishlists(id),
            product_id INTEGER REFERENCES products(id),
            added_at TIMESTAMP DEFAULT NOW(),
            notes TEXT,
            PRIMARY KEY (wishlist_id, product_id)
        );

        -- Carts
        CREATE TABLE carts (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id),
            session_id TEXT,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id),
            UNIQUE(session_id)
        );

        CREATE TABLE cart_items (
            id SERIAL PRIMARY KEY,
            cart_id INTEGER NOT NULL REFERENCES carts(id),
            product_id INTEGER REFERENCES products(id),
            product_variant_id INTEGER REFERENCES product_variants(id),
            quantity INTEGER NOT NULL DEFAULT 1,
            added_at TIMESTAMP DEFAULT NOW()
        );

        -- Coupons
        CREATE TABLE coupons (
            id SERIAL PRIMARY KEY,
            code TEXT NOT NULL UNIQUE,
            discount_type TEXT NOT NULL,
            discount_value NUMERIC NOT NULL,
            min_purchase NUMERIC,
            max_discount NUMERIC,
            valid_from TIMESTAMP,
            valid_until TIMESTAMP,
            usage_limit INTEGER,
            usage_count INTEGER DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE
        );

        -- Order coupons (many-to-many)
        CREATE TABLE order_coupons (
            order_id INTEGER REFERENCES orders(id),
            coupon_id INTEGER REFERENCES coupons(id),
            discount_amount NUMERIC NOT NULL,
            PRIMARY KEY (order_id, coupon_id)
        );

        -- Inventory logs
        CREATE TABLE inventory_logs (
            id SERIAL PRIMARY KEY,
            product_id INTEGER REFERENCES products(id),
            product_variant_id INTEGER REFERENCES product_variants(id),
            change_quantity INTEGER NOT NULL,
            reason TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW()
        );
    `;
}

/**
 * Seed comprehensive test data
 */
export async function seedComprehensiveData(pool: Pool): Promise<void> {
    // Users
    await pool.query(`
        INSERT INTO users (id, email, username, full_name, metadata) VALUES
        (1, 'alice@example.com', 'alice', 'Alice Johnson', '{"role": "admin"}'),
        (2, 'bob@example.com', 'bob', 'Bob Smith', '{"role": "customer"}'),
        (3, 'charlie@example.com', 'charlie', 'Charlie Brown', '{"role": "customer"}'),
        (4, 'diana@example.com', 'diana', 'Diana Prince', '{"role": "vendor"}'),
        (5, 'eve@example.com', 'eve', 'Eve Wilson', '{"role": "customer"}')
    `);

    // User profiles
    await pool.query(`
        INSERT INTO user_profiles (user_id, bio, city, state, country) VALUES
        (1, 'Platform administrator', 'San Francisco', 'CA', 'US'),
        (2, 'Tech enthusiast', 'New York', 'NY', 'US'),
        (3, 'Book lover', 'Austin', 'TX', 'US'),
        (4, 'Product vendor', 'Seattle', 'WA', 'US'),
        (5, 'Fashion blogger', 'Los Angeles', 'CA', 'US')
    `);

    // User followers (self-referencing)
    await pool.query(`
        INSERT INTO user_followers (follower_id, following_id) VALUES
        (2, 1), (3, 1), (4, 1),
        (1, 4), (2, 4), (5, 4),
        (3, 5), (2, 5)
    `);

    // Categories (self-referencing hierarchy)
    await pool.query(`
        INSERT INTO categories (id, name, slug, parent_id, display_order) VALUES
        (1, 'Electronics', 'electronics', NULL, 1),
        (2, 'Computers', 'computers', 1, 1),
        (3, 'Laptops', 'laptops', 2, 1),
        (4, 'Desktops', 'desktops', 2, 2),
        (5, 'Phones', 'phones', 1, 2),
        (6, 'Smartphones', 'smartphones', 5, 1),
        (7, 'Clothing', 'clothing', NULL, 2),
        (8, 'Men', 'men', 7, 1),
        (9, 'Women', 'women', 7, 2),
        (10, 'Books', 'books', NULL, 3)
    `);

    // Products
    await pool.query(`
        INSERT INTO products (id, name, slug, price, cost, sku, stock_quantity, category_id, created_by, tags, attributes) VALUES
        (1, 'MacBook Pro 16"', 'macbook-pro-16', 2499.00, 1800.00, 'MBP-16-001', 10, 3, 4, ARRAY['apple', 'laptop', 'premium'], '{"color": "Space Gray", "ram": "16GB"}'),
        (2, 'Dell XPS 13', 'dell-xps-13', 1299.00, 900.00, 'DELL-XPS-001', 15, 3, 4, ARRAY['dell', 'laptop'], '{"color": "Silver", "ram": "8GB"}'),
        (3, 'iPhone 14 Pro', 'iphone-14-pro', 999.00, 700.00, 'IPH-14P-001', 25, 6, 4, ARRAY['apple', 'phone'], '{"color": "Deep Purple", "storage": "256GB"}'),
        (4, 'Samsung Galaxy S23', 'samsung-galaxy-s23', 799.00, 550.00, 'SAM-S23-001', 30, 6, 4, ARRAY['samsung', 'phone'], '{"color": "Phantom Black", "storage": "128GB"}'),
        (5, 'Wireless Mouse', 'wireless-mouse', 29.99, 15.00, 'MOUSE-001', 100, 2, 4, ARRAY['accessory', 'mouse'], '{"connectivity": "Bluetooth"}'),
        (6, 'USB-C Cable', 'usb-c-cable', 19.99, 5.00, 'CABLE-001', 200, 2, 4, ARRAY['accessory', 'cable'], '{"length": "2m"}'),
        (7, 'Men T-Shirt', 'men-tshirt', 24.99, 10.00, 'TSHIRT-M-001', 50, 8, 4, ARRAY['clothing', 'casual'], '{"material": "Cotton"}'),
        (8, 'Women Dress', 'women-dress', 79.99, 35.00, 'DRESS-W-001', 20, 9, 4, ARRAY['clothing', 'formal'], '{"material": "Silk"}'),
        (9, 'The Great Gatsby', 'great-gatsby', 14.99, 8.00, 'BOOK-001', 40, 10, 4, ARRAY['fiction', 'classic'], '{"author": "F. Scott Fitzgerald", "pages": 180}'),
        (10, '1984', '1984-book', 13.99, 7.00, 'BOOK-002', 35, 10, 4, ARRAY['fiction', 'dystopian'], '{"author": "George Orwell", "pages": 328}')
    `);

    // Product images
    await pool.query(`
        INSERT INTO product_images (product_id, url, alt_text, display_order, is_primary) VALUES
        (1, '/images/mbp-1.jpg', 'MacBook Pro front view', 0, TRUE),
        (1, '/images/mbp-2.jpg', 'MacBook Pro side view', 1, FALSE),
        (2, '/images/xps-1.jpg', 'Dell XPS 13 front view', 0, TRUE),
        (3, '/images/iphone-1.jpg', 'iPhone 14 Pro', 0, TRUE),
        (4, '/images/galaxy-1.jpg', 'Samsung Galaxy S23', 0, TRUE)
    `);

    // Product variants
    await pool.query(`
        INSERT INTO product_variants (product_id, sku, name, price_adjustment, stock_quantity, attributes) VALUES
        (1, 'MBP-16-SG-16', 'Space Gray, 16GB RAM', 0, 5, '{"color": "Space Gray", "ram": "16GB"}'),
        (1, 'MBP-16-SG-32', 'Space Gray, 32GB RAM', 400, 3, '{"color": "Space Gray", "ram": "32GB"}'),
        (3, 'IPH-14P-DP-128', 'Deep Purple, 128GB', -100, 10, '{"color": "Deep Purple", "storage": "128GB"}'),
        (3, 'IPH-14P-DP-256', 'Deep Purple, 256GB', 0, 15, '{"color": "Deep Purple", "storage": "256GB"}'),
        (7, 'TSHIRT-M-S', 'Size S', 0, 20, '{"size": "S"}'),
        (7, 'TSHIRT-M-M', 'Size M', 0, 20, '{"size": "M"}'),
        (7, 'TSHIRT-M-L', 'Size L', 0, 10, '{"size": "L"}')
    `);

    // Orders
    await pool.query(`
        INSERT INTO orders (id, order_number, user_id, status, subtotal, tax, shipping, total, metadata) VALUES
        (1, 'ORD-2024-001', 2, 'completed', 2499.00, 199.92, 0, 2698.92, '{"payment_method": "credit_card"}'),
        (2, 'ORD-2024-002', 3, 'completed', 1328.99, 106.32, 15.00, 1450.31, '{"payment_method": "paypal"}'),
        (3, 'ORD-2024-003', 5, 'pending', 79.99, 6.40, 10.00, 96.39, '{"payment_method": "credit_card"}'),
        (4, 'ORD-2024-004', 2, 'shipped', 999.00, 79.92, 0, 1078.92, '{"payment_method": "credit_card"}')
    `);

    // Order items
    await pool.query(`
        INSERT INTO order_items (order_id, product_id, product_variant_id, quantity, unit_price, total_price, product_snapshot) VALUES
        (1, 1, 1, 1, 2499.00, 2499.00, '{"name": "MacBook Pro 16", "sku": "MBP-16-SG-16"}'),
        (2, 2, NULL, 1, 1299.00, 1299.00, '{"name": "Dell XPS 13", "sku": "DELL-XPS-001"}'),
        (2, 5, NULL, 1, 29.99, 29.99, '{"name": "Wireless Mouse", "sku": "MOUSE-001"}'),
        (3, 8, NULL, 1, 79.99, 79.99, '{"name": "Women Dress", "sku": "DRESS-W-001"}'),
        (4, 3, 4, 1, 999.00, 999.00, '{"name": "iPhone 14 Pro", "sku": "IPH-14P-DP-256"}')
    `);

    // Shipments
    await pool.query(`
        INSERT INTO shipments (id, order_id, tracking_number, carrier, status, address_line1, city, state, zip_code) VALUES
        (1, 1, 'TRK-001', 'UPS', 'delivered', '123 Main St', 'New York', 'NY', '10001'),
        (2, 2, 'TRK-002', 'FedEx', 'delivered', '456 Oak Ave', 'Austin', 'TX', '78701'),
        (3, 4, 'TRK-003', 'USPS', 'in_transit', '789 Pine Rd', 'Los Angeles', 'CA', '90001')
    `);

    // Update orders with shipment_id (circular dependency)
    await pool.query(`
        UPDATE orders SET shipment_id = 1 WHERE id = 1;
        UPDATE orders SET shipment_id = 2 WHERE id = 2;
        UPDATE orders SET shipment_id = 3 WHERE id = 4;
    `);

    // Reviews
    await pool.query(`
        INSERT INTO reviews (product_id, user_id, order_id, rating, title, comment, is_verified_purchase, helpful_count) VALUES
        (1, 2, 1, 5, 'Amazing laptop!', 'Best laptop I have ever owned. Fast and reliable.', TRUE, 5),
        (2, 3, 2, 4, 'Great value', 'Good laptop for the price, but battery could be better.', TRUE, 3),
        (3, 2, 4, 5, 'Love it!', 'Camera is incredible, battery lasts all day.', TRUE, 8),
        (5, 3, 2, 4, 'Good mouse', 'Works well, but a bit small for my hand.', TRUE, 1)
    `);

    // Review votes
    await pool.query(`
        INSERT INTO review_votes (review_id, user_id, is_helpful) VALUES
        (1, 3, TRUE), (1, 5, TRUE),
        (2, 2, TRUE), (2, 5, FALSE),
        (3, 3, TRUE), (3, 5, TRUE)
    `);

    // Wishlists
    await pool.query(`
        INSERT INTO wishlists (id, user_id, name, is_public) VALUES
        (1, 2, 'Tech Wishlist', TRUE),
        (2, 3, 'Books to Read', FALSE),
        (3, 5, 'Fashion Favorites', TRUE)
    `);

    // Wishlist items
    await pool.query(`
        INSERT INTO wishlist_items (wishlist_id, product_id, notes) VALUES
        (1, 3, 'Want to upgrade from iPhone 12'),
        (1, 4, 'Alternative to iPhone'),
        (2, 9, 'Classic must-read'),
        (2, 10, 'Dystopian fiction'),
        (3, 8, 'For summer events')
    `);

    // Carts
    await pool.query(`
        INSERT INTO carts (id, user_id) VALUES
        (1, 2),
        (2, 5)
    `);

    // Cart items
    await pool.query(`
        INSERT INTO cart_items (cart_id, product_id, product_variant_id, quantity) VALUES
        (1, 4, NULL, 1),
        (1, 6, NULL, 2),
        (2, 7, 6, 1)
    `);

    // Coupons
    await pool.query(`
        INSERT INTO coupons (id, code, discount_type, discount_value, min_purchase, usage_limit, usage_count, is_active) VALUES
        (1, 'WELCOME10', 'percentage', 10.00, 50.00, 100, 2, TRUE),
        (2, 'SUMMER50', 'fixed', 50.00, 200.00, 50, 1, TRUE),
        (3, 'FREESHIP', 'shipping', 0.00, 0.00, NULL, 0, TRUE)
    `);

    // Order coupons
    await pool.query(`
        INSERT INTO order_coupons (order_id, coupon_id, discount_amount) VALUES
        (1, 1, 249.90),
        (2, 2, 50.00)
    `);

    // Inventory logs
    await pool.query(`
        INSERT INTO inventory_logs (product_id, product_variant_id, change_quantity, reason, created_by) VALUES
        (1, 1, -1, 'Sold in order ORD-2024-001', 1),
        (2, NULL, -1, 'Sold in order ORD-2024-002', 1),
        (5, NULL, -1, 'Sold in order ORD-2024-002', 1),
        (3, 4, -1, 'Sold in order ORD-2024-004', 1),
        (1, NULL, 5, 'Restocked', 1)
    `);
}

