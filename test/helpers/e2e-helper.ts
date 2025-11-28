import { Pool } from 'pg';
import { startCapturePool } from '../../src/index';
import { SeederGenerator } from '../../src/generator/seeder-generator';
import { SchemaAnalyzer } from '../../src/analyzer/schema-analyzer';
import { TableSchema } from '../../src/types';
import * as fs from 'fs';
import * as path from 'path';
import { log } from '../../src/utils/logger';

export interface E2ETestContext {
    sourcePool: Pool;
    targetPool: Pool;
    schemas: TableSchema[];
    oidMap: Map<number, string>;
    outputDir: string;
    schemaName: string;
}

export interface E2ETestScenario {
    name: string;
    setupData: (pool: Pool) => Promise<void>;
    query: string;
    params: any[];
    expectedSeederFile?: string;
}

/**
 * Helper to run complete E2E test workflow:
 * 1. Setup data in source DB
 * 2. Execute query and capture results
 * 3. Generate seeders
 * 4. Apply seeders to target DB
 * 5. Verify query returns same results on target
 */
export async function runE2EScenario(
    context: E2ETestContext,
    scenario: E2ETestScenario
): Promise<void> {
    log.info(`\n========== E2E Scenario: ${scenario.name} ==========`);

    // Step 1: Setup data in source DB
    log.info('Step 1: Setting up test data in source DB...');
    try {
        await scenario.setupData(context.sourcePool);
        log.info('✓ Test data setup complete');
    } catch (error) {
        log.error('✗ Failed to setup test data:', error);
        throw error;
    }

    // Step 2: Capture query execution
    log.info('\nStep 2: Executing query and capturing results...');
    log.info('Query:', scenario.query.trim());
    log.info('Params:', JSON.stringify(scenario.params));

    const interceptor = startCapturePool(context.sourcePool, scenario.name, {
        outputDir: context.outputDir,
        captureReads: true
    });

    let sourceResult;
    try {
        sourceResult = await context.sourcePool.query(scenario.query, scenario.params);
        log.info(`✓ Source query returned ${sourceResult.rows.length} rows`);
        log.info('Sample row:', JSON.stringify(sourceResult.rows[0], null, 2));
    } catch (error) {
        log.error('✗ Source query failed:', error);
        throw error;
    }

    // Verify source query works
    expect(sourceResult.rows.length).toBeGreaterThan(0);

    // Step 3: Generate seeders
    log.info('\nStep 3: Generating seeders from captured data...');
    const capturedQueries = interceptor.getCapturedQueries();
    log.info(`Captured ${capturedQueries.length} queries`);

    expect(capturedQueries.length).toBeGreaterThan(0);

    const generator = new SeederGenerator();
    let rowsByTable;
    try {
        rowsByTable = await generator.extractInserts(
            capturedQueries,
            undefined,
            context.schemas,
            undefined, // columnMappings
            undefined, // debugLogger
            context.sourcePool
        );
        log.info('✓ Seeder generation complete');
        log.info('Tables with data:');
        for (const [tableName, rows] of rowsByTable.entries()) {
            log.info(`  - ${tableName}: ${rows.length} rows`);
        }
    } catch (error) {
        log.error('✗ Seeder generation failed:', error);
        throw error;
    }

    // Step 4: Apply seeders to target DB
    log.info('\nStep 4: Applying seeders to target DB...');

    // Sort tables by dependency order
    const { DependencyResolver } = require('../../src/generator/dependency-resolver');
    const resolver = new DependencyResolver();
    const { order } = resolver.resolveInsertionOrder(context.schemas);

    let insertCount = 0;
    try {
        for (const tableName of order) {
            const rows = rowsByTable.get(tableName);
            if (!rows || rows.length === 0) continue;

            for (const row of rows) {
                const columns = Object.keys(row);
                const values = columns.map(col => row[col]);
                const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

                const insertSQL = `
                    INSERT INTO ${tableName} (${columns.join(', ')}) 
                    VALUES (${placeholders})
                    ON CONFLICT DO NOTHING
                `;

                await context.targetPool.query(insertSQL, values);
                insertCount++;
            }
        }
        log.info(`✓ Applied ${insertCount} INSERT statements to target DB`);
    } catch (error) {
        log.error('✗ Failed to apply seeders:', error);
        log.error('Last attempted table:', Array.from(rowsByTable.keys()).pop());
        throw error;
    }

    // Step 5: Verify query works on target with same results
    log.info('\nStep 5: Verifying query works on target DB...');
    let targetResult;
    try {
        targetResult = await context.targetPool.query(scenario.query, scenario.params);
        log.info(`✓ Target query returned ${targetResult.rows.length} rows`);
        log.info('Sample row:', JSON.stringify(targetResult.rows[0], null, 2));
    } catch (error) {
        log.error('✗ Target query failed:', error);
        throw error;
    }

    // Compare row counts
    log.info('\nStep 6: Comparing results...');
    log.info(`Source rows: ${sourceResult.rows.length}, Target rows: ${targetResult.rows.length}`);

    if (targetResult.rows.length !== sourceResult.rows.length) {
        log.error('✗ Row count mismatch!');
        log.error('Source result:', JSON.stringify(sourceResult.rows, null, 2));
        log.error('Target result:', JSON.stringify(targetResult.rows, null, 2));
    }

    expect(targetResult.rows.length).toBe(sourceResult.rows.length);

    // Compare all rows
    for (let i = 0; i < sourceResult.rows.length; i++) {
        const sourceRow = sourceResult.rows[i];
        const targetRow = targetResult.rows[i];

        // Compare each column
        for (const key in sourceRow) {
            if (Array.isArray(sourceRow[key])) {
                if (JSON.stringify(targetRow[key]) !== JSON.stringify(sourceRow[key])) {
                    log.error(`✗ Array mismatch at row ${i}, column ${key}`);
                    log.error('Source:', sourceRow[key]);
                    log.error('Target:', targetRow[key]);
                }
                expect(targetRow[key]).toEqual(sourceRow[key]);
            } else {
                if (targetRow[key] !== sourceRow[key]) {
                    log.error(`✗ Value mismatch at row ${i}, column ${key}`);
                    log.error('Source:', sourceRow[key]);
                    log.error('Target:', targetRow[key]);
                }
                expect(targetRow[key]).toEqual(sourceRow[key]);
            }
        }
    }

    log.info('✓ All results match!');
    log.info('========================================\n');
}

