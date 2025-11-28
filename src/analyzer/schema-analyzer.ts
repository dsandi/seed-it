import { Pool, QueryResult } from 'pg';
import { TableSchema, ColumnInfo, ForeignKeyInfo, IndexInfo, DatabaseConfig } from '../types';

/**
 * Schema analyzer that introspects PostgreSQL database structure
 */
export class SchemaAnalyzer {
  private pool: Pool;
  private schema: string;

  constructor(config: DatabaseConfig) {
    this.schema = config.schema || 'public';
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.name,
      user: config.user,
      password: config.password,
      ssl: config.ssl
    });
  }

  /**
   * Get the database pool for external use
   */
  public getPool(): Pool {
    return this.pool;
  }

  /**
   * Get all base tables in the database (excludes views)
   */
  async getTables(): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [this.schema]);

    return result.rows.map(row => row.table_name);
  }

  /**
   * Get map of table OIDs to table names
   */
  async getTableOids(): Promise<Map<number, string>> {
    const result = await this.pool.query(`
      SELECT oid, relname
      FROM pg_catalog.pg_class
      WHERE relkind = 'r'
        AND relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)
    `, [this.schema]);

    const map = new Map<number, string>();
    result.rows.forEach(row => {
      map.set(row.oid, row.relname);
    });
    return map;
  }

  /**
   * Get all views in the database
   */
  async getViews(): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'VIEW'
      ORDER BY table_name
    `, [this.schema]);

    return result.rows.map(row => row.table_name);
  }

  /**
   * Get view definition (CREATE VIEW statement)
   */
  async getViewDefinition(viewName: string): Promise<string> {
    const result = await this.pool.query(`
      SELECT pg_get_viewdef($1::regclass, true) as definition
    `, [viewName]);

    return result.rows[0]?.definition || '';
  }

  /**
   * Get complete schema for a table
   */
  async getTableSchema(tableName: string): Promise<TableSchema> {
    const [columns, primaryKeys, foreignKeys, indexes] = await Promise.all([
      this.getColumns(tableName),
      this.getPrimaryKeys(tableName),
      this.getForeignKeys(tableName),
      this.getIndexes(tableName),
    ]);

    return {
      tableName,
      columns,
      primaryKeys,
      foreignKeys,
      indexes,
    };
  }

  /**
   * Get all schemas for all tables
   */
  async getAllSchemas(): Promise<TableSchema[]> {
    const tables = await this.getTables();
    return Promise.all(tables.map(table => this.getTableSchema(table)));
  }

  /**
   * Get column information for a table
   */
  private async getColumns(tableName: string): Promise<ColumnInfo[]> {
    const result = await this.pool.query(`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `, [this.schema, tableName]);

    return result.rows.map(row => ({
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      characterMaximumLength: row.character_maximum_length,
      numericPrecision: row.numeric_precision,
      numericScale: row.numeric_scale,
    }));
  }

  /**
   * Get primary key columns for a table
   */
  private async getPrimaryKeys(tableName: string): Promise<string[]> {
    const result = await this.pool.query(`
      SELECT a.attname
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE t.relname = $1
        AND n.nspname = $2
        AND i.indisprimary
      ORDER BY a.attnum
    `, [tableName, this.schema]);

    return result.rows.map(row => row.attname);
  }

  /**
   * Get foreign key constraints for a table
   */
  private async getForeignKeys(tableName: string): Promise<ForeignKeyInfo[]> {
    const result = await this.pool.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
      ORDER BY tc.constraint_name
    `, [this.schema, tableName]);

    return result.rows.map(row => ({
      constraintName: row.constraint_name,
      columnName: row.column_name,
      referencedTable: row.referenced_table,
      referencedColumn: row.referenced_column,
      onDelete: row.delete_rule,
      onUpdate: row.update_rule,
    }));
  }

  /**
   * Get indexes for a table
   */
  private async getIndexes(tableName: string): Promise<IndexInfo[]> {
    const result = await this.pool.query(`
      SELECT
        i.relname AS index_name,
        array_agg(a.attname::text ORDER BY a.attnum) AS columns,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary
      FROM pg_catalog.pg_class t
      JOIN pg_catalog.pg_index ix ON t.oid = ix.indrelid
      JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relkind = 'r'
        AND t.relname = $1
        AND t.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)
      GROUP BY i.relname, ix.indisunique, ix.indisprimary
      ORDER BY i.relname
    `, [tableName, this.schema]);

    return result.rows.map(row => ({
      indexName: row.index_name,
      columns: row.columns,
      isUnique: row.is_unique,
      isPrimary: row.is_primary,
    }));
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
