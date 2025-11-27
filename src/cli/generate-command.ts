import * as fs from 'fs';
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

        // Get database connection config
        const dbConfig = {
            host: options.dbHost || userConfig?.database?.host || 'localhost',
            port: parseInt(options.dbPort || userConfig?.database?.port || '5432'),
            database: options.dbName || userConfig?.database?.name,
            user: options.dbUser || userConfig?.database?.user,
            password: options.dbPassword || userConfig?.database?.password,
        };

        if (!dbConfig.database || !dbConfig.user) {
            console.error(chalk.red('Error: Database connection details required'));
            console.log('');
            console.log('Provide via CLI options or configuration file:');
            console.log('  --db-name <name>');
            console.log('  --db-user <user>');
            console.log('  --db-password <password>');
            console.log('');
            console.log('Or create a seed-it.config.js file:');
            console.log('  module.exports = {');
            console.log('    database: {');
            console.log('      host: "localhost",');
            console.log('      port: 5432,');
            console.log('      name: "your_db",');
            console.log('      user: "your_user",');
            console.log('      password: "your_password"');
            console.log('    }');
            console.log('  };');
            process.exit(1);
        }

        // Warn if multiple databases detected
        if (capturedDatabases.length > 1) {
            console.log(chalk.yellow('⚠ Multiple databases detected in captured data:'));
            capturedDatabases.forEach(db => console.log(chalk.yellow(`  - ${db}`)));
            console.log(chalk.yellow(`Using "${dbConfig.database}" for schema introspection.`));
            console.log(chalk.yellow('Note: All captured data will be included in seeders.'));
            console.log('');
        }

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

        // Generate migration
        console.log(chalk.gray('Generating migration files...'));
        const migrationGenerator = new MigrationGenerator();
        const { upFile, downFile } = await migrationGenerator.generateMigration(
            schemas,
            views,
            outputDir,
            migrationName
        );

        console.log(chalk.green(`✓ Generated migration:`));
        console.log(chalk.gray(`  ${upFile}`));
        console.log(chalk.gray(`  ${downFile}`));
        console.log('');

        // Generate seeders
        console.log(chalk.gray('Generating seeder files...'));
        const seederGenerator = new SeederGenerator();

        if (splitSeeders) {
            const files = await seederGenerator.generateSeedersByTable(
                queries,
                schemas,
                outputDir
            );
            console.log(chalk.green(`✓ Generated ${files.length} seeder files`));
        } else {
            const file = await seederGenerator.generateSeeder(
                queries,
                schemas,
                outputDir,
                seederName
            );
            console.log(chalk.green(`✓ Generated seeder:`));
            console.log(chalk.gray(`  ${file}`));
        }

        console.log('');
        console.log(chalk.blue('Generation complete!'));
        console.log('');
        console.log('Next steps:');
        console.log('1. Review the generated migration and seeder files');
        console.log('2. Run the migration on your local database');
        console.log('3. Run the seeders to populate your database');
        console.log('');

    } catch (error: any) {
        console.error(chalk.red('Error:'), error.message);
        if (error.stack) {
            console.error(chalk.gray(error.stack));
        }
        process.exit(1);
    }
}
