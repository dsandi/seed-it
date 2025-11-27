#!/usr/bin/env node

import { Command } from 'commander';
import { generateCommand } from './generate-command';

const program = new Command();

program
    .name('seed-it')
    .description('Generate migrations and seeders from captured PostgreSQL data')
    .version('1.0.0');

program
    .command('generate')
    .description('Generate migrations and seeders from captured data')
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-i, --input <file>', 'Input file with captured data', './seed-it-output/captured-data.json')
    .option('-o, --output <dir>', 'Output directory', './seed-it-output')
    .option('--migration-name <name>', 'Migration name', 'initial_schema')
    .option('--seeder-name <name>', 'Seeder name', 'initial_data')
    .option('--split-seeders', 'Generate one seeder file per table')
    .option('--db-host <host>', 'Database host', 'localhost')
    .option('--db-port <port>', 'Database port', '5432')
    .option('--db-name <name>', 'Database name')
    .option('--db-user <user>', 'Database user')
    .option('--db-password <password>', 'Database password')
    .action(generateCommand);

program.parse();
