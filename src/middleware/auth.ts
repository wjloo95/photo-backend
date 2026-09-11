import { RequestHandler } from 'express';
import { expressjwt } from 'express-jwt';
import { getUserByProviderId } from '../db/queries/users';
import { AppError } from '../types/AppError';
import jwksRsa from 'jwks-rsa';

// Extracts the bearer token, verifies it against Auth0's JWKS, and attaches
// the decoded payload to req.auth. On failure express-jwt itself calls
// next(err) with an UnauthorizedError (status 401).
export const auth = expressjwt({
  secret: jwksRsa.expressJwtSecret({
    jwksUri: `https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`,
    cache: true,
    rateLimit: true,
  }),
  audience: process.env.AUTH0_AUDIENCE,
  issuer: `https://${process.env.AUTH0_DOMAIN}/`,
  algorithms: ['RS256'],
});

export const loadUser: RequestHandler = async (req, _res, next) => {
  try {
    const user = await getUserByProviderId(req.auth!.sub);
    if (!user) return next(new AppError('User not found', 401));
    req.user = user; // your full User interface
    next();
  } catch (err) {
    next(err);
  }
};
