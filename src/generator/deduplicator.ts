import { SeederRow, TableSchema } from '../types';
import * as crypto from 'crypto';

/**
 * Deduplicator that removes duplicate rows based on primary keys
 */
export class Deduplicator {
    /**
     * Generate a hash for a row based on primary key columns
     */
    private hashRow(row: Record<string, any>, pkColumns: string[]): string {
        // If no PK columns, use all columns
        const keyColumns = pkColumns.length > 0 ? pkColumns : Object.keys(row).sort();

        const keyValues = keyColumns.map(col => {
            const value = row[col];
            return value === null || value === undefined ? 'NULL' : String(value);
        });

        return crypto
            .createHash('sha256')
            .update(keyValues.join('|'))
            .digest('hex');
    }

    /**
     * Deduplicate rows for a single table
     */
    deduplicateTable(
        rows: Record<string, any>[],
        schema: TableSchema
    ): Record<string, any>[] {
        const seen = new Set<string>();
        const unique: Record<string, any>[] = [];

        for (const row of rows) {
            const hash = this.hashRow(row, schema.primaryKeys);

            if (!seen.has(hash)) {
                seen.add(hash);
                unique.push(row);
            }
        }

        return unique;
    }

    /**
     * Deduplicate all rows grouped by table
     */
    deduplicateAll(
        rowsByTable: Map<string, Record<string, any>[]>,
        schemas: TableSchema[]
    ): Map<string, Record<string, any>[]> {
        const schemaMap = new Map(schemas.map(s => [s.tableName, s]));
        const deduplicated = new Map<string, Record<string, any>[]>();

        for (const [tableName, rows] of rowsByTable) {
            const schema = schemaMap.get(tableName);

            if (!schema) {
                console.warn(`[seed-it] Warning: No schema found for table ${tableName}, skipping deduplication`);
                deduplicated.set(tableName, rows);
                continue;
            }

            const uniqueRows = this.deduplicateTable(rows, schema);
            deduplicated.set(tableName, uniqueRows);

            if (rows.length !== uniqueRows.length) {
                console.log(
                    `[seed-it] Deduplicated ${tableName}: ${rows.length} -> ${uniqueRows.length} rows`
                );
            }
        }

        return deduplicated;
    }

    /**
     * Create SeederRow objects with hashes
     */
    createSeederRows(
        rowsByTable: Map<string, Record<string, any>[]>,
        schemas: TableSchema[]
    ): SeederRow[] {
        const schemaMap = new Map(schemas.map(s => [s.tableName, s]));
        const seederRows: SeederRow[] = [];

        for (const [tableName, rows] of rowsByTable) {
            const schema = schemaMap.get(tableName);

            for (const row of rows) {
                const hash = schema
                    ? this.hashRow(row, schema.primaryKeys)
                    : this.hashRow(row, []);

                seederRows.push({
                    table: tableName,
                    data: row,
                    hash,
                });
            }
        }

        return seederRows;
    }
}
