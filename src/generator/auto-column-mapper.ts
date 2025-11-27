import { CapturedQuery, TableSchema, ForeignKeyInfo, ColumnMapping } from '../types';
import { QueryParser, ParsedQuery } from '../parser/query-parser';

/**
 * Automatically infer column mappings from query structure
 */
export class AutoColumnMapper {
    private parser = new QueryParser();

    /**
     * Infer column mappings for calculated fields
     */
    inferMappings(
        query: CapturedQuery,
        schemas: TableSchema[],
        oidMap: Map<number, string>
    ): Record<string, ColumnMapping> {
        const mappings: Record<string, ColumnMapping> = {};

        if (!query.result || !query.result.fields || !query.result.rows) {
            return mappings;
        }

        // Parse the SQL query
        const parsed = this.parser.parse(query.query);
        if (!parsed) {
            return mappings;
        }

        // Build alias-to-table map
        const aliasMap = this.buildAliasMap(parsed);

        // Check each result field
        for (const field of query.result.fields) {
            // Skip fields with known table IDs
            if (field.tableID && field.tableID !== 0) {
                continue;
            }

            // Find the SELECT column definition
            const selectCol = parsed.selectColumns.find(
                col => col.alias === field.name || col.expression === field.name
            );

            if (!selectCol || !selectCol.isAggregate) {
                continue;
            }

            // Handle array_agg specifically
            if (selectCol.aggregateFunction === 'array_agg' && selectCol.aggregateColumn) {
                const mapping = this.inferArrayAggMapping(
                    selectCol,
                    parsed,
                    aliasMap,
                    schemas
                );

                if (mapping) {
                    mappings[field.name] = mapping;
                }
            }
        }

        return mappings;
    }

    private inferArrayAggMapping(
        selectCol: any,
        parsed: ParsedQuery,
        aliasMap: Map<string, string>,
        schemas: TableSchema[]
    ): ColumnMapping | null {
        // Get the table name from alias
        const tableAlias = selectCol.tableAlias;
        if (!tableAlias) {
            return null;
        }

        const tableName = aliasMap.get(tableAlias);
        if (!tableName) {
            return null;
        }

        const column = selectCol.aggregateColumn;

        // Find the JOIN that references this table
        const join = parsed.joins.find(
            j => j.table.alias === tableAlias || j.table.tableName === tableName
        );

        if (!join) {
            return null;
        }

        // Extract sibling mapping from JOIN condition
        const siblings: Record<string, string> = {};

        // The JOIN condition tells us how tables are related
        // e.g., kcd.main_table_id_fk = kd.id
        // We need to find which column in the main SELECT maps to the FK
        const mainTableAlias = parsed.fromTable.alias || parsed.fromTable.tableName;

        // Determine which side of the JOIN is the foreign key
        let fkColumn: string | undefined;
        let referencedColumn: string | undefined;

        if (join.condition.leftTable === tableAlias) {
            fkColumn = join.condition.leftColumn.split('.')[1];
            referencedColumn = join.condition.rightColumn.split('.')[1];
        } else if (join.condition.rightTable === tableAlias) {
            fkColumn = join.condition.rightColumn.split('.')[1];
            referencedColumn = join.condition.leftColumn.split('.')[1];
        }

        if (!fkColumn || !referencedColumn) {
            return null;
        }

        // Find the SELECT column that corresponds to the referenced column
        for (const col of parsed.selectColumns) {
            if (!col.isAggregate) {
                // Check if this column matches the referenced column
                const colMatch = col.expression.match(/([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)$/i);
                if (colMatch && colMatch[2] === referencedColumn) {
                    const resultColumnName = col.alias || col.expression.split('.').pop() || '';
                    siblings[resultColumnName] = fkColumn;
                    break;
                }
            }
        }

        return {
            table: tableName,
            column,
            type: 'array',
            siblings
        };
    }

    private buildAliasMap(parsed: ParsedQuery): Map<string, string> {
        const map = new Map<string, string>();

        // Add main table
        if (parsed.fromTable.alias) {
            map.set(parsed.fromTable.alias, parsed.fromTable.tableName);
        }
        map.set(parsed.fromTable.tableName, parsed.fromTable.tableName);

        // Add joined tables
        for (const join of parsed.joins) {
            if (join.table.alias) {
                map.set(join.table.alias, join.table.tableName);
            }
            map.set(join.table.tableName, join.table.tableName);
        }

        return map;
    }
}
