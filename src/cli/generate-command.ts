import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { SchemaAnalyzer } from '../analyzer/schema-analyzer';
import { MigrationGenerator } from '../generator/migration-generator';
import { SeederGenerator } from '../generator/seeder-generator';
import { Config } from '../config';

/**
 * Generate command handler
 */
export async function generateCommand(options: any) {
    try {
        console.log(chalk.blue('[seed-it] Starting generation process...'));
        console.log('');

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
            console.error(chalk.red(`Error: Input file not found: ${inputFile}`));
            console.log('');
            console.log('Please run your tests with the interceptor enabled first.');
            console.log('See: seed-it capture --help');
            process.exit(1);
        }

        // Load captured data
        console.log(chalk.gray(`Loading captured data from ${inputFile}...`));
        const capturedData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
        const queries = capturedData.queries || [];

        console.log(chalk.green(`✓ Loaded ${queries.length} queries`));

        // Extract unique databases from captured data
        const capturedDatabases = [...new Set(queries.map((q: any) => q.database))];
        console.log(chalk.gray(`Found data from databases: ${capturedDatabases.join(', ')}`));
        console.log('');

        // Get database connection configs
        let dbConfigs: any[] = [];

        // Check if databases array is provided in config
        if (userConfig?.databases && Array.isArray(userConfig.databases)) {
            dbConfigs = userConfig.databases.map((db: any) => ({
                host: db.host || 'localhost',
                port: db.port || 5432,
                database: db.name,
                user: db.user,
                password: db.password
            }));
        }

        // Check for CLI options or legacy single database config
        if (options.dbName || userConfig?.database?.name) {
            const singleDb = {
                host: options.dbHost || userConfig?.database?.host || 'localhost',
                port: parseInt(options.dbPort || userConfig?.database?.port || '5432'),
                database: options.dbName || userConfig?.database?.name,
                user: options.dbUser || userConfig?.database?.user,
                password: options.dbPassword || userConfig?.database?.password,
            };

            if (singleDb.database && singleDb.user) {
                dbConfigs = [singleDb];
            }
        }

        if (dbConfigs.length === 0) {
            console.error(chalk.red('Error: Database connection details required'));
            console.log('');
            console.log('Option 1: Use seed-it.config.js with databases array:');
            console.log('  module.exports = {');
            console.log('    databases: [');
            console.log('      { name: "db1", host: "localhost", port: 5432, user: "user", password: "pass" },');
            console.log('      { name: "db2", host: "localhost", port: 5432, user: "user", password: "pass" }');
            console.log('    ]');
            console.log('  };');
            console.log('');
            console.log('Option 2: Use CLI options:');
            console.log('  --db-name <name> --db-user <user> --db-password <password>');
            process.exit(1);
        }

        // Warn if multiple databases detected in captured data
        if (capturedDatabases.length > 1 && dbConfigs.length === 1) {
            console.log(chalk.yellow('⚠ Multiple databases detected in captured data:'));
            capturedDatabases.forEach(db => console.log(chalk.yellow(`  - ${db}`)));
            console.log(chalk.yellow(`Using "${dbConfigs[0].database}" for schema introspection.`));
            console.log(chalk.yellow('Note: All captured data will be included in seeders.'));
            console.log('');
        }

        // Process each database
        for (let i = 0; i < dbConfigs.length; i++) {
            const dbConfig = dbConfigs[i];
            const dbName = dbConfig.database;

            console.log(chalk.cyan(`\n${'='.repeat(60)}`));
            console.log(chalk.cyan(`Processing database: ${dbName} (${i + 1}/${dbConfigs.length})`));
            console.log(chalk.cyan('='.repeat(60)));
            console.log('');

            // Filter queries for this specific database
            const dbQueries = queries.filter((q: any) => q.database === dbName);

            if (dbQueries.length === 0) {
                console.log(chalk.yellow(`⚠ No queries captured for database "${dbName}", skipping...`));
                continue;
            }

            console.log(chalk.gray(`Found ${dbQueries.length} queries for ${dbName}`));

            // Analyze schema
            console.log(chalk.gray('Analyzing database schema...'));
            const analyzer = new SchemaAnalyzer(dbConfig);
            const schemas = await analyzer.getAllSchemas();

            // Get views
            const viewNames = await analyzer.getViews();
            const views = [];
            for (const viewName of viewNames) {
                const definition = await analyzer.getViewDefinition(viewName);
                views.push({ name: viewName, definition });
            }

            await analyzer.close();

            console.log(chalk.green(`✓ Analyzed ${schemas.length} tables`));
            if (views.length > 0) {
                console.log(chalk.green(`✓ Found ${views.length} views`));
            }
            console.log('');

            // Generate migration (with database-specific subdirectory)
            const dbOutputDir = dbConfigs.length > 1
                ? path.join(outputDir, dbName)
                : outputDir;

            const dbMigrationName = migrationName;
            console.log(chalk.gray('Generating migration files...'));
            const migrationGenerator = new MigrationGenerator();
            const { upFile, downFile } = await migrationGenerator.generateMigration(
                schemas,
                views,
                dbOutputDir,
                dbMigrationName
            );

            console.log(chalk.green(`✓ Generated migration:`));
            console.log(chalk.gray(`  ${upFile}`));
            console.log(chalk.gray(`  ${downFile}`));
            console.log('');

            // Generate seeder (with database-specific subdirectory)
            const dbSeederName = seederName;
            console.log(chalk.gray('Generating seeder files...'));
            const seederGenerator = new SeederGenerator();
            const seederFile = await seederGenerator.generateSeeder(
                dbQueries, // Use filtered queries for this database
                schemas,
                dbOutputDir,
                dbSeederName
            );

            console.log(chalk.green(`✓ Generated seeder:`));
            console.log(chalk.gray(`  ${seederFile}`));
            console.log('');
        }

        console.log(chalk.green.bold('\n✨ Generation complete!'));
        console.log('');
        console.log(chalk.gray('Next steps:'));
        console.log(chalk.gray('  1. Review generated files in ./seed-it-output/'));
        console.log(chalk.gray('  2. Run migrations: psql -U user -d dbname -f migrations/*.up.sql'));
        console.log(chalk.gray('  3. Run seeders: psql -U user -d dbname -f seeders/*.sql'));
    } catch (error: any) {
        console.error(chalk.red('\nError:'), error.message);
        if (error.stack) {
            console.error(chalk.gray(error.stack));
        }
        process.exit(1);
    }
}
