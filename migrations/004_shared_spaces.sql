-- Migration: Shared Spaces for Finanzas Compartidas
-- Execute via Supabase SQL editor

-- 1. Shared spaces (rooms/groups)
CREATE TABLE IF NOT EXISTS shared_spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT DEFAULT 'custom' CHECK (type IN ('pareja', 'roommates', 'custom')),
  invite_code TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES usuarios(id) NOT NULL,
  monthly_budget NUMERIC(12,2),
  default_split_type TEXT DEFAULT 'equal',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Space members
CREATE TABLE IF NOT EXISTS space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES shared_spaces(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES usuarios(id) NOT NULL,
  split_percentage NUMERIC(5,2) DEFAULT 50,
  role TEXT DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(space_id, user_id)
);

-- 3. Space expenses
CREATE TABLE IF NOT EXISTS space_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES shared_spaces(id) NOT NULL,
  paid_by UUID REFERENCES usuarios(id) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  description TEXT,
  category TEXT,
  split_type TEXT DEFAULT 'equal',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Settlements
CREATE TABLE IF NOT EXISTS space_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID REFERENCES shared_spaces(id) NOT NULL,
  from_user UUID REFERENCES usuarios(id) NOT NULL,
  to_user UUID REFERENCES usuarios(id) NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  settled_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members (user_id);
CREATE INDEX IF NOT EXISTS idx_space_members_space ON space_members (space_id);
CREATE INDEX IF NOT EXISTS idx_space_expenses_space ON space_expenses (space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_space_settlements_space ON space_settlements (space_id, settled_at DESC);

-- FK: metas_ahorro.space_id -> shared_spaces
ALTER TABLE metas_ahorro ADD CONSTRAINT fk_meta_space
  FOREIGN KEY (space_id) REFERENCES shared_spaces(id);

-- RLS
ALTER TABLE shared_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE space_settlements ENABLE ROW LEVEL SECURITY;

-- Policies: users can see spaces they belong to
CREATE POLICY "Members can view own spaces"
  ON shared_spaces FOR SELECT
  USING (id IN (SELECT space_id FROM space_members WHERE user_id IN (SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid())));

CREATE POLICY "Members can view space members"
  ON space_members FOR SELECT
  USING (space_id IN (SELECT space_id FROM space_members sm WHERE sm.user_id IN (SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid())));

CREATE POLICY "Members can view space expenses"
  ON space_expenses FOR SELECT
  USING (space_id IN (SELECT space_id FROM space_members WHERE user_id IN (SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid())));

CREATE POLICY "Members can view space settlements"
  ON space_settlements FOR SELECT
  USING (space_id IN (SELECT space_id FROM space_members WHERE user_id IN (SELECT id FROM usuarios WHERE supabase_auth_id = auth.uid())));

-- Service role full access
CREATE POLICY "Service role full access on shared_spaces"
  ON shared_spaces FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on space_members"
  ON space_members FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on space_expenses"
  ON space_expenses FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on space_settlements"
  ON space_settlements FOR ALL TO service_role USING (true) WITH CHECK (true);
