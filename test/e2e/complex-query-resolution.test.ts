import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

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
            name: 'vehicles_complex',
            setupData: async (source: Pool, target: Pool) => {
                // 1. Create Schema in BOTH source and target
                const createTables = async (pool: Pool) => {
                    await pool.query(`DROP TABLE IF EXISTS vehicle_routes CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS vehicles CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS routes CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS fleets CASCADE`);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS fleets (
                            id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS routes (
                            id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL,
                            fleet_id INTEGER NOT NULL REFERENCES fleets(id)
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS vehicles (
                            id SERIAL PRIMARY KEY,
                            vehicle_token TEXT NOT NULL,
                            vehicle_uuid TEXT NOT NULL,
                            fleet_id INTEGER NOT NULL REFERENCES fleets(id),
                            show_all_routes BOOLEAN DEFAULT FALSE,
                            CONSTRAINT unq_vehicles_composite UNIQUE (fleet_id, vehicle_uuid, vehicle_token)
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS vehicle_routes (
                            route_id INTEGER NOT NULL REFERENCES routes(id),
                            vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
                            active BOOLEAN DEFAULT TRUE,
                            PRIMARY KEY (route_id, vehicle_id)
                        )
                    `);
                };

                await createTables(source);
                await createTables(target);

                // 2. Insert Data (Source only)
                // Fleet
                await source.query(`INSERT INTO fleets (id, name) VALUES (631201, 'Main Fleet')`);

                // Routes
                await source.query(`INSERT INTO routes (id, name, fleet_id) VALUES (86482, 'Route A', 631201)`);
                await source.query(`INSERT INTO routes (id, name, fleet_id) VALUES (86483, 'Route B', 631201)`);
                await source.query(`INSERT INTO routes (id, name, fleet_id) VALUES (86484, 'Route C', 631201)`);
                await source.query(`INSERT INTO routes (id, name, fleet_id) VALUES (86485, 'Route D', 631201)`);
                await source.query(`INSERT INTO routes (id, name, fleet_id) VALUES (101900, 'Route E', 631201)`);

                // Vehicles
                // Vehicle 1: Specific route (86482)
                await source.query(`
                    INSERT INTO vehicles (id, vehicle_token, vehicle_uuid, fleet_id, show_all_routes) 
                    VALUES (1, 'token-1', 'uuid-1', 631201, false)
                `);

                // Vehicle 2: All routes
                await source.query(`
                    INSERT INTO vehicles (id, vehicle_token, vehicle_uuid, fleet_id, show_all_routes) 
                    VALUES (2, 'token-all', 'uuid-2', 631201, true)
                `);

                // Link Vehicle 1 to Route 86482
                await source.query(`INSERT INTO vehicle_routes (route_id, vehicle_id) VALUES (86482, 1)`);
            },
            query: `
                SELECT 
                    v.vehicle_token,
                    CASE
                        WHEN v.show_all_routes THEN (
                            SELECT array_agg(r.id ORDER BY r.id)
                            FROM routes r
                            WHERE r.fleet_id = v.fleet_id
                        )
                        ELSE array_agg(DISTINCT vr.route_id ORDER BY vr.route_id)
                    END AS routes
                FROM vehicles v
                LEFT JOIN vehicle_routes vr ON vr.vehicle_id = v.id
                WHERE v.fleet_id = $1
                  AND (v.show_all_routes = TRUE OR vr.route_id = ANY ($2))
                GROUP BY v.vehicle_token, v.show_all_routes, v.fleet_id;
            `,
            params: [631201, [86482]],

            // Custom verification
            verifyExtractedRows: (rowsByTable: Map<string, any[]>) => {
                // We expect this to FAIL initially or produce incomplete data
                const fleets = rowsByTable.get('fleets');
            }
        });

        // Additional verification on Target DB
        const fleetResult = await context.targetPool.query('SELECT * FROM fleets WHERE id = 631201');
        expect(fleetResult.rows.length).toBe(1);

        const vehicleResult = await context.targetPool.query("SELECT * FROM vehicles WHERE vehicle_token = 'token-1'");
        expect(vehicleResult.rows.length).toBe(1);

        // Verify generated SQL
        const outputDir = path.join(context.outputDir, 'seeders');
        const files = fs.readdirSync(outputDir);
        const seederFile = files.find((f: string) => f.endsWith('.sql'));
        expect(seederFile).toBeDefined();

        const sqlContent = fs.readFileSync(path.join(outputDir, seederFile!), 'utf-8');

        // 1. Fleets
        expect(sqlContent).toContain("INSERT INTO fleets");
        expect(sqlContent).toContain("VALUES (631201, 'Main Fleet')");

        // 2. Routes
        expect(sqlContent).toContain("INSERT INTO routes");
        expect(sqlContent).toContain("VALUES (86482, 'Route A', 631201)");

        // 3. Vehicles
        expect(sqlContent).toContain("INSERT INTO vehicles");
        expect(sqlContent).toContain("token-1");

        // 4. Mappings
        expect(sqlContent).toContain("INSERT INTO vehicle_routes");
        expect(sqlContent).toContain("VALUES (86482, 1, TRUE)");
    });
});
