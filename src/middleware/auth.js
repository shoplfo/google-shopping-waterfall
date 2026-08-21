const config = require('../config');
const { hasPermission, getClientScope } = require('../permissions');

/**
 * Session-based authentication for dashboard users.
 * Redirects to login page if no session exists.
 */
function requireSession(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/login.html');
}

/**
 * Admin/API key authentication for API routes.
 * Accepts either session auth OR X-API-Key header.
 */
function requireApiKey(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === config.apiSecretKey) {
    req.isApiKey = true; // Flag for downstream middleware to bypass role checks
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
}

/**
 * Require the user to have one of the specified roles.
 * API key requests bypass role checks (treated as system-level admin).
 *
 * @param {...string} roles - Allowed role names
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.isApiKey) return next();
    const userRole = req.session?.userRole;
    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

/**
 * Require the user to have a specific permission (based on role level).
 * API key requests bypass permission checks.
 *
 * @param {string} permissionKey - Permission key from permissions.js
 */
function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (req.isApiKey) return next();
    const userRole = req.session?.userRole;
    if (!userRole || !hasPermission(userRole, permissionKey)) {
      return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    }
    next();
  };
}

/**
 * Attach client scope to the request based on user role.
 * Sets req.clientScope = { scoped: boolean, clientIds: string[] | null }
 * Route handlers use this to filter queries.
 */
async function attachClientScope(req, res, next) {
  if (req.isApiKey) {
    req.clientScope = { scoped: false, clientIds: null };
    return next();
  }
  if (!req.session?.userId) {
    req.clientScope = { scoped: true, clientIds: [] };
    return next();
  }
  try {
    req.clientScope = await getClientScope(req.session.userId, req.session.userRole);
    next();
  } catch (err) {
    console.error('Error attaching client scope:', err);
    req.clientScope = { scoped: true, clientIds: [] }; // Fail closed
    next();
  }
}

module.exports = {
  requireApiKey,
  requireSession,
  requireRole,
  requirePermission,
  attachClientScope,
};
