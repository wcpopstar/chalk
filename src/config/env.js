function getServerConfig() {
  const port = Number(process.env.PORT || 3000);
  const nodeEnv = process.env.NODE_ENV || 'development';
  const clientOrigin = process.env.CLIENT_URL || '*';

  return {
    port: Number.isFinite(port) && port > 0 ? port : 3000,
    nodeEnv,
    clientOrigin,
  };
}

function validateEnv() {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

module.exports = { getServerConfig, validateEnv };
