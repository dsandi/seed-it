import { CapturedQuery } from '../types';

/**
 * Parsed SQL query structure
 */
export interface ParsedQuery {
    selectColumns: SelectColumn[];
    fromTable: TableReference;
    joins: JoinClause[];
    groupBy: string[];
}

export interface SelectColumn {
    expression: string;      // Full expression (e.g., "array_agg(kcd.ref_id)")
    alias?: string;          // AS alias (e.g., "categories")
    isAggregate: boolean;
    aggregateFunction?: string;  // e.g., "array_agg"
    aggregateColumn?: string;    // e.g., "ref_id"
    tableAlias?: string;         // e.g., "kcd"
    // Support for CASE with multiple branches
    caseAggregates?: Array<{
        branch: 'THEN' | 'ELSE';
        aggregateFunction: string;
        aggregateColumn: string;
        tableAlias?: string;
        isSubquery: boolean;
        subqueryTable?: string;  // For THEN subqueries
    }>;
}

export interface TableReference {
    tableName: string;
    alias?: string;
}

export interface JoinClause {
    type: string;           // LEFT, INNER, etc.
    table: TableReference;
    condition: JoinCondition;
}

export interface JoinCondition {
    leftColumn: string;     // e.g., "kcd.main_table_id_fk"
    rightColumn: string;    // e.g., "kd.id"
    leftTable?: string;
    rightTable?: string;
}

/**
 * Simple SQL query parser for extracting structure
 */
export class QueryParser {
    /**
     * Parse a SELECT query to extract structure
     */
    parse(query: string): ParsedQuery | null {
        try {
            const normalized = query.trim().replace(/\s+/g, ' ');

            return {
                selectColumns: this.parseSelectColumns(normalized),
                fromTable: this.parseFromClause(normalized),
                joins: this.parseJoins(normalized),
                groupBy: this.parseGroupBy(normalized)
            };
        } catch (e) {
            return null;
        }
    }

