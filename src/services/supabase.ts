import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
const ws = require('ws');
const { config } = require('../config/env');

// Both clients are parameterized with the Database schema type
// (src/types/supabase.ts, derived from supabase/migrations) — every
// .from('...') chain is now typed end-to-end: table names, column names in
// filters, row shapes in results, and embedded joins via the declared
// foreign-key relationships.
//
// config values are validated non-null by validateEnv() before the server
// accepts traffic; the `as string` casts reflect that startup contract.

const supabase = createClient<Database>(
  config.supabase.url as string,
  config.supabase.anonKey as string,
  { realtime: { transport: ws } }
);

const supabaseAdmin = createClient<Database>(
  config.supabase.url as string,
  config.supabase.serviceKey as string,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: ws }
  }
);

export { supabase, supabaseAdmin };
