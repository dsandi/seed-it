import * as fs from 'fs';
import * as path from 'path';
import { TableSchema } from '../types';

/**
 * Migration generator that creates DDL migration files
 */
export class MigrationGenerator {
    /**
     * Generate CREATE TABLE statement for a table
     */
    private generateCreateTable(schema: TableSchema): string {
        const lines: string[] = [];
        lines.push(`CREATE TABLE ${schema.tableName} (`);

        // Add columns
        const columnDefs = schema.columns.map(col => {
            const parts: string[] = [`  ${col.columnName} ${this.mapDataType(col)}`];

            if (!col.isNullable) {
                parts.push('NOT NULL');
            }

            if (col.defaultValue) {
                parts.push(`DEFAULT ${col.defaultValue}`);
            }

            return parts.join(' ');
        });

        lines.push(columnDefs.join(',\n'));

        // Add primary key constraint
        if (schema.primaryKeys.length > 0) {
            lines.push(`,\n  PRIMARY KEY (${schema.primaryKeys.join(', ')})`);
        }

        lines.push(');');

        return lines.join('\n');
    }

    /**
     * Map column data type with precision/length
     */
    private mapDataType(col: any): string {
        let dataType = col.dataType.toUpperCase();

        if (col.characterMaximumLength) {
            dataType += `(${col.characterMaximumLength})`;
        } else if (col.numericPrecision && col.numericScale !== null) {
            dataType += `(${col.numericPrecision}, ${col.numericScale})`;
        } else if (col.numericPrecision) {
            dataType += `(${col.numericPrecision})`;
        }

        return dataType;
    }

    /**
     * Generate ALTER TABLE statements for foreign keys
     */
    private generateForeignKeys(schema: TableSchema): string[] {
        return schema.foreignKeys.map(fk => {
            const parts = [
                `ALTER TABLE ${schema.tableName}`,
                `ADD CONSTRAINT ${fk.constraintName}`,
                `FOREIGN KEY (${fk.columnName})`,
                `REFERENCES ${fk.referencedTable}(${fk.referencedColumn})`,
            ];

            if (fk.onDelete && fk.onDelete !== 'NO ACTION') {
                parts.push(`ON DELETE ${fk.onDelete}`);
            }

            if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') {
                parts.push(`ON UPDATE ${fk.onUpdate}`);
            }

            return parts.join(' ') + ';';
        });
    }

    /**
     * Generate CREATE INDEX statements
     */
    private generateIndexes(schema: TableSchema): string[] {
        return schema.indexes
            .filter(idx => !idx.isPrimary) // Skip primary key indexes
            .map(idx => {
                const unique = idx.isUnique ? 'UNIQUE ' : '';
                return `CREATE ${unique}INDEX ${idx.indexName} ON ${schema.tableName} (${idx.columns.join(', ')});`;
            });
    }

    /**
   * Generate complete migration file (up)
   */
    async generateMigration(
        schemas: TableSchema[],
        views: { name: string; definition: string }[],
        outputDir: string,
        migrationName: string = 'initial_schema'
    ): Promise<{ upFile: string; downFile: string }> {
        const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
        const fileName = `${timestamp}_${migrationName}`;

        const upFile = path.join(outputDir, 'migrations', `${fileName}.up.sql`);
        const downFile = path.join(outputDir, 'migrations', `${fileName}.down.sql`);

        // Ensure directory exists
        await fs.promises.mkdir(path.dirname(upFile), { recursive: true });

        // Generate UP migration
        const upLines: string[] = [];
        upLines.push(`-- Migration: ${migrationName}`);
        upLines.push(`-- Generated: ${new Date().toISOString()}`);
        upLines.push('');

        // Create tables first
        upLines.push('-- Tables');
        for (const schema of schemas) {
            upLines.push(`-- Table: ${schema.tableName}`);
            upLines.push(this.generateCreateTable(schema));
            upLines.push('');
        }

        // Add foreign keys
        upLines.push('-- Foreign Keys');
        for (const schema of schemas) {
            const fks = this.generateForeignKeys(schema);
            if (fks.length > 0) {
                upLines.push(...fks);
            }
        }
        upLines.push('');

        // Add indexes
        upLines.push('-- Indexes');
        for (const schema of schemas) {
            const indexes = this.generateIndexes(schema);
            if (indexes.length > 0) {
                upLines.push(...indexes);
            }
        }
        upLines.push('');

        // Add views (after tables are created)
        if (views.length > 0) {
            upLines.push('-- Views');
            for (const view of views) {
                upLines.push(`-- View: ${view.name}`);
                upLines.push(`CREATE VIEW ${view.name} AS`);
                upLines.push(view.definition);
                upLines.push('');
            }
        }

        await fs.promises.writeFile(upFile, upLines.join('\n'));

        // Generate DOWN migration (reverse order)
        const downLines: string[] = [];
        downLines.push(`-- Rollback: ${migrationName}`);
        downLines.push(`-- Generated: ${new Date().toISOString()}`);
        downLines.push('');

        // Drop views first (before tables)
        if (views.length > 0) {
            downLines.push('-- Drop Views');
            for (let i = views.length - 1; i >= 0; i--) {
                downLines.push(`DROP VIEW IF EXISTS ${views[i].name} CASCADE;`);
            }
            downLines.push('');
        }

        // Drop tables in reverse order
        downLines.push('-- Drop Tables');
        for (let i = schemas.length - 1; i >= 0; i--) {
            downLines.push(`DROP TABLE IF EXISTS ${schemas[i].tableName} CASCADE;`);
        }

        await fs.promises.writeFile(downFile, downLines.join('\n'));

        console.log(`[seed-it] Generated migration: ${fileName}`);
        if (views.length > 0) {
            console.log(`[seed-it] Included ${views.length} views`);
        }

        return { upFile, downFile };
    }
}
