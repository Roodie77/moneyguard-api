// A malformed id would make Postgres throw; it can never match anything, so it is simply "not found".
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Use as router.param('id', uuidParam).
export const uuidParam = (req, res, next, id) => {
  if (!UUID.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
};
