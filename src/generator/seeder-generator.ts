import * as fs from 'fs';
import * as path from 'path';
import { CapturedQuery, TableSchema } from '../types';
import { DependencyResolver } from './dependency-resolver';
import { Deduplicator } from './deduplicator';

/**
 * Seeder generator that creates SQL INSERT statements from captured data
 */
export class SeederGenerator {
    private dependencyResolver = new DependencyResolver();
    private deduplicator = new Deduplicator();

    /**
     * Extract INSERT data from captured queries
     */
    extractInserts(queries: CapturedQuery[], debugLogger?: any): Map<string, Record<string, any>[]> {
        const rowsByTable = new Map<string, Record<string, any>[]>();
        let ignoredCount = 0;

        for (const query of queries) {
            const normalized = query.query.trim().toUpperCase();

            // Handle both INSERT (legacy/write capture) and SELECT (read capture)
            if (normalized.startsWith('INSERT') || normalized.startsWith('SELECT')) {
                const tableName = this.extractTableName(query.query);
                const rows = this.extractRowData(query);

                if (tableName && rows.length > 0) {
                    if (!rowsByTable.has(tableName)) {
                        rowsByTable.set(tableName, []);
                    }
                    rowsByTable.get(tableName)!.push(...rows);
                } else if (debugLogger) {
                    debugLogger.log('ignored_query', {
                        reason: !tableName ? 'no_table_name' : 'no_rows',
                        query: query.query,
                        extractedTable: tableName,
                        rowCount: rows.length
                    });
                }
            } else {
                ignoredCount++;
            }
        }

        if (debugLogger && ignoredCount > 0) {
            debugLogger.log('ignored_non_data_queries', { count: ignoredCount });
        }

        return rowsByTable;
    }

