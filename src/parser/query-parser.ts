import { CapturedQuery } from '../types';
import { parse, SelectStatement, Expr, ExprRef, Statement } from 'pgsql-ast-parser';

/**
 * Parsed SQL query structure
 */
export interface ParsedQuery {
    selectColumns: SelectColumn[];
    fromTable: TableReference;
    joins: JoinClause[];
    groupBy: string[];
    whereConditions: WhereCondition[];
    paramMappings: ParamMapping[];
}

export interface SelectColumn {
    expression: string;
    alias?: string;
    isAggregate: boolean;
    aggregateFunction?: string;
    aggregateColumn?: string;
    tableAlias?: string;
    caseAggregates?: Array<{
        branch: 'THEN' | 'ELSE';
        aggregateFunction: string;
        aggregateColumn: string;
        tableAlias?: string;
        isSubquery: boolean;
        subqueryTable?: string;
    }>;
}

export interface TableReference {
    tableName: string;
    alias?: string;
}

export interface JoinClause {
    type: string;
    table: TableReference;
    condition: JoinCondition;
}

export interface JoinCondition {
    leftColumn: string;
    rightColumn: string;
    leftTable?: string;
    rightTable?: string;
}

export interface WhereCondition {
    column: string;
    table?: string;
    operator: string;
    value?: any;
    paramIndex?: number;
}

export interface ParamMapping {
    column: string;
    table?: string;
    paramIndex: number;
    operator: string;
}

/**
 * SQL query parser using pgsql-ast-parser
 */
export class QueryParser {
    parse(query: string): ParsedQuery | null {
        try {
            const ast = parse(query);
            if (!ast || ast.length === 0) return null;

            const stmt = ast[0];
            if (stmt.type !== 'select') return null;

            const selectStmt = stmt as SelectStatement;

            // Type guard: SelectStatement can be SelectFromStatement or SelectFromUnion
            if (!('columns' in selectStmt)) {
                // It's a UNION, not supported yet
                return null;
            }

            return {
                selectColumns: this.extractSelectColumns(selectStmt),
                fromTable: this.extractFromTable(selectStmt),
                joins: this.extractJoins(selectStmt),
                groupBy: this.extractGroupBy(selectStmt),
                whereConditions: this.extractWhereConditions(selectStmt),
                paramMappings: this.extractParamMappings(selectStmt)
            };
        } catch (error) {
            console.error('Failed to parse query with AST parser:', error);
            // Return null to indicate parsing failure
            return null;
        }
    }

    private extractSelectColumns(stmt: any): SelectColumn[] {
        const columns: SelectColumn[] = [];

        if (!stmt.columns || stmt.columns.length === 0) return columns;

        for (const col of stmt.columns) {
            if (col.expr.type === 'ref') {
                // Simple column reference
                columns.push({
                    expression: this.exprToString(col.expr),
                    alias: col.alias?.name,
                    isAggregate: false
                });
            } else if (col.expr.type === 'call') {
                // Function call (potentially aggregate)
                const funcName = col.expr.function.name.toLowerCase();
                const isAgg = ['array_agg', 'count', 'sum', 'avg', 'min', 'max'].includes(funcName);

                columns.push({
                    expression: this.exprToString(col.expr),
                    alias: col.alias?.name,
                    isAggregate: isAgg,
                    aggregateFunction: isAgg ? funcName : undefined,
                    ...this.extractAggregateDetails(col.expr)
                });
            } else if (col.expr.type === 'case') {
                // CASE expression
                const caseCol = this.parseCaseExpression(col.expr);
                columns.push({
                    ...caseCol,
                    alias: col.alias?.name
                });
            } else {
                // Other expressions
                columns.push({
                    expression: this.exprToString(col.expr),
                    alias: col.alias?.name,
                    isAggregate: false
                });
            }
        }

        return columns;
    }

