import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { CapturedQuery, CaptureConfig } from '../types';

/**
 * Client interceptor that wraps pg.Client.query() method
 * Similar to PoolInterceptor but for single Client instances
 */
export class ClientInterceptor {
    private capturedQueries: CapturedQuery[] = [];
    private config: CaptureConfig;
    private originalQuery: any;

    constructor(config: CaptureConfig) {
        this.config = config;
    }

    /**
     * Intercept a pg.Client instance
     */
    intercept(client: Client, databaseName: string): void {
        this.originalQuery = client.query.bind(client);

        const self = this;

        // Replace client.query with our interceptor
        client.query = async function (this: Client, ...args: any[]) {
            return self.interceptQuery(this, databaseName, args);
        } as any;

        if (this.config.verbose) {
            console.log(`[seed-it] Intercepted pg.Client for database: ${databaseName}`);
        }
    }

    /**
     * Intercept a single query execution
     */
    private async interceptQuery(client: Client, database: string, args: any[]): Promise<any> {
        const startTime = Date.now();

        // pg.Client.query has same signature as Pool.query
        let query: string;
        let params: any[] | undefined;

        if (typeof args[0] === 'string') {
            query = args[0];
            params = Array.isArray(args[1]) ? args[1] : undefined;
        } else if (typeof args[0] === 'object') {
            query = args[0].text;
            params = args[0].values;
        } else {
            return this.originalQuery(...args);
        }

        // Skip if not in configured databases
        if (this.config.databases.length > 0 && !this.config.databases.includes(database)) {
            return this.originalQuery(...args);
        }

        let result: any;
        let error: string | undefined;

        try {
            result = await this.originalQuery(...args);
        } catch (err: any) {
            error = err.message;
            throw err;
        } finally {
            if (this.shouldCapture(query)) {
                const capturedQuery: CapturedQuery = {
                    query: query.trim(),
                    params,
                    result: error ? undefined : result,
                    timestamp: startTime,
                    database,
                    error,
                    inTransaction: false,
                };

                this.capturedQueries.push(capturedQuery);

                if (this.config.verbose) {
                    console.log(`[seed-it] Captured: ${query.substring(0, 50)}...`);
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

        const isRead = normalized.startsWith('SELECT') || normalized.startsWith('WITH');
        const writePatterns = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'];
        const isWrite = writePatterns.some(pattern => normalized.startsWith(pattern));

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

        await fs.promises.writeFile(
            outputPath,
            JSON.stringify(
                {
                    capturedAt: new Date().toISOString(),
                    queryCount: this.capturedQueries.length,
                    databases: this.config.databases,
                    queries: this.capturedQueries,
                },
                null,
                2
            )
        );

        console.log(`[seed-it] Saved ${this.capturedQueries.length} queries to ${outputPath}`);
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
