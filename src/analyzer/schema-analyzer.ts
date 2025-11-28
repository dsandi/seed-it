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
      SELECT c.relname as table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind = 'r'
      ORDER BY c.relname
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
      SELECT c.relname as table_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind = 'v'
      ORDER BY c.relname
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
  async getTableSchema(tableName: string, allPks?: Map<string, string>): Promise<TableSchema> {
    const [columns, primaryKeys, foreignKeys, indexes] = await Promise.all([
      this.getColumns(tableName),
      this.getPrimaryKeys(tableName),
      this.getForeignKeys(tableName),
      this.getIndexes(tableName),
    ]);

    // Infer virtual foreign keys if we have knowledge of other tables' PKs
    if (allPks) {
      const virtualFks = this.inferVirtualForeignKeys(tableName, columns, foreignKeys, allPks);
      if (virtualFks.length > 0) {
        // Merge virtual FKs, avoiding duplicates
        for (const vfk of virtualFks) {
          if (!foreignKeys.some(fk => fk.columnName === vfk.columnName)) {
            foreignKeys.push(vfk);
          }
        }
      }
    }

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

    // Prefetch all PKs for virtual FK inference
    const allPks = await this.getAllPrimaryKeys();

    return Promise.all(tables.map(table => this.getTableSchema(table, allPks)));
  }

  /**
   * Get Primary Keys for all tables in the schema
   * Returns a map of TableName -> PrimaryKeyColumnName
   * Assumes single-column PKs for the heuristic (or takes the first one)
   */
  private async getAllPrimaryKeys(): Promise<Map<string, string>> {
    const result = await this.pool.query(`
      SELECT t.relname AS table_name, a.attname AS pk_column
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname = $1
        AND i.indisprimary
      ORDER BY t.relname, a.attnum
    `, [this.schema]);

    const pks = new Map<string, string>();
    // If composite PK, this will just take the last one visited, but we filter for single PKs mostly
    // For the heuristic, we just need *a* PK to match against.
    // Better: Store all PKs? For now, 1:1 map is simpler for the "contains" check.
    // Actually, let's just store the first PK column found for each table.
    const seen = new Set<string>();

    for (const row of result.rows) {
      if (!seen.has(row.table_name)) {
        pks.set(row.table_name, row.pk_column);
        seen.add(row.table_name);
      }
    }
    return pks;
  }

  /**
   * Infer Virtual Foreign Keys based on naming conventions
   */
  private inferVirtualForeignKeys(
    tableName: string,
    columns: ColumnInfo[],
    existingFks: ForeignKeyInfo[],
    allPks: Map<string, string>
  ): ForeignKeyInfo[] {
    const virtualFks: ForeignKeyInfo[] = [];
    const existingFkColumns = new Set(existingFks.map(fk => fk.columnName));

    for (const col of columns) {
      // Skip if already a real FK
      if (existingFkColumns.has(col.columnName)) continue;

      // Skip if it's the table's own PK (usually) - though self-referencing is possible
      // We don't have this table's PKs passed in easily here without looking at `primaryKeys` array from caller
      // but usually a column named `parent_id` is fine.

      // Heuristic: Check if column name contains the PK name of another table
      for (const [targetTable, targetPk] of allPks.entries()) {
        if (targetTable === tableName) {
          // Handle self-reference: e.g. san_san_pk_parent -> san_pk
          // If column contains targetPk AND is not the targetPk itself (to avoid mapping PK to itself)
          if (col.columnName !== targetPk && col.columnName.includes(targetPk)) {
            virtualFks.push({
              constraintName: `virtual_fk_${tableName}_${col.columnName}`,
              columnName: col.columnName,
              referencedTable: targetTable,
              referencedColumn: targetPk,
              onDelete: 'NO ACTION',
              onUpdate: 'NO ACTION'
            });
            break; // Found a match, stop looking for other tables
          }
          continue;
        }

        // Normal FK: Column name contains target PK (e.g. fam_pk_fk contains fam_pk)
        // Strict check: 
        // 1. Exact match (mea_pk -> mea_pk)
        // 2. Suffix/Prefix match with underscore (fam_pk_fk -> fam_pk)
        // Avoid partial matches like "user_id" matching "user_identity" table? 
        // The user's convention is very specific: `_pk`.

        if (col.columnName === targetPk ||
          col.columnName.includes(`_${targetPk}`) ||
          col.columnName.includes(`${targetPk}_`)) {

          virtualFks.push({
            constraintName: `virtual_fk_${tableName}_${col.columnName}`,
            columnName: col.columnName,
            referencedTable: targetTable,
            referencedColumn: targetPk,
            onDelete: 'NO ACTION',
            onUpdate: 'NO ACTION'
          });
          break; // Found a match
        }
      }
    }

    return virtualFks;
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
