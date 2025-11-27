/**
 * Core type definitions for seed-it
 */

export interface CapturedQuery {
    query: string;
    params?: any[];
    result?: any;
    timestamp: number;
    database: string;
    error?: string;
    inTransaction?: boolean;
    transactionId?: string;
}

export interface TableSchema {
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
    foreignKeys: ForeignKeyInfo[];
    indexes: IndexInfo[];
}

export interface ColumnInfo {
    columnName: string;
    dataType: string;
    isNullable: boolean;
    defaultValue?: string;
    characterMaximumLength?: number;
    numericPrecision?: number;
    numericScale?: number;
}

export interface ForeignKeyInfo {
    constraintName: string;
    columnName: string;
    referencedTable: string;
    referencedColumn: string;
    onDelete?: string;
    onUpdate?: string;
}

export interface IndexInfo {
    indexName: string;
    columns: string[];
    isUnique: boolean;
    isPrimary: boolean;
}

export interface DatabaseConfig {
    host: string;
    port: number;
    name: string;
    user: string;
    password?: string;
    ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; key?: string; cert?: string };
}

export interface Config {
    databases?: DatabaseConfig[]; // Array of database configs
    database?: DatabaseConfig;    // Legacy single database config
    generate?: GeneratorConfig;
}

export interface SeederRow {
    table: string;
    data: Record<string, any>;
    hash: string; // for deduplication
}

export interface DependencyGraph {
    nodes: Set<string>; // table names
    edges: Map<string, Set<string>>; // table -> dependencies
}

export interface CaptureConfig {
    outputDir: string;
    databases: string[];
    captureReads?: boolean; // default: true for seeders (capture SELECTs)
    captureWrites?: boolean; // default: false (don't need INSERTs for seeders)
    captureTransactions?: boolean; // default: true
    verbose?: boolean;
    parameterMap?: {
        // Map parameter positions: which arg is database, query, params
        database: number; // e.g., 0 means first parameter
        query: number;    // e.g., 1 means second parameter
        params: number;   // e.g., 2 means third parameter
    };
}

export interface GeneratorConfig {
    inputFile: string;
    outputDir: string;
    migrationName?: string;
    deduplicateRows?: boolean; // default: true
    handleCircularDeps?: boolean; // default: true
}

export interface MigrationConfig {
    migrationsDir: string;
    connectionConfig: any;
    tableName?: string; // default: 'schema_migrations'
}
