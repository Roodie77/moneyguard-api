function run(schema, source, req, res, next, assign) {
  const { value, error } = schema.validate(source, {
    abortEarly: false,
    stripUnknown: true,
    errors: { wrap: { label: false } },
  });
  if (error) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.details.map((d) => ({ field: d.path.join('.'), message: d.message })),
    });
  }
  assign(value);
  next();
}

// Same as validate, for the query string. Values arrive as text; Joi converts them (numbers, booleans) and applies defaults.
export const validateQuery = (schema) => (req, res, next) => run(schema, req.query, req, res, next, (v) => { req.query = v; });

// Validates req.body against a Joi schema. On success the body is replaced with the
// cleaned value (trimmed, defaults applied, unknown fields removed).
export const validate = (schema) => (req, res, next) => {
  const { value, error } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
    errors: { wrap: { label: false } },
  });
  if (error) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.details.map((d) => ({ field: d.path.join('.'), message: d.message })),
    });
  }
  req.body = value;
  next();
};
