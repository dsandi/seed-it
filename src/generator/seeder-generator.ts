import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { CapturedQuery, TableSchema } from '../types';
import { DependencyResolver } from './dependency-resolver';
import { Deduplicator } from './deduplicator';
import { AutoColumnMapper } from './auto-column-mapper';
import { DependencyFetcher } from './dependency-fetcher';

/**
 * Seeder generator that creates SQL INSERT statements from captured data
 */
export class SeederGenerator {
    private dependencyResolver = new DependencyResolver();
    private deduplicator = new Deduplicator();
    private debugLogger?: any;
    private autoMapper = new AutoColumnMapper();

    /**
     * Extract INSERT data from captured queries
     */
    extractInserts(
        queries: CapturedQuery[],
        oidMap?: Map<number, string>,
        schemas?: TableSchema[],
        columnMappings?: Record<string, any>,
        debugLogger?: any
    ): Map<string, Record<string, any>[]> {
        this.debugLogger = debugLogger;
        const rowsByTable = new Map<string, Record<string, any>[]>();
        let ignoredCount = 0;

        for (const query of queries) {
            const normalized = query.query.trim().toUpperCase();

            // Handle both INSERT (legacy/write capture) and SELECT (read capture)
            if (normalized.startsWith('INSERT') || normalized.startsWith('SELECT')) {
                // Try automatic column mapping inference first
                let effectiveMappings = columnMappings || {};

                if (oidMap && schemas && Object.keys(effectiveMappings).length === 0) {
                    const inferredMappings = this.autoMapper.inferMappings(query, schemas, oidMap);

                    if (this.debugLogger) {
                        this.debugLogger.log('inference_attempt', {
                            query: query.query,
                            inferredCount: Object.keys(inferredMappings).length,
                            mappings: inferredMappings
                        });
                    }

                    if (Object.keys(inferredMappings).length > 0) {
                        effectiveMappings = { ...inferredMappings, ...effectiveMappings };
                    }
                }

                // Try column mappings (manual or inferred)
                if (effectiveMappings && Object.keys(effectiveMappings).length > 0) {
                    const mapped = this.processColumnMappings(query, effectiveMappings);

                    if (mapped.size > 0) {
                        for (const [table, rows] of mapped.entries()) {
                            if (!rowsByTable.has(table)) {
                                rowsByTable.set(table, []);
                            }
                            rowsByTable.get(table)!.push(...rows);
                        }
                        // Continue to also process OID mapping (for non-mapped columns)
                    }
                }

                // Try to extract data using OID mapping (most accurate for JOINs)
                if (oidMap && query.result && query.result.fields) {
                    const extracted = this.extractRowsWithOids(query, oidMap, schemas);

                    if (extracted.size > 0) {
                        for (const [table, rows] of extracted.entries()) {
                            if (!rowsByTable.has(table)) {
                                rowsByTable.set(table, []);
                            }
                            rowsByTable.get(table)!.push(...rows);
                        }
                        continue; // Successfully processed with OIDs
                    }
                }

                // Fallback to regex parsing (legacy/simple queries)
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
     * Extract rows using OID metadata to map columns to tables
     */
    private extractRowsWithOids(
        query: CapturedQuery,
        oidMap: Map<number, string>,
        schemas?: TableSchema[]
    ): Map<string, Record<string, any>[]> {
        const rowsByTable = new Map<string, Record<string, any>[]>();

        if (!query.result || !query.result.rows || query.result.rows.length === 0 || !query.result.fields) {
            return rowsByTable;
        }

        // Map each field to a table name (using OID when available)
        const fieldMap: { index: number; table: string; column: string }[] = [];
        const skippedFields: string[] = [];

        query.result.fields.forEach((field: any, index: number) => {
            const tableName = oidMap.get(field.tableID);
            if (tableName) {
                fieldMap.push({
                    index,
                    table: tableName,
                    column: field.name
                });
            } else {
                skippedFields.push(`${field.name} (TableID: ${field.tableID})`);
            }
        });

        // Log skipped fields if any
        if (this.debugLogger && skippedFields.length > 0) {
            this.debugLogger.log('skipped_columns', {
                query: query.query,
                reason: 'missing_oid_mapping_or_calculated_field',
                skipped: skippedFields
            });
        }

        // If we have no OID mappings, try to infer the main table from the query
        // and include ALL columns for that table
        if (fieldMap.length === 0 && schemas) {
            const tableName = this.extractTableName(query.query);
            if (tableName) {
                // Add all fields to this table
                query.result.fields.forEach((field: any, index: number) => {
                    fieldMap.push({
                        index,
                        table: tableName,
                        column: field.name
                    });
                });

                if (this.debugLogger) {
                    this.debugLogger.log('fallback_table_inference', {
                        query: query.query,
                        inferredTable: tableName,
                        columnCount: fieldMap.length
                    });
                }
            }
        }

        if (fieldMap.length === 0) {
            return rowsByTable;
        }

        // Process each row
        for (const row of query.result.rows) {
            // Create a partial row for each table involved
            const partialRows = new Map<string, Record<string, any>>();

            for (const field of fieldMap) {
                if (!partialRows.has(field.table)) {
                    partialRows.set(field.table, {});
                }

                // Note: pg driver returns rows as objects with column names as keys.
                // If there are duplicate column names, the last one wins in the object.
                // This is a limitation of the default pg output.
                const val = row[field.column];
                if (val !== undefined) {
                    partialRows.get(field.table)![field.column] = val;
                }
            }

            // Auto-fill foreign keys from related tables in the result set
            if (schemas) {
                for (const [table, data] of partialRows.entries()) {
                    const schema = schemas.find(s => s.tableName === table);
                    if (!schema) continue;

                    // Find foreign keys that are missing from the result
                    for (const fk of schema.foreignKeys) {
                        if (data[fk.columnName] !== undefined) continue;

                        // Try to find the value from the referenced table's row
                        const referencedRow = partialRows.get(fk.referencedTable);
                        if (referencedRow && referencedRow[fk.referencedColumn] !== undefined) {
                            data[fk.columnName] = referencedRow[fk.referencedColumn];

                            if (this.debugLogger) {
                                this.debugLogger.log('auto_filled_fk', {
                                    table,
                                    column: fk.columnName,
                                    value: referencedRow[fk.referencedColumn],
                                    from: `${fk.referencedTable}.${fk.referencedColumn}`
                                });
                            }
                        }
                    }
                }
            }

            // Add partial rows to result
            for (const [table, data] of partialRows.entries()) {
                if (Object.keys(data).length > 0) {
                    if (!rowsByTable.has(table)) {
                        rowsByTable.set(table, []);
                    }
                    rowsByTable.get(table)!.push(data);
                }
            }
        }

        return rowsByTable;
    }

    /**
     * Process column mappings for calculated fields
     */
    private processColumnMappings(
        query: CapturedQuery,
        columnMappings: Record<string, any>
    ): Map<string, Record<string, any>[]> {
        const rowsByTable = new Map<string, Record<string, any>[]>();

        if (!query.result || !query.result.rows || query.result.rows.length === 0) {
            return rowsByTable;
        }

        for (const row of query.result.rows) {
            // Check each configured mapping
            for (const [resultColumn, mapping] of Object.entries(columnMappings)) {
                // Handle CASE branch mappings (e.g., "ref_ids_THEN", "ref_ids_ELSE")
                // Extract the base column name by removing _THEN or _ELSE suffix
                const baseColumn = resultColumn.replace(/_(?:THEN|ELSE)$/, '');
                const value = row[baseColumn];

                if (value === undefined || value === null) {
                    continue;
                }

                const table = mapping.table;
                const column = mapping.column;
                const type = mapping.type || 'scalar';
                const siblings = mapping.siblings || {};

                if (!rowsByTable.has(table)) {
                    rowsByTable.set(table, []);
                }

                if (type === 'array' && Array.isArray(value)) {
                    // Unroll array: create one row per array element
                    for (const arrayValue of value) {
                        const newRow: Record<string, any> = {
                            [column]: arrayValue
                        };

                        // Add sibling columns
                        for (const [siblingResultCol, siblingTableCol] of Object.entries(siblings)) {
                            const siblingValue = row[siblingResultCol];
                            if (siblingValue !== undefined) {
                                newRow[String(siblingTableCol)] = siblingValue;
                            }
                        }

                        rowsByTable.get(table)!.push(newRow);
                    }
                } else {
                    // Scalar: create one row
                    const newRow: Record<string, any> = {
                        [column]: value
                    };

                    // Add sibling columns
                    for (const [siblingResultCol, siblingTableCol] of Object.entries(siblings)) {
                        const siblingValue = row[siblingResultCol];
                        if (siblingValue !== undefined) {
                            newRow[String(siblingTableCol)] = siblingValue;
                        }
                    }

                    rowsByTable.get(table)!.push(newRow);
                }
            }
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
     * Generate INSERT statement for a row
     */
    private generateInsertStatement(tableName: string, row: Record<string, any>, schema?: TableSchema): string {
        const columns = Object.keys(row);
        const values = columns.map(col => {
            const val = row[col];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`;
            if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
            if (Array.isArray(val)) return `ARRAY[${val.map(v => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : this.formatValue(v)).join(', ')}]`;
            if (val instanceof Date) return `'${val.toISOString()}'`;
            if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
            return String(val);
        });

        // Add ON CONFLICT DO NOTHING with primary key
        let conflictClause = '';
        if (schema && schema.primaryKeys.length > 0) {
            const pkColumns = schema.primaryKeys.join(', ');
            conflictClause = ` ON CONFLICT (${pkColumns}) DO NOTHING`;
        }

        return `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')})${conflictClause};`;
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
        oidMap?: Map<number, string>,
        columnMappings?: Record<string, any>,
        pool?: Pool,
        debugLogger?: any
    ): Promise<string> {
        // ...

        // Extract INSERT data
        let rowsByTable = this.extractInserts(queries, oidMap, schemas, columnMappings, debugLogger);

        // Fetch missing dependencies from remote database
        if (pool) {
            const fetcher = new DependencyFetcher();
            rowsByTable = await fetcher.fetchDependencies(rowsByTable, schemas, pool, debugLogger);
        }

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

            const schema = schemas.find(s => s.tableName === tableName);
            for (const row of rows) {
                lines.push(this.generateInsertStatement(tableName, row, schema));
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
        outputDir: string,
        oidMap?: Map<number, string>
    ): Promise<string[]> {
        const rowsByTable = this.extractInserts(queries, oidMap, schemas);
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
            const schema = schemas.find(s => s.tableName === tableName);
            for (const row of rows) {
                lines.push(this.generateInsertStatement(tableName, row, schema));
            }

            await fs.promises.writeFile(filePath, lines.join('\n'));
            files.push(filePath);
        }

        console.log(`[seed-it] Generated ${files.length} seeder files`);

        return files;
    }
}
