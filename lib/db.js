const { createClient } = require('@supabase/supabase-js');

const isTest = process.env.NODE_ENV === 'test';
const supabase = createClient(
  process.env.SUPABASE_URL || (isTest ? 'https://test.supabase.co' : undefined),
  process.env.SUPABASE_KEY || (isTest ? 'test-key' : undefined)
);

module.exports = { supabase };
