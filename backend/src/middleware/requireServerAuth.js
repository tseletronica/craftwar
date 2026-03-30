import { NETWORK_SHARED_SECRET } from '../config.js';

function readSecret(req) {
  const explicit = req.header('x-network-secret');
  if (explicit) {
    return explicit.trim();
  }

  const authorization = req.header('authorization');
  if (!authorization) {
    return null;
  }

  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.trim();
  }

  return authorization.slice(7).trim();
}

export function requireServerAuth(req, res, next) {
  const serverId = req.header('x-server-id')?.trim();
  const secret = readSecret(req);

  if (!serverId || !secret || secret !== NETWORK_SHARED_SECRET) {
    return res.status(401).json({
      status: 'error',
      code: 'UNAUTHORIZED_SERVER',
      message: 'Server authentication failed.'
    });
  }

  req.serverId = serverId;
  next();
}