    private parseCaseExpression(caseExpr: any): SelectColumn {
        const caseAggregates: any[] = [];

        // Parse WHEN/THEN branches
        if (caseExpr.whens) {
            for (const when of caseExpr.whens) {
                if (when.value && when.value.type === 'call') {
                    const funcName = when.value.function.name.toLowerCase();
                    if (['array_agg', 'count', 'sum', 'avg', 'min', 'max'].includes(funcName)) {
                        const details = this.extractAggregateDetails(when.value);
                        caseAggregates.push({
                            branch: 'THEN',
                            aggregateFunction: funcName,
                            aggregateColumn: details.aggregateColumn,
                            tableAlias: details.tableAlias,
                            isSubquery: false
                        });
                    }
                } else if (when.value && when.value.type === 'select') {
                    // Subquery in THEN
                    const subquery = when.value as any;  // Cast to any to handle union types
                    if (subquery.columns && subquery.columns[0]) {
                        const firstCol = subquery.columns[0];
                        if (firstCol.expr.type === 'call') {
                            const funcName = firstCol.expr.function.name.toLowerCase();
                            const details = this.extractAggregateDetails(firstCol.expr);
                            const fromTable = this.extractFromTable(subquery);

                            caseAggregates.push({
                                branch: 'THEN',
                                aggregateFunction: funcName,
                                aggregateColumn: details.aggregateColumn,
                                tableAlias: details.tableAlias,
                                isSubquery: true,
                                subqueryTable: fromTable.tableName
                            });
                        }
                    }
                }
            }
        }

        // Parse ELSE branch
        if (caseExpr.else && caseExpr.else.type === 'call') {
            const funcName = caseExpr.else.function.name.toLowerCase();
            if (['array_agg', 'count', 'sum', 'avg', 'min', 'max'].includes(funcName)) {
                const details = this.extractAggregateDetails(caseExpr.else);
                caseAggregates.push({
                    branch: 'ELSE',
                    aggregateFunction: funcName,
                    aggregateColumn: details.aggregateColumn,
                    tableAlias: details.tableAlias,
                    isSubquery: false
                });
            }
        }

        // Use first aggregate for backward compatibility
        const primary = caseAggregates[0] || {};

        return {
            expression: this.exprToString(caseExpr),
            isAggregate: caseAggregates.length > 0,
            aggregateFunction: primary.aggregateFunction,
            aggregateColumn: primary.aggregateColumn,
            tableAlias: primary.tableAlias,
            caseAggregates: caseAggregates.length > 0 ? caseAggregates : undefined
        };
    }

    private extractAggregateDetails(callExpr: any): { aggregateColumn?: string; tableAlias?: string } {
        if (!callExpr.args || callExpr.args.length === 0) {
            return {};
        }

        const firstArg = callExpr.args[0];

        if (firstArg.type === 'ref') {
            return {
                aggregateColumn: firstArg.name,
                tableAlias: firstArg.table?.name
            };
        }

        return {};
    }

    private extractFromTable(stmt: any): TableReference {
        if (!stmt.from || stmt.from.length === 0) {
            return { tableName: '' };
        }

        const from = stmt.from[0];

        if (from.type === 'table') {
            return {
                tableName: from.name.name,
                alias: from.name.alias
            };
        }

        return { tableName: '' };
    }

    private extractJoins(stmt: any): JoinClause[] {
        const joins: JoinClause[] = [];

        if (!stmt.from || stmt.from.length === 0) return joins;

        // In pgsql-ast-parser, JOINs appear as subsequent elements in the from array
        // The first element is the main table, subsequent elements with 'join' property are joins
        for (let i = 1; i < stmt.from.length; i++) {
            const fromItem = stmt.from[i];

            if (fromItem.type === 'table' && fromItem.join) {
                const joinType = fromItem.join.type || 'INNER';
                const condition = this.extractJoinCondition(fromItem.join.on);

                joins.push({
                    type: joinType.toUpperCase(),
                    table: {
                        tableName: fromItem.name?.name || fromItem.name || '',
                        alias: fromItem.name?.alias || fromItem.alias
                    },
                    condition
                });
            }
        }

        return joins;
    }