    private parseSelectColumns(query: string): SelectColumn[] {
        // Find SELECT keyword
        const selectIndex = query.search(/SELECT\s+/i);
        if (selectIndex === -1) return [];

        // Find the main FROM clause (not one inside a subquery)
        // We need to track parentheses depth to avoid matching FROM inside subqueries
        let fromIndex = -1;
        let depth = 0;
        const fromRegex = /FROM\s+/gi;
        let match;

        while ((match = fromRegex.exec(query)) !== null) {
            // Count parentheses between SELECT and this FROM
            const textBetween = query.substring(selectIndex, match.index);
            depth = 0;
            for (const char of textBetween) {
                if (char === '(') depth++;
                else if (char === ')') depth--;
            }

            // If we're at depth 0, this is the main FROM
            if (depth === 0) {
                fromIndex = match.index;
                break;
            }
        }

        if (fromIndex === -1) return [];

        // Extract columns string between SELECT and FROM
        const columnsStr = query.substring(selectIndex + 6, fromIndex).trim(); // +6 for "SELECT"
        const columns: SelectColumn[] = [];

        // Split by comma, but respect parentheses
        const parts = this.splitByComma(columnsStr);

        for (const part of parts) {
            const trimmed = part.trim();

            // Check for alias (AS keyword or space)
            const aliasMatch = trimmed.match(/^(.+?)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)$/i);
            const expression = aliasMatch ? aliasMatch[1].trim() : trimmed;
            const alias = aliasMatch ? aliasMatch[2] : undefined;

            // Check for CASE statement containing aggregates
            if (expression.match(/CASE/i)) {
                const caseAggregates: Array<{
                    branch: 'THEN' | 'ELSE';
                    aggregateFunction: string;
                    aggregateColumn: string;
                    tableAlias?: string;
                    isSubquery: boolean;
                    subqueryTable?: string;
                }> = [];

                // Parse THEN branch (may contain subquery with aggregate)
                const thenMatch = expression.match(/THEN\s+\(?\s*SELECT\s+(array_agg|count|sum|avg|min|max)\s*\((?:DISTINCT\s+)?([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)/is);
                if (thenMatch) {
                    // Extract FROM clause from subquery to get table name
                    // Look for FROM between THEN and ELSE (or END if no ELSE)
                    const thenSection = expression.match(/THEN\s+\([^)]*\)/is)?.[0] || expression.match(/THEN\s+.*?(?=ELSE|END)/is)?.[0] || '';
                    const fromMatch = thenSection.match(/FROM\s+([a-z_][a-z0-9_]*)(?:\s+([a-z_][a-z0-9_]*))?/i);
                    caseAggregates.push({
                        branch: 'THEN',
                        aggregateFunction: thenMatch[1].toLowerCase(),
                        aggregateColumn: thenMatch[3],
                        tableAlias: thenMatch[2],
                        isSubquery: true,
                        subqueryTable: fromMatch ? fromMatch[1] : undefined
                    });
                }

                // Parse ELSE branch (direct aggregate)
                const elseMatch = expression.match(/ELSE\s+(array_agg|count|sum|avg|min|max)\s*\((?:DISTINCT\s+)?([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)/is);
                if (elseMatch) {
                    caseAggregates.push({
                        branch: 'ELSE',
                        aggregateFunction: elseMatch[1].toLowerCase(),
                        aggregateColumn: elseMatch[3],
                        tableAlias: elseMatch[2],
                        isSubquery: false
                    });
                }

                if (caseAggregates.length > 0) {
                    // Use the first aggregate's info for backward compatibility
                    const primary = caseAggregates[0];
                    columns.push({
                        expression,
                        alias,
                        isAggregate: true,
                        aggregateFunction: primary.aggregateFunction,
                        aggregateColumn: primary.aggregateColumn,
                        tableAlias: primary.tableAlias,
                        caseAggregates
                    });
                    continue;
                }
            }

            // Check for aggregate function
            const aggMatch = expression.match(/^(array_agg|count|sum|avg|min|max)\s*\((.+)\)/i);

            if (aggMatch) {
                const func = aggMatch[1].toLowerCase();
                const arg = aggMatch[2].trim();

                // Extract table alias and column
                const colMatch = arg.match(/^([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)$/i);

                columns.push({
                    expression,
                    alias,
                    isAggregate: true,
                    aggregateFunction: func,
                    aggregateColumn: colMatch ? colMatch[2] : arg,
                    tableAlias: colMatch ? colMatch[1] : undefined
                });
            } else {
                columns.push({
                    expression,
                    alias,
                    isAggregate: false
                });
            }
        }

        return columns;
    }

    private parseFromClause(query: string): TableReference {
        const fromMatch = query.match(/FROM\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/i);

        if (!fromMatch) {
            return { tableName: '' };
        }

        return {
            tableName: fromMatch[1],
            alias: fromMatch[2]
        };
    }

    private parseJoins(query: string): JoinClause[] {
        const joins: JoinClause[] = [];
        const joinRegex = /(LEFT|RIGHT|INNER|OUTER|CROSS)?\s*JOIN\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?\s+ON\s+(.+?)(?=\s+(?:LEFT|RIGHT|INNER|OUTER|CROSS)?\s*JOIN|\s+WHERE|\s+GROUP|\s+ORDER|\s+LIMIT|$)/gi;

        let match;
        while ((match = joinRegex.exec(query)) !== null) {
            const type = match[1] || 'INNER';
            const tableName = match[2];
            const alias = match[3];
            const conditionStr = match[4].trim();

            // Parse ON condition (simple equality)
            const condMatch = conditionStr.match(/([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*=\s*([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/i);

            if (condMatch) {
                const leftParts = condMatch[1].split('.');
                const rightParts = condMatch[2].split('.');

                joins.push({
                    type,
                    table: { tableName, alias },
                    condition: {
                        leftColumn: condMatch[1],
                        rightColumn: condMatch[2],
                        leftTable: leftParts[0],
                        rightTable: rightParts[0]
                    }
                });
            }
        }

        return joins;
    }

    private parseGroupBy(query: string): string[] {
        const groupMatch = query.match(/GROUP\s+BY\s+(.+?)(?=\s+ORDER|\s+HAVING|\s+LIMIT|;|$)/i);
        if (!groupMatch) return [];

        return groupMatch[1].split(',').map(col => col.trim());
    }

    private splitByComma(str: string): string[] {
        const parts: string[] = [];
        let current = '';
        let parenDepth = 0;
        let caseDepth = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];
            const remaining = str.substring(i);

            // Check for CASE keyword (start of CASE expression)
            if (remaining.match(/^CASE\s/i)) {
                caseDepth++;
            }

            // Check for END keyword (end of CASE expression)
            // Make sure it's not part of another word like "APPEND"
            if (remaining.match(/^END(?:\s|$|,)/i) && caseDepth > 0) {
                caseDepth--;
            }

            if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            } else if (char === ',' && parenDepth === 0 && caseDepth === 0) {
                parts.push(current);
                current = '';
                continue;
            }

            current += char;
        }

        if (current) {
            parts.push(current);
        }

        return parts;
    }
}
