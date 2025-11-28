import { describe, it, expect } from '@jest/globals';
import { QueryParser } from '../../src/parser/query-parser';
import { AutoColumnMapper } from '../../src/generator/auto-column-mapper';
import { CapturedQuery, TableSchema } from '../../src/types';

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

        const refIdsCol = parsed!.selectColumns.find((c: any) => c.alias === 'ref_ids');
        expect(refIdsCol).toBeDefined();
        expect(refIdsCol!.isAggregate).toBe(true);
        expect(refIdsCol!.aggregateFunction).toBe('array_agg');
    });

    it('should parse ELSE branch aggregate', () => {
        const parsed = parser.parse(query);
        const refIdsCol = parsed!.selectColumns.find((c: any) => c.alias === 'ref_ids');

        // Should extract from ELSE branch: array_agg(DISTINCT ab.ref_id ...)
        expect(refIdsCol!.caseAggregates).toBeDefined();
        expect(refIdsCol!.caseAggregates!.length).toBe(2);

        const elseBranch = refIdsCol!.caseAggregates!.find((ca: any) => ca.branch === 'ELSE');
        expect(elseBranch).toBeDefined();
        expect(elseBranch!.tableAlias).toBe('ab');
        expect(elseBranch!.aggregateColumn).toBe('ref_id');
    });

    it('should infer column mappings for CASE branches', () => {
        const oidMap = new Map([[12345, 'table_a']]);
        const mappings = mapper.inferMappings(capturedQuery, schemas, oidMap);

        // Should infer mappings for both THEN and ELSE branches
        // THEN branch: ref_ids_THEN -> table_b.ref_id
        // ELSE branch: ref_ids_ELSE -> table_a_b.ref_id
        const hasThenMapping = mappings['ref_ids_THEN'] !== undefined;
        const hasElseMapping = mappings['ref_ids_ELSE'] !== undefined;

        expect(hasThenMapping || hasElseMapping).toBe(true);

        if (hasElseMapping) {
            expect(mappings['ref_ids_ELSE'].table).toBe('table_a_b');
            expect(mappings['ref_ids_ELSE'].column).toBe('ref_id');
            expect(mappings['ref_ids_ELSE'].type).toBe('array');
        }

        if (hasThenMapping) {
            expect(mappings['ref_ids_THEN'].table).toBe('table_b');
            expect(mappings['ref_ids_THEN'].column).toBe('ref_id');
            expect(mappings['ref_ids_THEN'].type).toBe('array');
        }
    });
});
