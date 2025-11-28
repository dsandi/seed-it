import { Pool } from 'pg';
import { TableSchema } from '../types';

interface FetchedRow {
    table: string;
    row: Record<string, any>;
    depth: number;
}

/**
 * Fetches missing dependencies from remote database
 */
export class DependencyFetcher {
    private visited = new Set<string>();
    private maxDepth = 10;
    private fetchCount = 0;

    /**
     * Fetch missing FK dependencies recursively
     */
    async fetchDependencies(
        rowsByTable: Map<string, Record<string, any>[]>,
        schemas: TableSchema[],
        pool: Pool,
        debugLogger?: any
    ): Promise<Map<string, Record<string, any>[]>> {
        console.log('[seed-it] Fetching missing dependencies from remote database...');

        const result = new Map(rowsByTable);
        const toFetch: FetchedRow[] = [];

        // Build initial fetch queue from existing rows
        for (const [table, rows] of rowsByTable.entries()) {
            for (const row of rows) {
                toFetch.push({ table, row, depth: 0 });
            }
        }

        // Process queue
        while (toFetch.length > 0) {
            const { table, row, depth } = toFetch.shift()!;

            if (depth >= this.maxDepth) {
                if (debugLogger) {
                    debugLogger.log('max_depth_reached', { table, depth });
                }
                continue;
            }

            const schema = schemas.find(s => s.tableName === table);
            if (!schema) continue;

            // Check each FK in this row
            for (const fk of schema.foreignKeys) {
                const fkValue = row[fk.columnName];
                if (fkValue === null || fkValue === undefined) continue;

                // Create unique key for this referenced row
                const refKey = `${fk.referencedTable}:${fk.referencedColumn}:${fkValue}`;

                if (this.visited.has(refKey)) continue;
                this.visited.add(refKey);

                // Check if we already have this row
                const existingRows = result.get(fk.referencedTable) || [];
                const exists = existingRows.some(r => r[fk.referencedColumn] === fkValue);

                if (!exists) {
                    // Fetch from remote DB
                    const fetchedRow = await this.fetchRow(
                        pool,
                        fk.referencedTable,
                        fk.referencedColumn,
                        fkValue
                    );

                    if (fetchedRow) {
                        if (!result.has(fk.referencedTable)) {
                            result.set(fk.referencedTable, []);
                        }
                        result.get(fk.referencedTable)!.push(fetchedRow);

                        this.fetchCount++;
                        if (this.fetchCount % 10 === 0) {
                            console.log(`[seed-it] Fetched ${this.fetchCount} dependency rows...`);
                        }

                        if (debugLogger) {
                            debugLogger.log('fetched_dependency', {
                                table: fk.referencedTable,
                                column: fk.referencedColumn,
                                value: fkValue,
                                fromTable: table,
                                depth: depth + 1
                            });
                        }

                        // Add to queue for recursive processing
                        toFetch.push({
                            table: fk.referencedTable,
                            row: fetchedRow,
                            depth: depth + 1
                        });
                    }
                }
            }
        }

        console.log(`[seed-it] Fetched ${this.fetchCount} total dependency rows`);
        return result;
    }

    private async fetchRow(
        pool: Pool,
        table: string,
        column: string,
        value: any
    ): Promise<Record<string, any> | null> {
        try {
            const query = `SELECT * FROM ${table} WHERE ${column} = $1 LIMIT 1`;
            const result = await pool.query(query, [value]);
            return result.rows[0] || null;
        } catch (error: any) {
            console.error(`[seed-it] Error fetching ${table}.${column} = ${value}:`, error.message);
            return null;
        }
    }
}
