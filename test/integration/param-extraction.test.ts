import { createTestDb, createTestSchema } from '../helpers/db-helper';
import { AutoColumnMapper } from '../../src/generator/auto-column-mapper';
import { CapturedQuery } from '../../src/types';

describe('WHERE Clause Param Extraction', () => {
    let pool: any;
    let schemas: any[];

    beforeAll(async () => {
        const { pool: testPool } = await createTestDb(createTestSchema());
        pool = testPool;

        schemas = [
            {
                tableName: 'table_a',
                columns: [
                    { columnName: 'id', dataType: 'integer', isNullable: false },
                    { columnName: 'code', dataType: 'text', isNullable: false },
                    { columnName: 'parent_id', dataType: 'integer', isNullable: false }
                ],
                primaryKeys: ['id'],
                foreignKeys: [],
                indexes: []
            },
            {
                tableName: 'table_a_b',
                columns: [
                    { columnName: 'table_a_id', dataType: 'integer', isNullable: false },
                    { columnName: 'ref_id', dataType: 'integer', isNullable: false }
                ],
                primaryKeys: ['table_a_id', 'ref_id'],
                foreignKeys: [],
                indexes: []
            }
        ];
    });

    afterAll(async () => {
        await pool.end();
    });

    it('should extract siblings from WHERE clause params', () => {
        const query = `
            SELECT a.code, array_agg(ab.ref_id) AS ref_ids
            FROM table_a a
            LEFT JOIN table_a_b ab ON ab.table_a_id = a.id
            WHERE a.parent_id = $1
            GROUP BY a.code
        `;

        const capturedQuery: CapturedQuery = {
            query,
            params: [100],  // parent_id = 100
            result: {
                command: 'SELECT',
                rowCount: 1,
                rows: [
                    { code: 'rec-001', ref_ids: [1, 2, 3] }
                ],
                fields: [
                    {
                        name: 'code',
                        tableID: 12345,
                        columnID: 2,
                        dataTypeID: 25,
                        dataTypeSize: -1,
                        dataTypeModifier: -1,
                        format: 'text'
                    },
                    {
                        name: 'ref_ids',
                        tableID: 0,
                        columnID: 0,
                        dataTypeID: 1007,
                        dataTypeSize: -1,
                        dataTypeModifier: -1,
                        format: 'text'
                    }
                ]
            },
            timestamp: Date.now(),
            database: 'test_db'
        };

        const mapper = new AutoColumnMapper();
        const testOidMap = new Map([[12345, 'table_a']]);
        const mappings = mapper.inferMappings(capturedQuery, schemas, testOidMap);

        console.log('Inferred mappings:', JSON.stringify(mappings, null, 2));

        // Should have mapping for ref_ids
        expect(mappings['ref_ids']).toBeDefined();
        expect(mappings['ref_ids'].table).toBe('table_a_b');
        expect(mappings['ref_ids'].column).toBe('ref_id');

        // CRITICAL: Should have parent_id in siblings from WHERE clause
        expect(mappings['ref_ids'].siblings).toBeDefined();
        console.log('Siblings:', mappings['ref_ids'].siblings);

        // This is the key test - parent_id should be extracted from WHERE a.parent_id = $1
        // But we need to resolve the alias 'a' to 'table_a' first
        // The param mapping will have table: 'a', so we need alias resolution
    });
});
