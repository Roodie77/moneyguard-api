import logger from '../utils/logger.js';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // The client's mistake, not ours: no error log.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // The database is saturated (no free connection within 5s) or a query hit the 10s limit.
  // That is overload, not a bug: tell clients to back off, and don't flood the log with stack traces.
  if (err.message === 'timeout exceeded when trying to connect' || err.code === '57014') {
    logger.warn(`Database busy: ${err.message} (${req.method} ${req.path})`);
    res.setHeader('Retry-After', '2');
    return res.status(503).json({ error: 'Server is busy, please retry shortly' });
  }

  logger.error(err.message, { stack: err.stack, path: req.path, method: req.method });

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max 20MB.' });
    }
    return res.status(400).json({ error: err.message });
  }

  if (err.message?.includes('Invalid file type')) {
    return res.status(400).json({ error: err.message });
  }

  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? 'Something went wrong' : err.message;

  res.status(status).json({ error: message });
}