    /**
     * Extract table name from query
     */
    private extractTableName(query: string): string | null {
        // Match: INSERT INTO table_name ...
        const insertMatch = query.match(/INSERT\s+INTO\s+([^\s(]+)/i);
        if (insertMatch) {
            return insertMatch[1].replace(/["`]/g, '');
        }

        // Match: SELECT ... FROM table_name ...
        // Note: This is a simple regex and might not handle complex queries (joins, subqueries) perfectly
        // but covers the common case for seed generation
        const selectMatch = query.match(/\s+FROM\s+([^\s;()]+)/i);
        if (selectMatch) {
            return selectMatch[1].replace(/["`]/g, '');
        }

        return null;
    }

    /**
     * Extract row data from captured query
     * This is a simplified version - you may need to enhance based on your query format
     */
    private extractRowData(capturedQuery: CapturedQuery): Record<string, any>[] {
        // If the result contains the inserted rows, use that
        if (capturedQuery.result && capturedQuery.result.rows) {
            return capturedQuery.result.rows;
        }

        // Otherwise, try to parse from the query and params
        // This is a fallback and may not work for all cases
        return this.parseInsertQuery(capturedQuery.query, capturedQuery.params);
    }

    /**
     * Parse INSERT query to extract column names and values
     */
    private parseInsertQuery(query: string, params?: any[]): Record<string, any>[] {
        // Match: INSERT INTO table (col1, col2) VALUES ($1, $2)
        const columnMatch = query.match(/\(([^)]+)\)\s*VALUES/i);
        if (!columnMatch || !params) {
            return [];
        }

        const columns = columnMatch[1]
            .split(',')
            .map(col => col.trim().replace(/["`]/g, ''));

        // Create row object from params
        const row: Record<string, any> = {};
        columns.forEach((col, idx) => {
            row[col] = params[idx];
        });

        return [row];
    }

    /**
     * Generate SQL INSERT statement for a row
     */
    private generateInsert(tableName: string, row: Record<string, any>): string {
        const columns = Object.keys(row);
        const values = columns.map(col => this.formatValue(row[col]));

        return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
    }

    /**
     * Format a value for SQL
     */
    private formatValue(value: any): string {
        if (value === null || value === undefined) {
            return 'NULL';
        }

        if (typeof value === 'string') {
            // Escape single quotes
            return `'${value.replace(/'/g, "''")}'`;
        }

        if (typeof value === 'boolean') {
            return value ? 'TRUE' : 'FALSE';
        }

        if (value instanceof Date) {
            return `'${value.toISOString()}'`;
        }

        if (typeof value === 'object') {
            // Handle JSON columns
            return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
        }

        return String(value);
    }

    /**
     * Generate seeder file
     */
    async generateSeeder(
        queries: CapturedQuery[],
        schemas: TableSchema[],
        outputDir: string,
        seederName: string = 'initial_data',
        debugLogger?: any
    ): Promise<string> {
        // ...

        // Extract INSERT data
        const rowsByTable = this.extractInserts(queries, debugLogger);

        if (debugLogger) {
            debugLogger.log('extracted_rows', {
                tables: Array.from(rowsByTable.keys()),
                rowCounts: Object.fromEntries(
                    Array.from(rowsByTable.entries()).map(([k, v]) => [k, v.length])
                )
            });
        }

        // ...
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
        const fileName = `${timestamp}_${seederName}.sql`;
        const filePath = path.join(outputDir, 'seeders', fileName);

        // Ensure directory exists
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });



        // Deduplicate rows
        const deduplicated = this.deduplicator.deduplicateAll(rowsByTable, schemas);

        // Resolve insertion order
        const { order, circularDeps, selfReferencing } = this.dependencyResolver.resolveInsertionOrder(schemas);

        // Generate SQL
        const lines: string[] = [];
        lines.push(`-- Seeder: ${seederName}`);
        lines.push(`-- Generated: ${new Date().toISOString()}`);
        lines.push(`-- Total tables: ${deduplicated.size}`);
        lines.push('');

        if (circularDeps.length > 0) {
            lines.push('-- WARNING: Circular dependencies detected:');
            circularDeps.forEach(cycle => {
                lines.push(`--   ${cycle.join(' -> ')}`);
            });
            lines.push('-- You may need to temporarily disable FK constraints');
            lines.push('');
        }

        if (selfReferencing.length > 0) {
            lines.push('-- WARNING: Self-referencing tables:');
            selfReferencing.forEach(table => {
                lines.push(`--   ${table}`);
            });
            lines.push('-- You may need to insert parent rows before child rows');
            lines.push('');
        }

        // Generate INSERTs in dependency order
        let totalRows = 0;
        for (const tableName of order) {
            const rows = deduplicated.get(tableName);
            if (!rows || rows.length === 0) {
                continue;
            }

            lines.push(`-- Table: ${tableName} (${rows.length} rows)`);

            for (const row of rows) {
                lines.push(this.generateInsert(tableName, row));
            }

            lines.push('');
            totalRows += rows.length;
        }

        lines.push(`-- Total rows: ${totalRows}`);

        await fs.promises.writeFile(filePath, lines.join('\n'));

        console.log(`[seed-it] Generated seeder: ${fileName} (${totalRows} rows)`);

        return filePath;
    }

    /**
     * Generate multiple seeder files (one per table)
     */
    async generateSeedersByTable(
        queries: CapturedQuery[],
        schemas: TableSchema[],
        outputDir: string
    ): Promise<string[]> {
        const rowsByTable = this.extractInserts(queries);
        const deduplicated = this.deduplicator.deduplicateAll(rowsByTable, schemas);
        const { order } = this.dependencyResolver.resolveInsertionOrder(schemas);

        const files: string[] = [];

        for (const tableName of order) {
            const rows = deduplicated.get(tableName);
            if (!rows || rows.length === 0) {
                continue;
            }

            const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
            const fileName = `${timestamp}_${tableName}.sql`;
            const filePath = path.join(outputDir, 'seeders', fileName);

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

            const lines: string[] = [];
            lines.push(`-- Seeder: ${tableName}`);
            lines.push(`-- Generated: ${new Date().toISOString()}`);
            lines.push(`-- Rows: ${rows.length}`);
            lines.push('');

            for (const row of rows) {
                lines.push(this.generateInsert(tableName, row));
            }

            await fs.promises.writeFile(filePath, lines.join('\n'));
            files.push(filePath);
        }

        console.log(`[seed-it] Generated ${files.length} seeder files`);

        return files;
    }
}
