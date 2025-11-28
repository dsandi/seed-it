import winston from 'winston';

// Create logger instance
export const logger = winston.createLogger({
    level: process.env.DEBUG === 'true' || process.env.DEBUG === '1' ? 'debug' : 'info',
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, ...meta }) => {
            const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
            return `[${level}]: ${message} ${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// Convenience methods
export const log = {
    debug: (...args: any[]) => logger.debug(args.join(' ')),
    info: (...args: any[]) => logger.info(args.join(' ')),
    warn: (...args: any[]) => logger.warn(args.join(' ')),
    error: (...args: any[]) => logger.error(args.join(' '))
};
