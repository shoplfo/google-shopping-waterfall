-- Migration v9: Role-Based Access Control (RBAC)
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/mnftfrzospzhyifgsnjj/sql/new

-- 1. User-to-client assignment table
CREATE TABLE IF NOT EXISTS user_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_user_clients_user ON user_clients(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clients_client ON user_clients(client_id);

-- 2. Migrate existing users from default 'user' role to 'admin'
UPDATE users SET role = 'admin' WHERE role = 'user';

-- 3. Enforce valid roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS chk_user_role;
ALTER TABLE users ADD CONSTRAINT chk_user_role
  CHECK (role IN ('client', 'agency', 'account_manager', 'admin'));
