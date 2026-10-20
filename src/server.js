/**
 * Process entry point: load config, start HTTP server, shut down gracefully.
 */
import { createApp } from './app.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './lib/logger.js';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: cfg.logLevel });
const app = createApp(cfg, { logger });
const server = app.listen(cfg.port, () => logger.info('gateway listening', describeConfig(cfg)));

const shutdown = (signal) => {
  logger.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
