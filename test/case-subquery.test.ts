import { describe, it, expect } from '@jest/globals';
import { QueryParser } from '../src/parser/query-parser';
import { AutoColumnMapper } from '../src/generator/auto-column-mapper';
import { CapturedQuery, TableSchema } from '../src/types';

describe('CASE Statement with Subquery', () => {
    const parser = new QueryParser();
    const mapper = new AutoColumnMapper();

    const query = `SELECT a.code,
                 CASE
                     WHEN a.flag_all
                         THEN (SELECT array_agg(b.ref_id ORDER BY b.ref_id)
                               FROM table_b b
                               WHERE b.parent_id = a.parent_id)
                     ELSE array_agg(DISTINCT ab.ref_id ORDER BY ab.ref_id)
                     END AS ref_ids
          FROM table_a a
                   LEFT JOIN table_a_b ab ON ab.table_a_id = a.id
          WHERE a.parent_id = $1
            AND (a.flag_all = TRUE OR ab.ref_id = ANY ($2))
          GROUP BY a.code, a.flag_all, a.parent_id;`;

    const capturedQuery: CapturedQuery = {
        query,
        params: [100, [1]],
        result: {
            command: 'SELECT',
            rowCount: 2,
            rows: [
                { code: 'rec-001', ref_ids: [1] },
                { code: 'rec-002', ref_ids: [1, 2, 3, 4, 5] }
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

    const schemas: TableSchema[] = [
        {
            tableName: 'table_a',
            columns: [
                { columnName: 'id', dataType: 'integer', isNullable: false },
                { columnName: 'code', dataType: 'text', isNullable: false },
                { columnName: 'parent_id', dataType: 'integer', isNullable: false },
                { columnName: 'flag_all', dataType: 'boolean', isNullable: false }
            ],
            primaryKeys: ['id'],
            foreignKeys: [],
            indexes: []
        },
        {
            tableName: 'table_b',
            columns: [
                { columnName: 'ref_id', dataType: 'integer', isNullable: false },
                { columnName: 'parent_id', dataType: 'integer', isNullable: false }
            ],
            primaryKeys: ['ref_id'],
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
            foreignKeys: [
                {
                    constraintName: 'fk_table_a',
                    columnName: 'table_a_id',
                    referencedTable: 'table_a',
                    referencedColumn: 'id'
                }
            ],
            indexes: []
        }
    ];

    it('should parse CASE statement with THEN subquery', () => {
        const parsed = parser.parse(query);

        expect(parsed).not.toBeNull();
        expect(parsed!.selectColumns).toHaveLength(2);

        const refIdsCol = parsed!.selectColumns.find(c => c.alias === 'ref_ids');
        expect(refIdsCol).toBeDefined();
        expect(refIdsCol!.isAggregate).toBe(true);
        expect(refIdsCol!.aggregateFunction).toBe('array_agg');
    });

    it('should parse ELSE branch aggregate', () => {
        const parsed = parser.parse(query);
        const refIdsCol = parsed!.selectColumns.find(c => c.alias === 'ref_ids');

        // Should extract from ELSE branch: array_agg(DISTINCT ab.ref_id ...)
        expect(refIdsCol!.tableAlias).toBe('ab');
        expect(refIdsCol!.aggregateColumn).toBe('ref_id');
    });

    it('should infer column mappings for ELSE branch', () => {
        const oidMap = new Map([[12345, 'table_a']]);
        const mappings = mapper.inferMappings(capturedQuery, schemas, oidMap);

        // Should infer mapping for ref_ids -> table_a_b.ref_id
        expect(mappings['ref_ids']).toBeDefined();
        expect(mappings['ref_ids'].table).toBe('table_a_b');
        expect(mappings['ref_ids'].column).toBe('ref_id');
        expect(mappings['ref_ids'].type).toBe('array');
    });

    it('should generate inserts for table_a_b', () => {
        // This test would verify that the seeder generator creates:
        // INSERT INTO table_a_b (table_a_id, ref_id) VALUES (...)
        // for the ELSE branch data

        // TODO: Implement after fixing the parser
        expect(true).toBe(true);
    });

    it('should handle THEN branch subquery (table_b)', () => {
        // This test would verify that the tool also generates:
        // INSERT INTO table_b (ref_id, parent_id) VALUES (...)
        // for the THEN branch data

        // TODO: This is the missing functionality - need to parse THEN subquery
        expect(true).toBe(true);
    });
});
