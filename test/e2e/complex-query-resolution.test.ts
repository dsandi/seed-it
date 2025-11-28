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
            name: 'widgets_complex',
            setupData: async (source: Pool, target: Pool) => {
                // 1. Create Schema in BOTH source and target
                const createTables = async (pool: Pool) => {
                    await pool.query(`DROP TABLE IF EXISTS widget_tags CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS widgets CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS tags CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS groups CASCADE`);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS groups (
                            group_id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS tags (
                            tag_id SERIAL PRIMARY KEY,
                            name TEXT NOT NULL,
                            group_id_fk INTEGER REFERENCES groups(group_id)
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS widgets (
                            widget_id TEXT PRIMARY KEY,
                            group_id_fk INTEGER REFERENCES groups(group_id),
                            all_tags BOOLEAN DEFAULT FALSE
                        )
                    `);

                    await pool.query(`
                        CREATE TABLE IF NOT EXISTS widget_tags (
                            id SERIAL PRIMARY KEY,
                            widget_id_fk TEXT REFERENCES widgets(widget_id),
                            tag_id_fk INTEGER REFERENCES tags(tag_id)
                        )
                    `);
                };

                await createTables(source);
                await createTables(target);

                // 2. Insert Data (Source only)
                // Group
                await source.query(`INSERT INTO groups (group_id, name) VALUES (100, 'Main Group')`);

                // Tags (5 tags)
                await source.query(`INSERT INTO tags (tag_id, name, group_id_fk) VALUES (200, 'Tag A', 100)`);
                await source.query(`INSERT INTO tags (tag_id, name, group_id_fk) VALUES (201, 'Tag B', 100)`);
                await source.query(`INSERT INTO tags (tag_id, name, group_id_fk) VALUES (202, 'Tag C', 100)`);
                await source.query(`INSERT INTO tags (tag_id, name, group_id_fk) VALUES (203, 'Tag D', 100)`);
                await source.query(`INSERT INTO tags (tag_id, name, group_id_fk) VALUES (204, 'Tag E', 100)`);

                // Widgets
                // Widget A: Specific tags (All 5)
                await source.query(`
                    INSERT INTO widgets (widget_id, group_id_fk, all_tags) 
                    VALUES ('widget-1', 100, false)
                `);

                // Link Widget A to All 5 Tags
                await source.query(`INSERT INTO widget_tags (widget_id_fk, tag_id_fk) VALUES ('widget-1', 200)`);
                await source.query(`INSERT INTO widget_tags (widget_id_fk, tag_id_fk) VALUES ('widget-1', 201)`);
                await source.query(`INSERT INTO widget_tags (widget_id_fk, tag_id_fk) VALUES ('widget-1', 202)`);
                await source.query(`INSERT INTO widget_tags (widget_id_fk, tag_id_fk) VALUES ('widget-1', 203)`);
                await source.query(`INSERT INTO widget_tags (widget_id_fk, tag_id_fk) VALUES ('widget-1', 204)`);
            },
            query: `
                SELECT 
                    w.widget_id,
                    CASE
                        WHEN w.all_tags THEN (
                            SELECT array_agg(t.tag_id ORDER BY t.tag_id)
                            FROM tags t
                            WHERE t.group_id_fk = w.group_id_fk
                        )
                        ELSE array_agg(DISTINCT wt.tag_id_fk ORDER BY wt.tag_id_fk)
                    END AS tags
                FROM widgets w
                LEFT JOIN widget_tags wt ON wt.widget_id_fk = w.widget_id
                WHERE w.group_id_fk = $1
                  AND (w.all_tags = TRUE OR wt.tag_id_fk = ANY ($2))
                GROUP BY w.widget_id, w.all_tags, w.group_id_fk;
            `,
            params: [100, [200, 201, 202, 203, 204]],

            // Custom verification to check for specific INSERTS
            verifyExtractedRows: (rowsByTable: Map<string, any[]>) => {
                // Check if GROUPS are inserted (The missing dependency)
                const groups = rowsByTable.get('groups');
                expect(groups).toBeDefined();
                expect(groups?.length).toBeGreaterThan(0);
                expect(groups?.some(r => r.group_id === 100)).toBe(true);

                // Check if WIDGETS are inserted
                const widgets = rowsByTable.get('widgets');
                expect(widgets).toBeDefined();
                expect(widgets?.length).toBeGreaterThanOrEqual(1);
                expect(widgets?.some(r => r.widget_id === 'widget-1')).toBe(true);

                // Check if TAGS are inserted
                const tags = rowsByTable.get('tags');
                expect(tags).toBeDefined();
                expect(tags?.length).toBeGreaterThanOrEqual(5);
            }
        });

        // Additional verification on Target DB
        // We expect GROUPS to be present
        const groupsResult = await context.targetPool.query('SELECT * FROM groups WHERE group_id = 100');
        expect(groupsResult.rows.length).toBe(1);
        expect(groupsResult.rows[0].name).toBe('Main Group');

        // We expect Widget 1 to be present
        const widgetResult = await context.targetPool.query("SELECT * FROM widgets WHERE widget_id = 'widget-1'");
        expect(widgetResult.rows.length).toBe(1);

        // Verify the generated SQL file content matches the design expectations
        const outputDir = path.join(context.outputDir, 'seeders');
        const files = fs.readdirSync(outputDir);
        const seederFile = files.find((f: string) => f.endsWith('.sql'));
        expect(seederFile).toBeDefined();

        const sqlContent = fs.readFileSync(path.join(outputDir, seederFile!), 'utf-8');

        // Check for expected INSERT statements as defined in complex_query_design.md
        // We verify the EXACT generated SQL statements

        // 1. Groups
        const expectedGroupInsert = "INSERT INTO groups (group_id, name) VALUES (100, 'Main Group') ON CONFLICT (group_id) DO NOTHING;";
        expect(sqlContent).toContain(expectedGroupInsert);

        // 2. Widgets
        const expectedWidgetA = "INSERT INTO widgets (widget_id, group_id_fk, all_tags) VALUES ('widget-1', 100, FALSE) ON CONFLICT (widget_id) DO NOTHING;";
        expect(sqlContent).toContain(expectedWidgetA);

        // 3. Tags (Now expected to work with mapping)
        expect(sqlContent).toContain("INSERT INTO tags");
        expect(sqlContent).toContain("VALUES (200, 'Tag A', 100)");

        expect(sqlContent).toContain("VALUES (204, 'Tag E', 100)");

        // 4. Widget Tags
        expect(sqlContent).toContain("INSERT INTO widget_tags");
        expect(sqlContent).toContain("INSERT INTO widget_tags (tag_id_fk, widget_id_fk) VALUES (200, 'widget-1')");
        expect(sqlContent).toContain("INSERT INTO widget_tags (tag_id_fk, widget_id_fk) VALUES (204, 'widget-1')");
    });
});
