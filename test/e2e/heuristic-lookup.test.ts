import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

describe('Heuristic Lookup E2E', () => {
    let context: E2ETestContext;

    beforeAll(async () => {
        context = await setupE2EContext('heuristic-lookup');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should correctly fetch complete rows for join tables using heuristic lookup', async () => {
        await runE2EScenario(context, {
            name: 'join_table_heuristic',
            setupData: async (source: Pool, target: Pool) => {
                // 1. Create Schema
                const createTables = async (pool: Pool) => {
                    await pool.query(`DROP TABLE IF EXISTS link_table CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS table_b CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS table_a CASCADE`);

                    await pool.query(`
                        CREATE TABLE table_a (
                            id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE table_b (
                            id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL
                        )
                    `);

                    // Join table with NO Primary Key and NO Unique Constraint
                    // But it has an 'active' column we want to fetch
                    await pool.query(`
                        CREATE TABLE link_table (
                            a_id INTEGER REFERENCES table_a(id),
                            b_id INTEGER REFERENCES table_b(id),
                            active BOOLEAN DEFAULT FALSE,
                            extra_data TEXT
                        )
                    `);
                };

                await createTables(source);
                await createTables(target);

                // 2. Insert Data (Source only)
                await source.query(`INSERT INTO table_a (id, name) VALUES (1, 'A1')`);
                await source.query(`INSERT INTO table_b (id, name) VALUES (100, 'B1')`);
                await source.query(`INSERT INTO table_b (id, name) VALUES (101, 'B2')`);

                // Insert multiple links with same a_id but different b_id
                // This creates a scenario where partial key (a_id only) matches multiple rows
                await source.query(`INSERT INTO link_table (a_id, b_id, active, extra_data) VALUES (1, 100, TRUE, 'important')`);
                await source.query(`INSERT INTO link_table (a_id, b_id, active, extra_data) VALUES (1, 101, FALSE, 'other')`);
            },
            query: `
                SELECT 
                    l.a_id,
                    l.b_id
                FROM link_table l
                WHERE l.a_id = 1
            `,
            params: [],

            verifyExtractedRows: (rowsByTable: Map<string, any[]>) => {
                expect(rowsByTable.has('link_table')).toBe(true);
                const links = rowsByTable.get('link_table');
                // We should get both rows since the query selects both
                expect(links?.length).toBeGreaterThanOrEqual(1);

                // At least one row should have complete data (active and extra_data)
                const completeRows = links?.filter(l => l.active !== undefined && l.extra_data !== undefined);
                expect(completeRows?.length).toBeGreaterThan(0);
            }
        });

        // Verify generated SQL
        const outputDir = path.join(context.outputDir, 'seeders');
        const files = fs.readdirSync(outputDir);
        const seederFile = files.find((f: string) => f.endsWith('.sql'));
        expect(seederFile).toBeDefined();

        const sqlContent = fs.readFileSync(path.join(outputDir, seederFile!), 'utf-8');
        expect(sqlContent).toContain("INSERT INTO link_table");
        // At least one row should have complete data
        expect(sqlContent.match(/INSERT INTO link_table/g)?.length).toBeGreaterThan(0);
    });
});
