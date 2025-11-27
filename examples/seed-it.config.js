/**
 * Example configuration file for seed-it
 */
module.exports = {
    // Database connection details for schema analysis
    database: {
        host: 'localhost',
        port: 5432,
        name: 'your_database_name',
        user: 'your_username',
        password: 'your_password'
    },

    // Generator configuration
    generate: {
        inputFile: './output/captured-data.json',
        outputDir: './output',
        migrationName: 'initial_schema',
        seederName: 'initial_data',
        splitSeeders: false, // Set to true to generate one seeder file per table
        deduplicateRows: true,
        handleCircularDeps: true
    }
};
