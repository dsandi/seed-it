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
        const selectMatch = query.match(/SELECT\s+(.+?)\s+FROM/i);
        if (!selectMatch) return [];

        const columnsStr = selectMatch[1];
        const columns: SelectColumn[] = [];

        // Split by comma, but respect parentheses
        const parts = this.splitByComma(columnsStr);

        for (const part of parts) {
            const trimmed = part.trim();

            // Check for alias (AS keyword or space)
            const aliasMatch = trimmed.match(/^(.+?)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)$/i);
            const expression = aliasMatch ? aliasMatch[1].trim() : trimmed;
            const alias = aliasMatch ? aliasMatch[2] : undefined;

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
        let depth = 0;

        for (let i = 0; i < str.length; i++) {
            const char = str[i];

            if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
            } else if (char === ',' && depth === 0) {
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
