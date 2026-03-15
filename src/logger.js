// Shared Pino logger — replaces ad-hoc console.log/console.error across the codebase
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

export default logger;
