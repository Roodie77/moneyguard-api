import jwt from 'jsonwebtoken';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}
const JWT_SECRET = process.env.JWT_SECRET || 'moneyguard-dev-secret-change-me';

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ['HS256'] });
    req.userId = payload.userId;
    req.tokenIssuedAt = payload.iat; // seconds; lets a password reset end sessions that started before it
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Short on purpose: a leaked access token is only useful for this long. The refresh token keeps the user signed in.
export const ACCESS_TOKEN_SECONDS = Number(process.env.ACCESS_TOKEN_SECONDS) || 3600;

export function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_SECONDS });
}