    private extractJoinRecursive(joinItem: any, joins: JoinClause[]): void {
        // This method is no longer needed with the new structure
        // Keeping it for backward compatibility but it won't be called
        if (!joinItem) return;

        const joinType = joinItem.type || 'INNER';

        if (joinItem.from && joinItem.from.type === 'table') {
            const condition = this.extractJoinCondition(joinItem.on);

            joins.push({
                type: joinType.toUpperCase(),
                table: {
                    tableName: joinItem.from.name?.name || joinItem.from.name || '',
                    alias: joinItem.from.name?.alias || joinItem.from.alias
                },
                condition
            });
        }

        if (joinItem.join) {
            this.extractJoinRecursive(joinItem.join, joins);
        }
    }

    private extractJoinCondition(onExpr: any): JoinCondition {
        if (!onExpr || onExpr.type !== 'binary') {
            return { leftColumn: '', rightColumn: '' };
        }

        const left = onExpr.left;
        const right = onExpr.right;

        return {
            leftColumn: this.exprToString(left),
            rightColumn: this.exprToString(right),
            leftTable: left.type === 'ref' ? left.table?.name : undefined,
            rightTable: right.type === 'ref' ? right.table?.name : undefined
        };
    }

    private extractGroupBy(stmt: any): string[] {
        if (!stmt.groupBy) return [];

        return stmt.groupBy.map((expr: any) => this.exprToString(expr));
    }

    private extractWhereConditions(stmt: any): WhereCondition[] {
        const conditions: WhereCondition[] = [];

        if (!stmt.where) return conditions;

        this.walkExpr(stmt.where, (expr) => {
            if (expr.type === 'binary' && expr.operator === '=') {
                const left = expr.left;
                const right = expr.right;

                if (left.type === 'ref') {
                    const condition: WhereCondition = {
                        column: left.name,
                        table: left.table?.name,
                        operator: '='
                    };

                    if (right.type === 'parameter') {
                        condition.paramIndex = right.name ? parseInt(right.name) : undefined;
                    } else if (right.type === 'integer' || right.type === 'string' || right.type === 'boolean') {
                        condition.value = right.value;
                    }

                    conditions.push(condition);
                }
            }
        });

        return conditions;
    }

    private extractParamMappings(stmt: any): ParamMapping[] {
        const mappings: ParamMapping[] = [];

        if (!stmt.where) return mappings;

        this.walkExpr(stmt.where, (expr) => {
            if (expr.type === 'binary') {
                const left = expr.left;
                const right = expr.right;

                if (left.type === 'ref' && right.type === 'parameter') {
                    // Parse parameter name like "$1" to get index 1
                    const paramName = right.name || '';
                    const paramIndex = paramName.startsWith('$')
                        ? parseInt(paramName.substring(1), 10)
                        : 0;

                    mappings.push({
                        column: left.name,
                        table: left.table?.name,
                        paramIndex,
                        operator: expr.op || expr.operator
                    });
                }
            }
        });

        return mappings;
    }

    private walkExpr(expr: any, callback: (expr: any) => void): void {
        if (!expr) return;

        callback(expr);

        // Recursively walk sub-expressions
        if (expr.left) this.walkExpr(expr.left, callback);
        if (expr.right) this.walkExpr(expr.right, callback);
        if (expr.operands) {
            for (const operand of expr.operands) {
                this.walkExpr(operand, callback);
            }
        }
    }

    private exprToString(expr: any): string {
        if (!expr) return '';

        switch (expr.type) {
            case 'ref':
                return expr.table ? `${expr.table.name}.${expr.name}` : expr.name;
            case 'integer':
            case 'string':
            case 'boolean':
                return String(expr.value);
            case 'parameter':
                return `$${expr.name || '?'}`;
            case 'call':
                const args = expr.args ? expr.args.map((a: any) => this.exprToString(a)).join(', ') : '';
                return `${expr.function.name}(${args})`;
            case 'binary':
                return `${this.exprToString(expr.left)} ${expr.operator} ${this.exprToString(expr.right)}`;
            default:
                return JSON.stringify(expr);
        }
    }
}