/**
 * Setup E2E test context with source and target databases
 */
export async function setupE2EContext(testName: string): Promise<E2ETestContext> {
    // Source DB (simulates remote/production)
    const sourcePool = new Pool({
        host: 'localhost',
        port: 5433,
        database: 'seed_it_test',
        user: 'test_user',
        password: 'test_password'
    });

    // Target DB (simulates local)
    const targetPool = new Pool({
        host: 'localhost',
        port: 5434,
        database: 'seed_it_test_target',
        user: 'test_user',
        password: 'test_password'
    });

    // Generate unique schema name
    const schemaName = `test_schema_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // Clean both databases
    for (const pool of [sourcePool, targetPool]) {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
        await pool.query(`SET search_path TO ${schemaName}, public`);
    }

    // Create schema in both
    const { createComprehensiveSchema } = await import('./db-helper');
    const schema = createComprehensiveSchema();
    await sourcePool.query(schema);
    await targetPool.query(schema);

    // Analyze source schema
    const analyzer = new SchemaAnalyzer({
        name: 'seed_it_test',
        host: 'localhost',
        port: 5433,
        user: 'test_user',
        password: 'test_password',
        schema: schemaName
    });

    const schemas = await analyzer.getAllSchemas();
    const oidMap = await analyzer.getTableOids();
    await analyzer.close();

    const outputDir = path.join(__dirname, `../fixtures/${testName}-output`);
    if (fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true });
    }
    fs.mkdirSync(outputDir, { recursive: true });

    return {
        sourcePool,
        targetPool,
        schemas,
        oidMap,
        outputDir,
        schemaName
    };
}

/**
 * Cleanup E2E test context
 */
export async function teardownE2EContext(context: E2ETestContext): Promise<void> {
    if (context.sourcePool) {
        await context.sourcePool.query(`DROP SCHEMA IF EXISTS ${context.schemaName} CASCADE`);
        await context.sourcePool.end();
    }
    if (context.targetPool) {
        await context.targetPool.end();
    }

    if (fs.existsSync(context.outputDir)) {
        fs.rmSync(context.outputDir, { recursive: true });
    }
}
