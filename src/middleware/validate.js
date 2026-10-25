// One entry per problem. A too-small or too-large number also carries the limit (min / max) as a number,
// so the app can show it or set the input's own limit.
const detailOf = (d) => ({
  field: d.path.join('.'),
  message: d.message,
  ...(d.type === 'number.max' && { max: d.context.limit }),
  ...(d.type === 'number.min' && { min: d.context.limit }),
});

function run(schema, source, req, res, next, assign) {
  const { value, error } = schema.validate(source, {
    abortEarly: false,
    stripUnknown: true,
    errors: { wrap: { label: false } },
  });
  if (error) return res.status(400).json({ error: 'Validation failed', details: error.details.map(detailOf) });
  assign(value);
  next();
}

// Same as validate, for the query string. Values arrive as text; Joi converts them (numbers, booleans) and applies defaults.
export const validateQuery = (schema) => (req, res, next) => run(schema, req.query, req, res, next, (v) => { req.query = v; });

// Validates req.body against a Joi schema. On success the body is replaced with the
// cleaned value (trimmed, defaults applied, unknown fields removed).
export const validate = (schema) => (req, res, next) => run(schema, req.body, req, res, next, (v) => { req.body = v; });
