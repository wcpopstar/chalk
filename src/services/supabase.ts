import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/supabase';
import { config } from '../config/env';

// Both clients are parameterized with the Database schema type
// (src/types/supabase.ts, derived from supabase/migrations) — every
// .from('...') chain is now typed end-to-end: table names, column names in
// filters, row shapes in results, and embedded joins via the declared
// foreign-key relationships.
//
// No `realtime.transport` override: the `ws` package was needed back when
// Node had no global WebSocket, but this project requires Node >= 22, which
// ships one. Passing `ws` here was in fact actively harmful — its WebSocket
// type doesn't satisfy the transport parameter, and that one bad argument
// made TypeScript give up on inferring createClient's schema generic, which
// silently degraded every .from(...) chain in the codebase to `any`. Nothing
// subscribes to Supabase realtime anyway (we use Socket.IO), so no channel is
// ever opened.
//
// config values are validated non-null by validateEnv() before the server
// accepts traffic; the `as string` casts reflect that startup contract.

const supabase = createClient<Database>(
  config.supabase.url as string,
  config.supabase.anonKey as string,
);

const supabaseAdmin = createClient<Database>(
  config.supabase.url as string,
  config.supabase.serviceKey as string,
  {
    auth: { autoRefreshToken: false, persistSession: false },
  }
);

export { supabase, supabaseAdmin };
