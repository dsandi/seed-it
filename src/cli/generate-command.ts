import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { SchemaAnalyzer } from '../analyzer/schema-analyzer';
import { MigrationGenerator } from '../generator/migration-generator';
import { SeederGenerator } from '../generator/seeder-generator';
import { log } from '../utils/logger';
import { Config } from '../config';
import { DebugLogger } from '../debug-logger';

/**
 * Generate command handler
 */
export async function generateCommand(options: any) {
    try {
        log.info(chalk.blue('[seed-it] Starting generation process...'));
        log.info('');

        // Load configuration
        const userConfig = await Config.load(options.config);
        const config = Config.merge(userConfig?.generate || {}, Config.getDefaultGeneratorConfig());

        // Override with CLI options
        const inputFile = options.input || config.inputFile;
        const outputDir = options.output || config.outputDir;
        const migrationName = options.migrationName || config.migrationName || 'initial_schema';
        const seederName = options.seederName || config.seederName || 'initial_data';
        const splitSeeders = options.splitSeeders || config.splitSeeders || false;

        // Check if input file exists
        if (!fs.existsSync(inputFile)) {
            log.error(`Error: Input file not found: ${inputFile}`);
            log.info('');
            log.info('Please run your tests with the interceptor enabled first.');
            log.info('See: seed-it capture --help');
            process.exit(1);
        }

        // Load captured data
        log.info(chalk.gray(`Loading captured data from ${inputFile}...`));
        const capturedData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
        const queries = capturedData.queries || [];

        log.info(chalk.green(`✓ Loaded ${queries.length} queries`));

        // Extract unique databases from captured data
        const capturedDatabases = [...new Set(queries.map((q: any) => q.database))];
        log.info(chalk.gray(`Found data from databases: ${capturedDatabases.join(', ')}`));
        log.info('');

        // Get database connection configs
        let dbConfigs: any[] = [];

        // Check for common typo: database (singular) array instead of databases (plural)
        if (userConfig?.database && Array.isArray(userConfig.database) && !userConfig.databases) {
            log.warn(chalk.yellow('⚠ Warning: Found "database" array in config. Did you mean "databases"?'));
            log.warn(chalk.yellow('  Automatically using "database" array as "databases".'));
            userConfig.databases = userConfig.database;
        }

        // Check if databases array is provided in config
        if (userConfig?.databases && Array.isArray(userConfig.databases)) {
            dbConfigs = userConfig.databases.map((db: any) => ({
                host: db.host || 'localhost',
                port: db.port || 5432,
                name: db.name,  // Fixed: was 'database', should be 'name' to match DatabaseConfig type
                user: db.user,
                password: db.password,
                ssl: db.ssl
            }));
        }

        // Check for CLI options or legacy single database config
        if (options.dbName || userConfig?.database?.name) {
            const singleDb = {
                host: options.dbHost || userConfig?.database?.host || 'localhost',
                port: parseInt(options.dbPort || userConfig?.database?.port || '5432'),
                name: options.dbName || userConfig?.database?.name,  // Fixed: was 'database', should be 'name'
                user: options.dbUser || userConfig?.database?.user,
                password: options.dbPassword || userConfig?.database?.password,
                ssl: userConfig?.database?.ssl,
            };

            if (singleDb.name && singleDb.user) {  // Fixed: was 'singleDb.database', should be 'singleDb.name'
                dbConfigs = [singleDb];
            }
        }

        if (dbConfigs.length === 0) {
            log.error(chalk.red('Error: Database connection details required'));
            log.info('');
            log.info('Option 1: Use seed-it.config.js with databases array:');
            log.info('  module.exports = {');
            log.info('    databases: [');
            log.info('      { name: "db1", host: "localhost", port: 5432, user: "user", password: "pass" },');
            log.info('      { name: "db2", host: "localhost", port: 5432, user: "user", password: "pass" }');
            log.info('    ]');
            log.info('  };');
            log.info('');
            log.info('Option 2: Use CLI options:');
            log.info('  --db-name <name> --db-user <user> --db-password <password>');
            process.exit(1);
        }

        // Warn if multiple databases detected in captured data
        if (capturedDatabases.length > 1 && dbConfigs.length === 1) {
            log.warn(chalk.yellow('⚠ Multiple databases detected in captured data:'));
            capturedDatabases.forEach(db => log.warn(chalk.yellow(`  - ${db}`)));
            log.warn(chalk.yellow(`Using "${dbConfigs[0].name}" for schema introspection.`));
            log.warn(chalk.yellow('Note: All captured data will be included in seeders.'));
            log.info('');
        }

        // Initialize debug logger
        const debugLogger = new DebugLogger(outputDir, options.debug);

        // Process each database
        for (let i = 0; i < dbConfigs.length; i++) {
            const dbConfig = dbConfigs[i];
            const dbName = dbConfig.name;  // Fixed: was dbConfig.database, should be dbConfig.name

            log.info(chalk.cyan(`${'='.repeat(60)}`));
            log.info(chalk.cyan(`Processing database: ${dbName} (${i + 1}/${dbConfigs.length})`));
            log.info(chalk.cyan('='.repeat(60)));
            log.info('');

            // Filter queries for this specific database
            const dbQueries = queries.filter((q: any) => q.database === dbName);

            if (dbQueries.length === 0) {
                log.warn(chalk.yellow(`⚠ No queries captured for database "${dbName}", skipping...`));
                continue;
            }

            log.info(chalk.gray(`Found ${dbQueries.length} queries for ${dbName}`));

            // Analyze schema
            log.info(chalk.gray('Analyzing database schema...'));
            const analyzer = new SchemaAnalyzer(dbConfig);
            const schemas = await analyzer.getAllSchemas();
            const views = await analyzer.getViews().then(names =>
                Promise.all(names.map(async name => ({
                    name,
                    definition: await analyzer.getViewDefinition(name)
                })))
            );

            // Get OID map for handling JOINs
            const oidMap = await analyzer.getTableOids();

            await analyzer.close();

            log.info(chalk.green(`✓ Analyzed ${schemas.length} tables`));
            if (views.length > 0) {
                log.info(chalk.green(`✓ Found ${views.length} views`));
            }
            log.info('');

            // Generate migration (with database-specific subdirectory)
            const dbOutputDir = dbConfigs.length > 1
                ? path.join(outputDir, dbName)
                : outputDir;

            const dbMigrationName = migrationName;
            log.info(chalk.gray('Generating migration files...'));
            const migrationGenerator = new MigrationGenerator();
            const { upFile, downFile } = await migrationGenerator.generateMigration(
                schemas,
                views,
                dbOutputDir,
                dbMigrationName
            );

            log.info(chalk.green(`✓ Generated migration:`));
            log.info(chalk.gray(`  ${upFile}`));
            log.info(chalk.gray(`  ${downFile}`));
            log.info('');

            // Generate seeder (with database-specific subdirectory)
            const dbSeederName = seederName;
            log.info(chalk.gray('Generating seeder files...'));
            const seederGenerator = new SeederGenerator();
            const seederFile = await seederGenerator.generateSeeder(
                dbQueries, // Use filtered queries for this database
                schemas,
                dbOutputDir,
                dbSeederName,
                oidMap,
                config.columnMappings, // Pass column mappings from config
                analyzer.getPool(), // Pass pool for dependency fetching
                debugLogger
            );

            log.info(chalk.green(`✓ Generated seeder:`));
            log.info(chalk.gray(`  ${seederFile}`));
            log.info('');
        }

        await debugLogger.save();
        log.info(chalk.green.bold('\n✨ Generation complete!'));
        log.info('');
        log.info(chalk.gray('Next steps:'));
        log.info(chalk.gray('  1. Review generated files in ./seed-it-output/'));
        log.info(chalk.gray('  2. Run migrations: psql -U user -d dbname -f migrations/*.up.sql'));
        log.info(chalk.gray('  3. Run seeders: psql -U user -d dbname -f seeders/*.sql'));
    } catch (error: any) {
        log.error(chalk.red('\nError:'), error.message);
        if (error.stack) {
            log.error(chalk.gray(error.stack));
        }
        process.exit(1);
    }
}

