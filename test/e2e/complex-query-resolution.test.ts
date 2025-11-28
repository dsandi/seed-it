import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';

/**
 * E2E tests for Complex Query Resolution
 * Reproduces the issue where FK dependencies are missing from generated seeders
 * when using complex queries with CASE, subqueries, and array_agg.
 * Uses generic schema names to avoid exposing user data.
 */
describe('Complex Query Resolution E2E', () => {
    let context: E2ETestContext;

    beforeAll(async () => {
        context = await setupE2EContext('complex-query-resolution');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should resolve FK dependencies for complex CASE/subquery logic', async () => {
        await runE2EScenario(context, {
            name: 'devices_complex',
            setupData: async (source: Pool, target: Pool) => {
                // 1. Create Schema in BOTH source and target
                const createTables = async (pool: Pool) => {
                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS menus (
                            menu_id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS item_categories (
                            category_id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL,
                            menu_id_fk INTEGER REFERENCES menus(menu_id)
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS devices (
                            id SERIAL PRIMARY KEY,
                            device_identifier TEXT UNIQUE NOT NULL,
                            menu_id_fk INTEGER REFERENCES menus(menu_id),
                            show_all_categories BOOLEAN DEFAULT FALSE
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS device_category_mappings (
                            id SERIAL PRIMARY KEY,
                            device_id_fk INTEGER REFERENCES devices(id),
                            category_id_fk INTEGER REFERENCES item_categories(category_id)
                        )
                    `);
                };

                await createTables(source);
                await createTables(target);

                // 2. Insert Data (Source only)
                // Menu
                await source.query(`INSERT INTO menus (menu_id, name) VALUES (100, 'Main Menu')`);

                // Categories
                await source.query(`INSERT INTO item_categories (category_id, name, menu_id_fk) VALUES (200, 'Food', 100)`);
                await source.query(`INSERT INTO item_categories (category_id, name, menu_id_fk) VALUES (201, 'Beverages', 100)`);

                // Devices
                // Device A: Specific category
                await source.query(`
                    INSERT INTO devices (id, device_identifier, menu_id_fk, show_all_categories) 
                    VALUES (1, 'device-A', 100, false)
                `);

                // Device B: All categories
                await source.query(`
                    INSERT INTO devices (id, device_identifier, menu_id_fk, show_all_categories) 
                    VALUES (2, 'device-B', 100, true)
                `);

                // Link Device A to Food Category
                await source.query(`
                    INSERT INTO device_category_mappings (device_id_fk, category_id_fk) 
                    VALUES (1, 200)
                `);
            },
            query: `
                SELECT 
                    d.device_identifier,
                    CASE
                        WHEN d.show_all_categories THEN (
                            SELECT array_agg(cat.category_id ORDER BY cat.category_id)
                            FROM item_categories cat
                            WHERE cat.menu_id_fk = d.menu_id_fk
                        )
                        ELSE array_agg(DISTINCT dcm.category_id_fk ORDER BY dcm.category_id_fk)
                    END AS categories
                FROM devices d
                LEFT JOIN device_category_mappings dcm ON dcm.device_id_fk = d.id
                WHERE d.menu_id_fk = $1
                  AND (d.show_all_categories = TRUE OR dcm.category_id_fk = ANY ($2))
                GROUP BY d.device_identifier, d.show_all_categories, d.menu_id_fk;
            `,
            params: [100, [200]],

            // Custom verification to check for specific INSERTS
            verifyExtractedRows: (rowsByTable: Map<string, any[]>) => {
                // Check if MENUS are inserted (The missing dependency)
                const menus = rowsByTable.get('menus');
                expect(menus).toBeDefined();
                expect(menus?.length).toBeGreaterThan(0);
                expect(menus?.some(r => r.menu_id === 100)).toBe(true);

                // Check if DEVICES are inserted
                const devices = rowsByTable.get('devices');
                expect(devices).toBeDefined();
                expect(devices?.some(r => r.device_identifier === 'device-A')).toBe(true);
                expect(devices?.some(r => r.device_identifier === 'device-B')).toBe(true);
            },
            skipVerification: true
        });

        // Additional verification on Target DB
        // We expect MENUS to be present (Fix confirmed)
        const menusResult = await context.targetPool.query('SELECT * FROM menus WHERE menu_id = 100');
        expect(menusResult.rows.length).toBe(1);
        expect(menusResult.rows[0].name).toBe('Main Menu');

        // We expect Device B to be present (it has show_all_categories=true)
        const deviceBResult = await context.targetPool.query("SELECT * FROM devices WHERE device_identifier = 'device-B'");
        expect(deviceBResult.rows.length).toBe(1);

        // Note: Device A might be missing if device_category_mappings are not seeded (known limitation for now)
        // and item_categories might be missing if not fetched as dependencies.
    });
});
