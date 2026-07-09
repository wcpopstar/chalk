const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { config } = require('../config/env');

const supabase = createClient(
  config.supabase.url,
  config.supabase.anonKey,
  { realtime: { transport: ws } }
);

const supabaseAdmin = createClient(
  config.supabase.url,
  config.supabase.serviceKey,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws }
  }
);

export { supabase, supabaseAdmin };
