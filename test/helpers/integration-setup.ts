import { Pool } from 'pg';
import { createComprehensiveSchema, seedComprehensiveData } from './db-helper';
import { SchemaAnalyzer } from '../../src/analyzer/schema-analyzer';
import { TableSchema } from '../../src/types';

export interface IntegrationTestContext {
    pool: Pool;
    schemas: TableSchema[];
    oidMap: Map<number, string>;
    analyzer: SchemaAnalyzer;
    schemaName: string;
}

export async function setupIntegrationTest(): Promise<IntegrationTestContext> {
    // Connect to Docker PostgreSQL (source DB)
    const pool = new Pool({
        host: 'localhost',
        port: 5433,
        database: 'seed_it_test',
        user: 'test_user',
        password: 'test_password'
    });

    // Generate unique schema name
    const schemaName = `test_schema_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    // Create schema and set search path
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}, public`);

    // Create schema
    const schema = createComprehensiveSchema();
    await pool.query(schema);

    // Seed data
    await seedComprehensiveData(pool);

    // Analyze schema
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

    return { pool, schemas, oidMap, analyzer, schemaName };
}

export async function teardownIntegrationTest(context: IntegrationTestContext): Promise<void> {
    if (context.analyzer) {
        await context.analyzer.close();
    }
    if (context.pool) {
        await context.pool.query(`DROP SCHEMA IF EXISTS ${context.schemaName} CASCADE`);
        await context.pool.end();
    }
}
