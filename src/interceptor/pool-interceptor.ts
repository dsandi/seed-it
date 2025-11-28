import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { CapturedQuery, CaptureConfig } from '../types';
import { log } from '../utils/logger';

/**
 * Pool interceptor that wraps pg.Pool.query() method
 * This is simpler than intercepting custom methods because we know the signature
 */
export class PoolInterceptor {
    private capturedQueries: CapturedQuery[] = [];
    private config: CaptureConfig;
    private originalQuery: any;
    private pools: WeakMap<Pool, string> = new WeakMap();

    constructor(config: CaptureConfig) {
        this.config = config;
    }

    /**
     * Intercept a pg.Pool instance
     */
    intercept(pool: Pool, databaseName: string): void {
        this.pools.set(pool, databaseName);
        this.originalQuery = pool.query.bind(pool);

        const self = this;

        // Replace pool.query with our interceptor
        pool.query = async function (this: Pool, ...args: any[]) {
            return self.interceptQuery(this, databaseName, args);
        } as any;

        if (this.config.verbose) {
            log.info(`[seed - it] Intercepted pg.Pool for database: ${databaseName} `);
        }
    }

    /**
     * Intercept a single query execution
     */
    private async interceptQuery(pool: Pool, database: string, args: any[]): Promise<any> {
        const startTime = Date.now();

        // pg.Pool.query can be called as:
        // - query(text, values)
        // - query(queryConfig)
        // - query(text, callback)
        // - query(text, values, callback)

        let query: string;
        let params: any[] | undefined;

        if (typeof args[0] === 'string') {
            query = args[0];
            params = Array.isArray(args[1]) ? args[1] : undefined;
        } else if (typeof args[0] === 'object') {
            query = args[0].text;
            params = args[0].values;
        } else {
            // Unknown format, execute without capturing
            return this.originalQuery(...args);
        }

        // Skip if not in configured databases
        if (this.config.databases.length > 0 && !this.config.databases.includes(database)) {
            return this.originalQuery(...args);
        }

        let result: any;
        let error: string | undefined;

        try {
            // Execute the original query
            result = await this.originalQuery(...args);
        } catch (err: any) {
            error = err.message;
            throw err;
        } finally {
            // Capture the query if it matches our criteria
            if (this.shouldCapture(query)) {
                const capturedQuery: CapturedQuery = {
                    query: query.trim(),
                    params,
                    result: error ? undefined : result,
                    timestamp: startTime,
                    database,
                    error,
                    inTransaction: false, // Pool queries don't track transactions
                };

                this.capturedQueries.push(capturedQuery);

                if (this.config.verbose) {
                    log.info(`[seed - it] Captured: ${query.substring(0, 50)}...`);
                }
            }
        }

        return result;
    }

    /**
     * Determine if a query should be captured
     */
    private shouldCapture(query: string): boolean {
        const normalized = query.trim().toUpperCase();

        // Check for reads (SELECT)
        const isRead = normalized.startsWith('SELECT') || normalized.startsWith('WITH');

        // Check for writes
        const writePatterns = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'];
        const isWrite = writePatterns.some(pattern => normalized.startsWith(pattern));

        // Capture based on config
        if (isRead && (this.config.captureReads ?? true)) {
            return true;
        }

        if (isWrite && (this.config.captureWrites ?? false)) {
            return true;
        }

        return false;
    }

    /**
   * Save captured queries to file
   */
    async save(): Promise<void> {
        const outputPath = path.join(this.config.outputDir, 'captured-data.json');

        await fs.promises.mkdir(this.config.outputDir, { recursive: true });

        // For large datasets, write in chunks to avoid OOM
        const CHUNK_SIZE = 1000;
        const totalQueries = this.capturedQueries.length;

        if (totalQueries > CHUNK_SIZE) {
            log.info(`[seed - it] Writing ${totalQueries} queries in chunks...`);

            // Write header
            await fs.promises.writeFile(outputPath, '{\n');
            await fs.promises.appendFile(outputPath, `  "capturedAt": "${new Date().toISOString()}", \n`);
            await fs.promises.appendFile(outputPath, `  "queryCount": ${totalQueries}, \n`);
            await fs.promises.appendFile(outputPath, `  "databases": ${JSON.stringify(this.config.databases)}, \n`);
            await fs.promises.appendFile(outputPath, '  "queries": [\n');

            // Write queries in chunks
            for (let i = 0; i < totalQueries; i += CHUNK_SIZE) {
                const chunk = this.capturedQueries.slice(i, i + CHUNK_SIZE);
                const isLastChunk = i + CHUNK_SIZE >= totalQueries;

                const chunkJson = chunk.map((q, idx) => {
                    const isLastInChunk = idx === chunk.length - 1;
                    const comma = (isLastChunk && isLastInChunk) ? '' : ',';
                    return '    ' + JSON.stringify(q) + comma;
                }).join('\n');

                await fs.promises.appendFile(outputPath, chunkJson + '\n');

                if ((i + CHUNK_SIZE) % 5000 === 0) {
                    log.info(`[seed - it] Wrote ${Math.min(i + CHUNK_SIZE, totalQueries)}/${totalQueries} queries...`);
                }
            }

            // Write footer
            await fs.promises.appendFile(outputPath, '  ]\n');
            await fs.promises.appendFile(outputPath, '}\n');
        } else {
            // Small dataset, write normally
            await fs.promises.writeFile(
                outputPath,
                JSON.stringify(
                    {
                        capturedAt: new Date().toISOString(),
                        queryCount: totalQueries,
                        databases: this.config.databases,
                        queries: this.capturedQueries,
                    },
                    null,
                    2
                )
            );
        }

        log.info(`[seed-it] Saved ${totalQueries} queries to ${outputPath}`);
    }

    /**
     * Get captured queries
     */
    getCapturedQueries(): CapturedQuery[] {
        return this.capturedQueries;
    }

    /**
     * Clear captured queries
     */
    clear(): void {
        this.capturedQueries = [];
    }
}
