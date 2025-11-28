import { Pool } from 'pg';
import { createComprehensiveSchema, seedComprehensiveData } from './db-helper';
import { SchemaAnalyzer } from '../../src/analyzer/schema-analyzer';
import { TableSchema } from '../../src/types';

export interface IntegrationTestContext {
    pool: Pool;
    schemas: TableSchema[];
    oidMap: Map<number, string>;
    analyzer: SchemaAnalyzer;
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

    // Drop all existing tables (CASCADE will handle dependencies)
    await pool.query(`
        DROP SCHEMA IF EXISTS public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO test_user;
        GRANT ALL ON SCHEMA public TO public;
    `);

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
        password: 'test_password'
    });

    const schemas = await analyzer.getAllSchemas();
    const oidMap = await analyzer.getTableOids();

    return { pool, schemas, oidMap, analyzer };
}

export async function teardownIntegrationTest(context: IntegrationTestContext): Promise<void> {
    await context.analyzer.close();
    await context.pool.end();
}
