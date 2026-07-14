-- Passkeys (WebAuthn): one row per registered credential. The credential id
-- and public key arrive base64url-encoded from the browser and are stored
-- verbatim; counter supports clone detection on login.
create table if not exists webauthn_credentials (
  id            text primary key,                -- credential id, base64url
  user_id       uuid not null references users(id) on delete cascade,
  public_key    text not null,                   -- COSE public key, base64url
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  device_name   text,                            -- friendly label ("MacBook Touch ID")
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create index if not exists webauthn_credentials_user_idx on webauthn_credentials(user_id);
