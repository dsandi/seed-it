
import { SeederGenerator } from '../../src/generator/seeder-generator';
import { QueryParser } from '../../src/parser/query-parser';
import { TableSchema, CapturedQuery } from '../../src/types';
import { Pool } from 'pg';

// Mock QueryParser
jest.mock('../../src/parser/query-parser');

describe('SeederGenerator', () => {
    let generator: SeederGenerator;
    let mockQueryParser: jest.Mocked<QueryParser>;
    let mockPool: jest.Mocked<Pool>;

    beforeEach(() => {
        mockQueryParser = new QueryParser() as jest.Mocked<QueryParser>;
        mockPool = {
            query: jest.fn(),
        } as unknown as jest.Mocked<Pool>;

        generator = new SeederGenerator();
        // Inject mocks
        (generator as any).queryParser = mockQueryParser;
    });

    describe('extractInserts', () => {
        it('should filter out tables not present in the schema (e.g. CTEs)', async () => {
            const queries: CapturedQuery[] = [{
                query: 'WITH cte AS (SELECT * FROM users) SELECT * FROM cte',
                result: {
                    rows: [{ id: 1, username: 'alice' }],
                    fields: [], command: 'SELECT', rowCount: 1, oid: 0
                },
                timestamp: Date.now(),
                database: 'test_db'
            }];

            const schemas: TableSchema[] = [
                { tableName: 'users', columns: [], foreignKeys: [], primaryKeys: [], indexes: [] }
            ];

            // Mock parser to return both real table and CTE
            mockQueryParser.parse.mockReturnValue({
                referencedTables: ['users', 'cte'],
                selectColumns: [],
                fromTable: { tableName: 'cte' },
                joins: [],
                groupBy: [],
                whereConditions: [],
                paramMappings: []
            });

            const result = await generator.extractInserts(queries, undefined, schemas, undefined, undefined, mockPool);

            expect(result.has('users')).toBe(true);
            expect(result.has('cte')).toBe(false);
        });

        it('should filter out columns not present in the schema during enrichment', async () => {
            const queries: CapturedQuery[] = [{
                query: 'SELECT * FROM users',
                result: {
                    rows: [{ id: 1, username: 'alice', extra_col: 'ignore_me' }],
                    fields: [], command: 'SELECT', rowCount: 1, oid: 0
                },
                timestamp: Date.now(),
                database: 'test_db'
            }];

            const schemas: TableSchema[] = [
                {
                    tableName: 'users',
                    columns: [
                        { columnName: 'id', dataType: 'int', isNullable: false },
                        { columnName: 'username', dataType: 'text', isNullable: false }
                    ],
                    foreignKeys: [],
                    primaryKeys: ['id'],
                    indexes: []
                }
            ];

            mockQueryParser.parse.mockReturnValue({
                referencedTables: ['users'],
                selectColumns: [],
                fromTable: { tableName: 'users' },
                joins: [],
                groupBy: [],
                whereConditions: [],
                paramMappings: []
            });

            // Mock enrichment to return the row as is (or with extra data)
            // The enrichment logic in extractInserts calls enrichRowsWithCompleteData
            // We need to mock the pool response if enrichRowsWithCompleteData is called
            // But here we are testing the filtering logic which happens AFTER enrichment in extractInserts

            // Mock pool to return empty result so enrichment doesn't overwrite our row
            (mockPool.query as jest.Mock).mockResolvedValue({ rows: [], command: '', rowCount: 0, oid: 0, fields: [] });

            const result = await generator.extractInserts(queries, undefined, schemas, undefined, undefined, mockPool);

            const usersRows = result.get('users');
            expect(usersRows).toBeDefined();
            expect(usersRows![0]).toHaveProperty('id');
            expect(usersRows![0]).toHaveProperty('username');
            expect(usersRows![0]).not.toHaveProperty('extra_col');
        });
    });
});
