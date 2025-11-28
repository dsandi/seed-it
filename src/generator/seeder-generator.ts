import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { CapturedQuery, TableSchema } from '../types';
import { DependencyResolver } from './dependency-resolver';
import { Deduplicator } from './deduplicator';
import { AutoColumnMapper } from './auto-column-mapper';
import { log } from '../utils/logger';
import { DependencyFetcher } from './dependency-fetcher';
import { QueryParser } from '../parser/query-parser';

/**
 * Seeder generator that creates SQL INSERT statements from captured data
 */
export class SeederGenerator {
    private dependencyResolver = new DependencyResolver();
    private deduplicator = new Deduplicator();
    private debugLogger?: any;
    private autoMapper = new AutoColumnMapper();
    private queryParser = new QueryParser();
    private dependencyFetcher = new DependencyFetcher();

    /**
     * Extract INSERT data from captured queries
     */
    async extractInserts(
        queries: CapturedQuery[],
        oidMap?: Map<number, string>,
        schemas?: TableSchema[],
        columnMappings?: Record<string, any>,
        debugLogger?: any,
        pool?: Pool
    ): Promise<Map<string, Record<string, any>[]>> {
        log.debug('[DEBUG] extractInserts called with', queries.length, 'queries');
        this.debugLogger = debugLogger;
        const rowsByTable = new Map<string, Record<string, any>[]>();
        let ignoredCount = 0;

        for (const query of queries) {
            log.debug('[DEBUG] Processing query:', query.query.substring(0, 50));
            const normalized = query.query.trim().toUpperCase();

            // Handle both INSERT (legacy/write capture) and SELECT (read capture)
            if (!normalized.startsWith('INSERT') && !normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
                continue;
            }

            // Strategy:
            // 1. Identify tables involved (using QueryParser)
            // 2. Extract partial rows (simple mapping)
            // 3. Accumulate partial rows
            // 4. Later: Enrich with complete data

            let extractedForQuery = new Map<string, Record<string, any>[]>();
            const identifiedTables = new Set<string>();

            // 1. Identify tables using QueryParser
            const parsed = this.queryParser.parse(query.query);
            if (parsed) {
                parsed.referencedTables.forEach(table => identifiedTables.add(table));
            } else {
                // Fallback: Simple table name extraction for simple queries
                const tableName = this.extractTableName(query.query);
                if (tableName) identifiedTables.add(tableName);
            }

            // Filter out tables that don't exist in the schema (e.g. CTE names)
            if (schemas) {
                const validTables = new Set(schemas.map(s => s.tableName));
                for (const table of identifiedTables) {
                    if (!validTables.has(table)) {
                        identifiedTables.delete(table);
                    }
                }
            }

            // 2. Extract partial rows
            const rows = this.extractRowData(query);

            // 3. Infer values from parameters (e.g. WHERE id = $1)
            const inferredValues = new Map<string, Record<string, any>>();
            if (parsed && parsed.paramMappings && query.params) {
                // Build alias map
                const aliasMap = new Map<string, string>();
                if (parsed.fromTable && parsed.fromTable.alias) {
                    aliasMap.set(parsed.fromTable.alias, parsed.fromTable.tableName);
                }
                if (parsed.joins) {
                    for (const join of parsed.joins) {
                        if (join.table.alias) {
                            aliasMap.set(join.table.alias, join.table.tableName);
                        }
                    }
                }

                for (const mapping of parsed.paramMappings) {
                    if (mapping.operator === '=' && mapping.paramIndex > 0 && mapping.paramIndex <= query.params.length) {
                        const value = query.params[mapping.paramIndex - 1];
                        let tableName = mapping.table || (parsed.fromTable ? parsed.fromTable.tableName : undefined);

                        // Resolve alias if present
                        if (tableName && aliasMap.has(tableName)) {
                            tableName = aliasMap.get(tableName);
                        }

                        if (tableName) {
                            if (!inferredValues.has(tableName)) {
                                inferredValues.set(tableName, {});
                            }
                            inferredValues.get(tableName)![mapping.column] = value;
                        }
                    }
                }
            }

            if (rows.length > 0 && identifiedTables.size > 0) {
                for (const table of identifiedTables) {
                    if (!extractedForQuery.has(table)) extractedForQuery.set(table, []);

                    // Clone rows and apply inferred values for this table
                    const tableRows = rows.map(row => {
                        const newRow = { ...row };
                        const inferred = inferredValues.get(table);
                        if (inferred) {
                            Object.assign(newRow, inferred);
                        }
                        return newRow;
                    });

                    extractedForQuery.get(table)!.push(...tableRows);
                }
            } else {
                // We add the same raw row to every identified table's bucket
                // The enrichment phase will filter out invalid ones (those missing keys)
                // If no rows were extracted from query.result, but we inferred values,
                // we should still add them as a potential row.
                if (identifiedTables.size > 0 && inferredValues.size > 0) {
                    for (const table of identifiedTables) {
                        const inferred = inferredValues.get(table);
                        if (inferred && Object.keys(inferred).length > 0) {
                            if (!extractedForQuery.has(table)) extractedForQuery.set(table, []);
                            extractedForQuery.get(table)!.push(inferred);
                        }
                    }
                }
            }

            // 4. Process column mappings (e.g. array unrolling)
            // Combine manual mappings with auto-inferred mappings
            let effectiveMappings = columnMappings || {};

            // Auto-infer mappings if we have schema info
            if (schemas) {
                const inferredMappings = this.autoMapper.inferMappings(query, schemas, oidMap);
                if (Object.keys(inferredMappings).length > 0) {
                    log.debug(`[seed-it] Inferred mappings for query:`, Object.keys(inferredMappings));
                    effectiveMappings = { ...inferredMappings, ...effectiveMappings };
                }
            }

            if (Object.keys(effectiveMappings).length > 0) {
                const mappedRows = this.processColumnMappings(query, effectiveMappings);
                for (const [table, rows] of mappedRows.entries()) {
                    if (!extractedForQuery.has(table)) extractedForQuery.set(table, []);
                    extractedForQuery.get(table)!.push(...rows);
                }
            }

            // Merge into main results
            if (extractedForQuery.size > 0) {
                for (const [table, rows] of extractedForQuery.entries()) {
                    if (!rowsByTable.has(table)) rowsByTable.set(table, []);
                    rowsByTable.get(table)!.push(...rows);
                }
            } else {
                if (debugLogger) {
                    debugLogger.log('ignored_query', { query: query.query, reason: 'no_data_extracted' });
                }
                ignoredCount++;
            }
        }

        // Phase 2: Enrichment - Fetch complete rows from source DB
        // This is the "Human-Like" step: "Go and query those rows to extract the values"
        // Phase 2: Enrichment - Fetch complete rows from source DB
        // This is the "Human-Like" step: "Go and query those rows to extract the values"
        if (pool && schemas && rowsByTable.size > 0) {
            log.debug(`[seed-it] Starting enrichment phase for ${rowsByTable.size} tables`);
            // Debug: Log rows before enrichment
            for (const [table, rows] of rowsByTable.entries()) {
                if (rows.length > 0) {
                    log.debug(`[DEBUG] Before enrichment ${table}:`, JSON.stringify(rows[0]));
                }
            }
            await this.enrichRowsWithCompleteData(rowsByTable, pool, schemas);
            // Debug: Log rows after enrichment
            for (const [table, rows] of rowsByTable.entries()) {
                if (rows.length > 0) {
                    log.debug(`[DEBUG] After enrichment ${table}:`, JSON.stringify(rows[0]));
                }
            }
        }

        // Filter columns to ensure we only return valid columns for each table
        if (schemas && rowsByTable.size > 0) {
            for (const [table, rows] of rowsByTable.entries()) {
                const schema = schemas.find(s => s.tableName === table);
                if (schema) {
                    const validColumns = new Set(schema.columns.map(c => c.columnName));
                    const validRows: Record<string, any>[] = [];

                    for (const row of rows) {
                        const filteredRow: Record<string, any> = {};
                        let hasColumns = false;
                        for (const key of Object.keys(row)) {
                            if (validColumns.has(key)) {
                                filteredRow[key] = row[key];
                                hasColumns = true;
                            }
                        }
                        if (hasColumns) {
                            validRows.push(filteredRow);
                        }
                    }
                    log.debug(`[DEBUG] Filtered ${table}: ${rows.length} -> ${validRows.length} rows`);
                    rowsByTable.set(table, validRows);
                }
            }
        }

        // Phase 3: Fetch missing dependencies (transitive)
        if (pool && schemas && rowsByTable.size > 0) {
            log.debug(`[seed-it] Fetching dependencies for ${rowsByTable.size} tables`);
            const enrichedRows = await this.dependencyFetcher.fetchDependencies(rowsByTable, schemas, pool, this.debugLogger);

            // Merge fetched dependencies back into rowsByTable
            for (const [table, rows] of enrichedRows.entries()) {
                if (!rowsByTable.has(table)) {
                    rowsByTable.set(table, []);
                }
                // We might have duplicates here, but Deduplicator will handle them later
                rowsByTable.get(table)!.push(...rows);
            }
        }

        if (debugLogger && ignoredCount > 0) {
            debugLogger.log('ignored_non_data_queries', { count: ignoredCount });
        }

        return rowsByTable;
    }



