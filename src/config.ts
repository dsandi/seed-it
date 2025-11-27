import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { CaptureConfig, GeneratorConfig } from './types';

/**
 * Configuration loader and validator
 */
export class Config {
    /**
     * Load configuration from file
     */
    static async load(configPath?: string): Promise<any> {
        const defaultPaths = [
            'seed-it.config.js',
            'seed-it.config.json',
            '.seed-it.json',
        ];

        const pathsToTry = configPath ? [configPath] : defaultPaths;

        for (const p of pathsToTry) {
            const fullPath = path.resolve(process.cwd(), p);

            if (fs.existsSync(fullPath)) {
                console.log(chalk.gray(`[seed-it] Loading config from ${fullPath}`));
                let config;

                if (p.endsWith('.json')) {
                    const content = await fs.promises.readFile(fullPath, 'utf-8');
                    config = JSON.parse(content);
                } else {
                    try {
                        config = require(fullPath);
                    } catch (e: any) {
                        console.error(chalk.red(`Error loading config file: ${e.message}`));
                        throw e;
                    }
                }

                // Handle ESM default export
                if (config && config.default) {
                    return { ...config, ...config.default };
                }
                return config;
            }
        }

        console.log(chalk.yellow('[seed-it] No configuration file found in current directory.'));
        return null;
    }

    /**
     * Get default capture configuration
     */
    static getDefaultCaptureConfig(): CaptureConfig {
        return {
            outputDir: './seed-it-output',
            databases: [],
            captureReads: false,
            captureTransactions: true,
            verbose: false,
        };
    }

    /**
     * Get default generator configuration
     */
    static getDefaultGeneratorConfig(): GeneratorConfig {
        return {
            inputFile: './seed-it-output/captured-data.json',
            outputDir: './seed-it-output',
            deduplicateRows: true,
            handleCircularDeps: true,
        };
    }

    /**
     * Merge user config with defaults
     */
    static merge(userConfig: any, defaults: any): any {
        return { ...defaults, ...userConfig };
    }
}
