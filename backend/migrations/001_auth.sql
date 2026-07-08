create table if not exists users (
  id uuid primary key,
  display_name text,
  status text not null default 'active' check (status in ('active', 'blocked')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists wallets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  chain_type text not null check (chain_type in ('solana', 'evm')),
  chain_id text not null,
  address text not null,
  address_normalized text not null,
  first_verified_at timestamptz not null,
  last_verified_at timestamptz not null,
  created_at timestamptz not null,
  unique (chain_type, chain_id, address_normalized)
);

create index if not exists wallets_user_id_idx on wallets(user_id);

create table if not exists auth_challenges (
  id uuid primary key,
  nonce_hash text not null unique,
  chain_type text not null check (chain_type in ('solana', 'evm')),
  chain_id text not null,
  address_normalized text not null,
  message text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_wallet_id uuid references wallets(id),
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null
);

create index if not exists auth_challenges_expires_at_idx on auth_challenges(expires_at);

create table if not exists sessions (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_token_hash text not null unique,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz not null,
  ip_hash text,
  user_agent_hash text
);

create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

create table if not exists auth_audit_logs (
  id uuid primary key,
  user_id uuid references users(id) on delete set null,
  wallet_id uuid references wallets(id) on delete set null,
  event_type text not null,
  success boolean not null,
  reason text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null
);

create index if not exists auth_audit_logs_created_at_idx on auth_audit_logs(created_at);
