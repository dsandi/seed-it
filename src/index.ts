/**
 * seed-it: Database Traffic Capture & Seeder Generation
 * 
 * Main entry point for programmatic usage
 */

export { PoolInterceptor } from './interceptor/pool-interceptor';
export { ClientInterceptor } from './interceptor/client-interceptor';
export { interceptors } from './interceptor-registry';
export { SchemaAnalyzer } from './analyzer/schema-analyzer';
export { DependencyResolver } from './generator/dependency-resolver';
export { Deduplicator } from './generator/deduplicator';
export { MigrationGenerator } from './generator/migration-generator';
export { SeederGenerator } from './generator/seeder-generator';
export { Config } from './config';

export * from './types';

/**
 * Convenience functions to start capturing
 */
import { CaptureConfig } from './types';

/**
 * Convenience function to capture from pg.Pool instances
 * Automatically registers the interceptor in the global registry
 */
export function startCapturePool(
    pool: any, // pg.Pool instance
    databaseName: string,
    config: Partial<CaptureConfig> = {}
): any {
    const { PoolInterceptor } = require('./interceptor/pool-interceptor');
    const { interceptors } = require('./interceptor-registry');

    const fullConfig: CaptureConfig = {
        outputDir: config.outputDir || './output',
        databases: config.databases || [databaseName],
        captureReads: config.captureReads ?? true,
        captureWrites: config.captureWrites ?? false,
        captureTransactions: config.captureTransactions ?? true,
        verbose: config.verbose ?? false,
    };

    const interceptor = new PoolInterceptor(fullConfig);
    interceptor.intercept(pool, databaseName);

    // Automatically register in global registry
    interceptors.register(databaseName, interceptor);

    return interceptor;
}

/**
 * Convenience function to capture from pg.Client instances
 * Automatically registers the interceptor in the global registry
 */
export function startCaptureClient(
    client: any, // pg.Client instance
    databaseName: string,
    config: Partial<CaptureConfig> = {}
): any {
    const { ClientInterceptor } = require('./interceptor/client-interceptor');
    const { interceptors } = require('./interceptor-registry');

    const fullConfig: CaptureConfig = {
        outputDir: config.outputDir || './output',
        databases: config.databases || [databaseName],
        captureReads: config.captureReads ?? true,
        captureWrites: config.captureWrites ?? false,
        captureTransactions: config.captureTransactions ?? true,
        verbose: config.verbose ?? false,
    };

    const interceptor = new ClientInterceptor(fullConfig);
    interceptor.intercept(client, databaseName);

    // Automatically register in global registry
    interceptors.register(databaseName, interceptor);

    return interceptor;
}