    /**
     * Enrich partial rows with complete data from the source database
     * Uses Primary Keys or Unique Indexes to fetch the full row
     */
    private async enrichRowsWithCompleteData(
        rowsByTable: Map<string, Record<string, any>[]>,
        pool: Pool,
        schemas: TableSchema[]
    ): Promise<void> {
        for (const [table, rows] of rowsByTable.entries()) {
            const schema = schemas.find(s => s.tableName === table);
            if (!schema) continue;

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];

                // Skip if row seems complete (heuristic: has more columns than just PK/Unique)
                // or if we've already fetched it (check for a known non-key column if possible)
                // For now, we'll try to fetch if we have keys, to be safe and ensure we get all columns.

                let fetchQuery = '';
                let fetchValues: any[] = [];

                // 1. Try Primary Keys
                const pkValues: any[] = [];
                let hasPK = true;
                if (schema.primaryKeys.length > 0) {
                    for (const pk of schema.primaryKeys) {
                        if (row[pk] !== undefined) {
                            pkValues.push(row[pk]);
                        } else {
                            hasPK = false;
                            break;
                        }
                    }
                } else {
                    hasPK = false;
                }

                if (hasPK && pkValues.length > 0) {
                    const pkConditions = schema.primaryKeys.map((pk, idx) => `${pk} = $${idx + 1}`).join(' AND ');
                    fetchQuery = `SELECT * FROM ${table} WHERE ${pkConditions} LIMIT 1`;
                    fetchValues = pkValues;
                } else {
                    // 2. Try Unique Indexes
                    for (const index of schema.indexes) {
                        if (!index.isUnique) continue;

                        const indexValues: any[] = [];
                        let hasIndex = true;
                        for (const col of index.columns) {
                            if (row[col] !== undefined) {
                                indexValues.push(row[col]);
                            } else {
                                hasIndex = false;
                                break;
                            }
                        }

                        if (hasIndex && indexValues.length > 0) {
                            const indexConditions = index.columns.map((col, idx) => `${col} = $${idx + 1}`).join(' AND ');
                            fetchQuery = `SELECT * FROM ${table} WHERE ${indexConditions} LIMIT 1`;
                            fetchValues = indexValues;
                            // log.debug(`[seed-it] Found unique index for ${table}: ${index.indexName} (${index.columns.join(', ')})`);
                            break;
                        }
                    }
                }

                // 3. Fallback: Try Best Effort with ALL available columns
                // If we still don't have a query, and we have SOME data, try to find a row that matches what we have.
                // This is risky if the data isn't unique, but better than failing to enrich when we have a "pretty good" identifier (like a token).
                if (!fetchQuery) {
                    const validColumns = schema.columns.map(c => c.columnName);
                    const availableColumns = Object.keys(row).filter(key =>
                        row[key] !== undefined &&
                        row[key] !== null &&
                        validColumns.includes(key)
                    );

                    if (availableColumns.length > 0) {
                        const conditions = availableColumns.map((col, idx) => `${col} = $${idx + 1}`).join(' AND ');
                        fetchQuery = `SELECT * FROM ${table} WHERE ${conditions} LIMIT 1`;
                        fetchValues = availableColumns.map(col => row[col]);
                        log.warn(`[seed-it] ⚠ Using heuristic lookup for ${table} using columns: ${availableColumns.join(', ')}`);
                    }
                }

                if (fetchQuery) {
                    try {
                        // log.debug(`[seed-it] Fetching complete row for ${table} with values:`, fetchValues);
                        const result = await pool.query(fetchQuery, fetchValues);
                        if (result.rows.length > 0) {
                            // Merge complete row with existing data (preserving any calculated fields if they exist)
                            rows[i] = { ...row, ...result.rows[0] };
                            // log.debug(`[seed-it] ✓ Fetched complete row for ${table}`);
                        } else {
                            // Warn if we couldn't find the row (this explains incomplete seeders)
                            log.warn(`[seed-it] ⚠ Could not find complete row for ${table} using keys:`, fetchValues);
                            log.warn(`[seed-it]   Query: ${fetchQuery}`);
                            log.warn(`[seed-it]   This row will be seeded with partial data (IDs only).`);
                        }
                    } catch (error: any) {
                        log.debug(`[seed-it] ✗ Error fetching complete row for ${table}:`, error.message);
                    }
                }
            }
        }

        // After enrichment, resolve deferred lookups
        this.resolveDeferredLookups(rowsByTable, schemas);
    }

    /**
     * Resolve deferred lookups (e.g. filling in FKs from parent rows)
     */
    private resolveDeferredLookups(
        rowsByTable: Map<string, Record<string, any>[]>,
        schemas: TableSchema[]
    ): void {
        for (const [table, rows] of rowsByTable.entries()) {
            for (const row of rows) {
                if (row['__parentLookups'] && row['__parentData']) {
                    const lookups = row['__parentLookups'] as Record<string, string>;
                    const parentData = row['__parentData'] as Record<string, any>;

                    // We need to find the parent table. 
                    // Since we don't explicitly know WHICH table is the parent from the mapping alone (it just says "parent"),
                    // we have to search for a table that has a row matching 'parentData'.
                    // Optimization: The AutoColumnMapper could tell us the parent table name.
                    // For now, let's try to match against ALL other tables (heuristic).
                    // Or better: we know the parent table from the query structure usually.

                    // Let's iterate all other tables and try to find a matching enriched row
                    for (const [parentTable, parentRows] of rowsByTable.entries()) {
                        if (parentTable === table) continue;

                        // Find a row in parentTable that matches parentData on common keys (e.g. device_identifier)
                        // This is fuzzy, but effective for 1:1 or N:1 relationships in the same query result
                        const match = parentRows.find(pRow => {
                            // Check if pRow contains all keys from parentData that are NOT null/undefined
                            // and match the values.
                            // Note: parentData is the RAW result row. pRow is the ENRICHED row.
                            // pRow should be a superset of the relevant parts of parentData.

                            // Heuristic: Match on Unique Keys or just overlap
                            let matchCount = 0;
                            let mismatch = false;

                            for (const [key, val] of Object.entries(parentData)) {
                                if (val !== undefined && val !== null && pRow[key] !== undefined) {
                                    if (String(pRow[key]) === String(val)) {
                                        matchCount++;
                                    } else {
                                        mismatch = true;
                                        break;
                                    }
                                }
                            }
                            return !mismatch && matchCount > 0;
                        });

                        if (match) {
                            // Found the parent row! Perform lookups
                            for (const [childCol, parentCol] of Object.entries(lookups)) {
                                if (match[parentCol] !== undefined) {
                                    row[childCol] = match[parentCol];
                                    // log.debug(`[seed-it] Resolved deferred lookup: ${table}.${childCol} -> ${match[parentCol]} (from ${parentTable}.${parentCol})`);
                                }
                            }
                            break; // Stop looking after finding a match
                        }
                    }

                    // Cleanup internal metadata
                    delete row['__parentLookups'];
                    delete row['__parentData'];
                }
            }
        }
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
                const parentLookups = mapping.parentLookups || {};

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

                        // Add parent lookup metadata (special key starting with __)
                        if (Object.keys(parentLookups).length > 0) {
                            newRow['__parentLookups'] = parentLookups;
                            // Also store reference to parent row index/id if possible, 
                            // but for now we rely on the fact that we are processing a specific query result row
                            // We need to link this newRow to the parent row (which is 'row' here, but 'row' is a raw result row)
                            // The parent row in 'rowsByTable' will be created/enriched separately.
                            // We need a way to link them.
                            // Strategy: Store the raw result row signature or similar?
                            // Simpler: We can't easily link to the *enriched* parent row yet because it doesn't exist.
                            // BUT, we can store the raw values we HAVE (like device_identifier) and use them to find the parent later?
                            // Or, we can do the lookup *during* enrichment if we pass the parent rows?

                            // Let's store the raw parent data we have for matching
                            newRow['__parentData'] = { ...row };
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

                    if (Object.keys(parentLookups).length > 0) {
                        newRow['__parentLookups'] = parentLookups;
                        newRow['__parentData'] = { ...row };
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
     * Extract row data from query result
     */
    private extractRowData(query: CapturedQuery): Record<string, any>[] {
        // If the result contains the inserted rows, use that
        if (query.result && query.result.rows) {
            return query.result.rows;
        }

        // Otherwise, try to parse from the query and params
        // This is a fallback and may not work for all cases
        return this.parseInsertQuery(query.query, query.params);
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
        let columns = Object.keys(row);

        // Filter columns if schema is available to avoid inserting non-existent columns (e.g. from joins)
        if (schema) {
            const validColumns = new Set(schema.columns.map(c => c.columnName));
            columns = columns.filter(col => validColumns.has(col));
        }

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
        queriesOrRows: CapturedQuery[] | Map<string, Record<string, any>[]>,
        schemas: TableSchema[],
        outputDir: string,
        seederName: string = 'initial_data',
        oidMap?: Map<number, string>,
        columnMappings?: Record<string, any>,
        pool?: Pool,
        debugLogger?: any
    ): Promise<string> {
        // ...

        let rowsByTable: Map<string, Record<string, any>[]>;

        if (Array.isArray(queriesOrRows)) {
            // Extract INSERT data from queries
            rowsByTable = await this.extractInserts(queriesOrRows, oidMap, schemas, columnMappings, debugLogger, pool);
        } else {
            // Use provided rows directly
            rowsByTable = queriesOrRows;
        }

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

            // Sort rows if table is self-referencing
            let sortedRows = rows;
            if (schema && selfReferencing.includes(tableName)) {
                sortedRows = this.dependencyResolver.sortRows(tableName, rows, schema);
            }

            for (const row of sortedRows) {
                lines.push(this.generateInsertStatement(tableName, row, schema));
            }

            lines.push('');
            totalRows += rows.length;
        }

        lines.push(`-- Total rows: ${totalRows}`);

        await fs.promises.writeFile(filePath, lines.join('\n'));

        log.info(`[seed-it] Generated seeder: ${fileName} (${totalRows} rows)`);

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
        const rowsByTable = await this.extractInserts(queries, oidMap, schemas);
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

        log.info(`[seed-it] Generated ${files.length} seeder files`);

        return files;
    }
}
