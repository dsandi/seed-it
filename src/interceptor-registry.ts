import { PoolInterceptor } from './interceptor/pool-interceptor';
import { ClientInterceptor } from './interceptor/client-interceptor';

/**
 * Global registry for interceptors
 * Allows accessing interceptors from anywhere in your test suite
 */
class InterceptorRegistry {
    private interceptors: Map<string, PoolInterceptor | ClientInterceptor> = new Map();

    /**
     * Register an interceptor with a name
     */
    register(name: string, interceptor: PoolInterceptor | ClientInterceptor): void {
        this.interceptors.set(name, interceptor);
    }

    /**
     * Get an interceptor by name
     */
    get(name: string): PoolInterceptor | ClientInterceptor | undefined {
        return this.interceptors.get(name);
    }

    /**
     * Get all registered interceptors
     */
    getAll(): (PoolInterceptor | ClientInterceptor)[] {
        return Array.from(this.interceptors.values());
    }

    /**
     * Get all captured queries from all interceptors
     */
    getAllQueries() {
        return this.getAll().flatMap(i => i.getCapturedQueries());
    }

    /**
     * Save all captured queries to a single file
     */
    async saveAll(outputDir: string = './output'): Promise<void> {
        const allQueries = this.getAllQueries();

        if (this.interceptors.size === 0) {
            console.warn('[seed-it] No interceptors registered');
            return;
        }

        // Use first interceptor to save
        const firstInterceptor = this.getAll()[0];
        firstInterceptor.clear();

        // Add all queries
        allQueries.forEach(q => {
            (firstInterceptor as any).capturedQueries.push(q);
        });

        await firstInterceptor.save();
    }

    /**
     * Clear all interceptors
     */
    clearAll(): void {
        this.getAll().forEach(i => i.clear());
    }
}

// Global singleton instance
export const interceptors = new InterceptorRegistry();
