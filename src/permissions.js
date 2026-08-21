const { supabase } = require('./db');

/**
 * Role hierarchy — higher number = more access.
 */
const ROLE_LEVELS = {
  client: 0,
  agency: 1,
  account_manager: 2,
  admin: 3,
};

/**
 * Permission map — minimum role level required for each action.
 */
const PERMISSIONS = {
  // Viewing (all roles, scoped by client assignment)
  view_dashboard: 0,
  view_clients: 0,
  view_vendors: 0,
  view_run_logs: 0,

  // Agency+ actions
  create_client: 1,
  edit_client: 1,
  connect_google_ads: 1,
  assign_vendors: 1,

  // Account manager+ actions
  create_campaigns: 2,
  manage_master_keywords: 2,
  manage_vendor_keywords: 2,
  manage_general_negatives: 2,
  run_engine: 2,

  // Admin only
  manage_users: 3,
  view_settings: 3,
};

/**
 * Check if a role has a specific permission.
 * @param {string} userRole
 * @param {string} permissionKey
 * @returns {boolean}
 */
function hasPermission(userRole, permissionKey) {
  const userLevel = ROLE_LEVELS[userRole];
  const requiredLevel = PERMISSIONS[permissionKey];
  if (userLevel === undefined || requiredLevel === undefined) return false;
  return userLevel >= requiredLevel;
}

/**
 * Get the client scope for a user based on their role.
 * - client/agency: returns their assigned client IDs
 * - account_manager/admin: unscoped (sees everything)
 *
 * @param {string} userId
 * @param {string} userRole
 * @returns {{ scoped: boolean, clientIds: string[] | null }}
 */
async function getClientScope(userId, userRole) {
  const level = ROLE_LEVELS[userRole] || 0;

  // Account managers and admins see everything
  if (level >= ROLE_LEVELS.account_manager) {
    return { scoped: false, clientIds: null };
  }

  // Client and agency users only see assigned clients
  const { data, error } = await supabase
    .from('user_clients')
    .select('client_id')
    .eq('user_id', userId);

  if (error) {
    console.error('Error fetching client scope:', error.message);
    return { scoped: true, clientIds: [] }; // Fail closed — no access
  }

  return {
    scoped: true,
    clientIds: data.map(row => row.client_id),
  };
}

module.exports = {
  ROLE_LEVELS,
  PERMISSIONS,
  hasPermission,
  getClientScope,
};
