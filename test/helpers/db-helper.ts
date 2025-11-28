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
