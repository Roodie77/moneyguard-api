// Express 4 does not catch rejected promises from async handlers; this forwards them to the error handler.
export const asyncHandler = (fn) => (req, res, next) => fn(req, res, next).catch(next);
