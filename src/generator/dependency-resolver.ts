import { TableSchema, DependencyGraph } from '../types';
import { log } from '../utils/logger';

/**
 * Dependency resolver that builds a dependency graph from foreign keys
 * and performs topological sort to determine safe insertion order
 */
export class DependencyResolver {
    /**
     * Build dependency graph from table schemas
     */
    buildGraph(schemas: TableSchema[]): DependencyGraph {
        const nodes = new Set<string>();
        const edges = new Map<string, Set<string>>();

        // Initialize nodes
        for (const schema of schemas) {
            nodes.add(schema.tableName);
            edges.set(schema.tableName, new Set());
        }

        // Add edges based on foreign keys
        for (const schema of schemas) {
            for (const fk of schema.foreignKeys) {
                // If table A has FK to table B, then A depends on B
                // So we need to insert B before A
                if (fk.referencedTable !== schema.tableName) {
                    // Skip self-references for now
                    edges.get(schema.tableName)?.add(fk.referencedTable);
                }
            }
        }

        return { nodes, edges };
    }

    /**
     * Perform topological sort using Kahn's algorithm
     * Returns tables in order they should be populated (dependencies first)
     */
    topologicalSort(graph: DependencyGraph): string[] {
        const sorted: string[] = [];
        const inDegree = new Map<string, number>();
        const adjList = new Map<string, Set<string>>();

        // Initialize in-degree count and adjacency list
        for (const node of graph.nodes) {
            inDegree.set(node, 0);
            adjList.set(node, new Set());
        }

        // Build reverse adjacency list and calculate in-degrees
        for (const [node, dependencies] of graph.edges) {
            for (const dep of dependencies) {
                adjList.get(dep)?.add(node);
                inDegree.set(node, (inDegree.get(node) || 0) + 1);
            }
        }

        // Find all nodes with no incoming edges
        const queue: string[] = [];
        for (const [node, degree] of inDegree) {
            if (degree === 0) {
                queue.push(node);
            }
        }

        // Process queue
        while (queue.length > 0) {
            const node = queue.shift()!;
            sorted.push(node);

            // Reduce in-degree for dependent nodes
            for (const dependent of adjList.get(node) || []) {
                const newDegree = (inDegree.get(dependent) || 0) - 1;
                inDegree.set(dependent, newDegree);

                if (newDegree === 0) {
                    queue.push(dependent);
                }
            }
        }

        // Check for circular dependencies
        if (sorted.length !== graph.nodes.size) {
            const remaining = Array.from(graph.nodes).filter(n => !sorted.includes(n));
            log.warn(`[seed-it] Warning: Circular dependencies detected in tables: ${remaining.join(', ')}`);
            log.warn('[seed-it] These tables will be added at the end. You may need to handle FK constraints manually.');

            // Add remaining tables at the end
            sorted.push(...remaining);
        }

        return sorted;
    }

    /**
     * Detect circular dependencies in the graph
     */
    detectCircularDependencies(graph: DependencyGraph): string[][] {
        const cycles: string[][] = [];
        const visited = new Set<string>();
        const recursionStack = new Set<string>();

        const dfs = (node: string, path: string[]): void => {
            visited.add(node);
            recursionStack.add(node);
            path.push(node);

            const dependencies = graph.edges.get(node) || new Set();
            for (const dep of dependencies) {
                if (!visited.has(dep)) {
                    dfs(dep, [...path]);
                } else if (recursionStack.has(dep)) {
                    // Found a cycle
                    const cycleStart = path.indexOf(dep);
                    const cycle = path.slice(cycleStart);
                    cycle.push(dep); // Complete the cycle
                    cycles.push(cycle);
                }
            }

            recursionStack.delete(node);
        };

        for (const node of graph.nodes) {
            if (!visited.has(node)) {
                dfs(node, []);
            }
        }

        return cycles;
    }

    /**
     * Get tables with self-referencing foreign keys
     */
    getSelfReferencingTables(schemas: TableSchema[]): string[] {
        return schemas
            .filter(schema =>
                schema.foreignKeys.some(fk => fk.referencedTable === schema.tableName)
            )
            .map(schema => schema.tableName);
    }

    /**
     * Resolve insertion order for all tables
     * Returns ordered list of table names
     */
    resolveInsertionOrder(schemas: TableSchema[]): {
        order: string[];
        circularDeps: string[][];
        selfReferencing: string[];
    } {
        const graph = this.buildGraph(schemas);
        const order = this.topologicalSort(graph);
        const circularDeps = this.detectCircularDependencies(graph);
        const selfReferencing = this.getSelfReferencingTables(schemas);

        return {
            order,
            circularDeps,
            selfReferencing,
        };
    }
    /**
     * Sort rows of a table based on self-referencing foreign keys
     */
    sortRows(table: string, rows: any[], schema: TableSchema): any[] {
        // Find self-referencing FKs
        const selfFks = schema.foreignKeys.filter(fk => fk.referencedTable === table);
        if (selfFks.length === 0) {
            return rows;
        }

        // We assume simple hierarchy (one parent pointer) for now
        // If multiple, it's more complex, but usually it's just one (e.g. parent_id)
        const fk = selfFks[0];
        const pk = schema.primaryKeys[0]; // Assume single PK for now

        if (!pk) return rows;

        const rowMap = new Map<any, any>();
        rows.forEach(row => rowMap.set(row[pk], row));

        const visited = new Set<any>();
        const sorted: any[] = [];

        const visit = (row: any) => {
            const id = row[pk];
            if (visited.has(id)) return;
            visited.add(id);

            const parentId = row[fk.columnName];
            if (parentId !== null && parentId !== undefined) {
                // If parent is in the dataset, visit it first
                const parent = rowMap.get(parentId);
                if (parent) {
                    visit(parent);
                }
            }
            sorted.push(row);
        };

        rows.forEach(row => visit(row));

        return sorted;
    }
}
