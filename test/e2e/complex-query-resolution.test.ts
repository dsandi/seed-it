import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { setupE2EContext, teardownE2EContext, runE2EScenario, E2ETestContext } from '../helpers/e2e-helper';
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

/**
 * E2E tests for Complex Query Resolution
 * Reproduces the issue where FK dependencies are missing from generated seeders
 * using a "Bird Sanctuary" themed schema.
 */
describe('Complex Query Resolution E2E', () => {
    let context: E2ETestContext;

    beforeAll(async () => {
        context = await setupE2EContext('complex-query-resolution');
    });

    afterAll(async () => {
        await teardownE2EContext(context);
    });

    it('should resolve deep FK dependencies (grandparents/great-grandparents) for Bird Sanctuary schema', async () => {
        await runE2EScenario(context, {
            name: 'bird_sanctuary_repro',
            setupData: async (source: Pool, target: Pool) => {
                // 1. Create Schema
                const createTables = async (pool: Pool) => {
                    await pool.query(`DROP TABLE IF EXISTS species_sightings CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS observation_posts CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS bird_species CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS sanctuaries CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS bird_watchers CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS habitats CASCADE`);
                    await pool.query(`DROP TABLE IF EXISTS bird_families CASCADE`);

                    // Bird Families (Great-Grandparent)
                    await pool.query(`
                        CREATE TABLE bird_families (
                            fam_pk SERIAL PRIMARY KEY,
                            family_name TEXT NOT NULL
                        )
                    `);

                    // Habitats (Great-Grandparent)
                    await pool.query(`
                        CREATE TABLE habitats (
                            hab_pk SERIAL PRIMARY KEY,
                            habitat_name TEXT NOT NULL
                        )
                    `);

                    // Bird Watchers (Grandparent)
                    await pool.query(`
                        CREATE TABLE bird_watchers (
                            wat_pk SERIAL PRIMARY KEY,
                            watcher_name VARCHAR(100) NOT NULL,
                            fam_pk_fk INTEGER REFERENCES bird_families(fam_pk)
                        )
                    `);

                    // Sanctuaries (Parent)
                    await pool.query(`
                        CREATE TABLE sanctuaries(
                            san_pk SERIAL PRIMARY KEY,
                            sanctuary_name VARCHAR(100) NOT NULL,
                            wat_pk_created_by INTEGER REFERENCES bird_watchers(wat_pk),
                            hab_pk_fk INTEGER REFERENCES habitats(hab_pk),
                            san_san_pk_parent INTEGER REFERENCES sanctuaries(san_pk)
                        )
                        `);

                    // Bird Species (Child)
                    await pool.query(`
                        CREATE TABLE bird_species(
                            spe_pk SERIAL PRIMARY KEY,
                            species_name VARCHAR(100) NOT NULL,
                            san_pk_fk INTEGER REFERENCES sanctuaries(san_pk),
                            wat_pk_created_by INTEGER REFERENCES bird_watchers(wat_pk),
                            fam_pk_fk INTEGER REFERENCES bird_families(fam_pk)
                        )
                        `);

                    // Observation Posts (Child)
                    await pool.query(`
                        CREATE TABLE observation_posts(
                            pos_pk SERIAL PRIMARY KEY,
                            post_code VARCHAR(50) NOT NULL,
                            san_pk_fk INTEGER REFERENCES sanctuaries(san_pk),
                            all_species BOOLEAN DEFAULT FALSE
                        )
                        `);

                    // Species Sightings (Grandchild / Join Table)
                    await pool.query(`
                        CREATE TABLE species_sightings(
                            pos_pk_fk INTEGER REFERENCES observation_posts(pos_pk),
                            spe_pk_fk INTEGER REFERENCES bird_species(spe_pk),
                            wat_pk_fk INTEGER REFERENCES bird_watchers(wat_pk),
                            sighting_date TIMESTAMP DEFAULT NOW(),
                            CONSTRAINT unq_species_post UNIQUE(spe_pk_fk, pos_pk_fk)
                        )
                    `);
                };

                await createTables(source);
                await createTables(target);

                // 2. Insert Data (Source only)
                // Bird Families
                await source.query(`INSERT INTO bird_families(fam_pk, family_name) VALUES(99, 'Raptors')`);

                // Habitats
                await source.query(`INSERT INTO habitats(hab_pk, habitat_name) VALUES(500, 'Wetlands')`);

                // Bird Watchers
                await source.query(`INSERT INTO bird_watchers(wat_pk, watcher_name, fam_pk_fk) VALUES(1, 'Ornithologist Prime', 99)`);

                // Sanctuaries
                await source.query(`INSERT INTO sanctuaries(san_pk, sanctuary_name, wat_pk_created_by, hab_pk_fk) VALUES(631201, 'Grand Aviary', 1, 500)`);

                // Bird Species
                await source.query(`INSERT INTO bird_species(spe_pk, species_name, san_pk_fk, wat_pk_created_by) VALUES(86482, 'Golden Eagle', 631201, 1)`);
                await source.query(`INSERT INTO bird_species(spe_pk, species_name, san_pk_fk, wat_pk_created_by) VALUES(86483, 'Bald Eagle', 631201, 1)`);
                await source.query(`INSERT INTO bird_species(spe_pk, species_name, san_pk_fk, wat_pk_created_by) VALUES(86484, 'Peregrine Falcon', 631201, 1)`);
                await source.query(`INSERT INTO bird_species(spe_pk, species_name, san_pk_fk, wat_pk_created_by) VALUES(86485, 'Osprey', 631201, 1)`);
                await source.query(`INSERT INTO bird_species(spe_pk, species_name, san_pk_fk, wat_pk_created_by) VALUES(101900, 'Red-tailed Hawk', 631201, 1)`);

                // Observation Posts
                await source.query(`INSERT INTO observation_posts(pos_pk, post_code, san_pk_fk, all_species) VALUES(1, 'post-alpha-2741208312314', 631201, false)`);
                await source.query(`INSERT INTO observation_posts(pos_pk, post_code, san_pk_fk, all_species) VALUES(2, 'post-all-access', 631201, true)`);

                // Species Sightings
                await source.query(`INSERT INTO species_sightings(spe_pk_fk, pos_pk_fk) VALUES(86482, 1)`);
                await source.query(`INSERT INTO species_sightings(spe_pk_fk, pos_pk_fk) VALUES(86483, 1)`);
                await source.query(`INSERT INTO species_sightings(spe_pk_fk, pos_pk_fk) VALUES(86484, 1)`);
                await source.query(`INSERT INTO species_sightings(spe_pk_fk, pos_pk_fk) VALUES(86485, 1)`);
                await source.query(`INSERT INTO species_sightings(spe_pk_fk, pos_pk_fk) VALUES(101900, 1)`);
            },
            query: `
                SELECT op.post_code,
                        CASE
                           WHEN op.all_species
                    THEN(SELECT array_agg(bs.spe_pk ORDER BY bs.spe_pk)
                                     FROM bird_species bs
                                     WHERE bs.san_pk_fk = op.san_pk_fk)
                           ELSE array_agg(DISTINCT ss.spe_pk_fk ORDER BY ss.spe_pk_fk)
                           END AS species_list
                FROM observation_posts op
                         LEFT JOIN species_sightings ss ON ss.pos_pk_fk = op.pos_pk
                WHERE op.san_pk_fk = $1
                    AND(op.all_species = TRUE OR ss.spe_pk_fk = ANY($2))
                GROUP BY op.post_code, op.all_species, op.san_pk_fk;
                    `,
            params: [631201, [86482]],

            // Custom verification
            verifyExtractedRows: (rowsByTable: Map<string, any[]>) => {
                // Assert that all parent and grandparent tables are present in the extraction
                expect(rowsByTable.has('bird_families')).toBe(true);
                expect(rowsByTable.has('habitats')).toBe(true);
                expect(rowsByTable.has('bird_watchers')).toBe(true);
                expect(rowsByTable.has('sanctuaries')).toBe(true);

                // Assert specific row counts if needed
                expect(rowsByTable.get('bird_families')?.length).toBeGreaterThan(0);
                expect(rowsByTable.get('habitats')?.length).toBeGreaterThan(0);
                expect(rowsByTable.get('bird_watchers')?.length).toBeGreaterThan(0);
                expect(rowsByTable.get('sanctuaries')?.length).toBeGreaterThan(0);
            }
        });

        // Verify generated SQL content
        const outputDir = path.join(context.outputDir, 'seeders');
        const files = fs.readdirSync(outputDir);
        const seederFile = files.find((f: string) => f.endsWith('.sql'));
        expect(seederFile).toBeDefined();

        const sqlContent = fs.readFileSync(path.join(outputDir, seederFile!), 'utf-8');

        // Check for presence of INSERT statements for all tables
        expect(sqlContent).toContain("INSERT INTO bird_families");
        expect(sqlContent).toContain("INSERT INTO habitats");
        expect(sqlContent).toContain("INSERT INTO bird_watchers");
        expect(sqlContent).toContain("INSERT INTO sanctuaries");
        expect(sqlContent).toContain("INSERT INTO bird_species");
        expect(sqlContent).toContain("INSERT INTO observation_posts");
    });
});
