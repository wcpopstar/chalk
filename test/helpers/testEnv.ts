export {};
'use strict';

// Loaded via `require('../helpers/testEnv')` at the very top of any test
// file that imports app/route/service modules. Several modules read
// process.env at *require time*, not just at call time — most importantly
// src/services/supabase.js, which calls @supabase/supabase-js's
// createClient() at the top of the file and throws immediately if
// SUPABASE_URL is missing. So these values must exist before anything else
// is required.
//
// `||=`-style fallbacks are used (not blind overwrites) so that CI can still
// override any of these via real env vars if it ever needs to.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Quiets pino during the test run — without this every request/response
// gets pretty-printed to stdout, which is a lot of noise for a test suite.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-only-jwt-secret-do-not-use-outside-tests';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test-project.supabase.co';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-service-key';
process.env.CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
