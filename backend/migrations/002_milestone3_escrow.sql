create table if not exists deposit_intents (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete restrict,
  wallet_address text not null,
  chain_type text not null check (chain_type in ('solana', 'evm')),
  chain_id text not null,
  arena text not null check (arena in ('standard', 'mega')),
  wager_usd numeric(12,2) not null check (wager_usd > 0),
  token_symbol text,
  token_mint text,
  amount_base_units text,
  status text not null check (
    status in (
      'created',
      'awaiting_payment',
      'submitted',
      'verified',
      'expired',
      'consumed',
      'failed',
      'refunded',
      'forfeited'
    )
  ),
  contract_status text not null check (contract_status in ('not_configured', 'configured')),
  tx_signature text,
  verification_error text,
  idempotency_key text not null unique,
  expires_at timestamptz not null,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists deposit_intents_user_id_idx on deposit_intents(user_id);
create index if not exists deposit_intents_wallet_id_idx on deposit_intents(wallet_id);
create index if not exists deposit_intents_status_idx on deposit_intents(status);
create index if not exists deposit_intents_expires_at_idx on deposit_intents(expires_at);
create unique index if not exists deposit_intents_tx_signature_unique_idx
  on deposit_intents(tx_signature)
  where tx_signature is not null;
create unique index if not exists deposit_intents_one_consumed_per_id_idx
  on deposit_intents(id)
  where consumed_at is not null;

create table if not exists match_fund_locks (
  id uuid primary key,
  match_id text not null unique,
  arena text not null check (arena in ('standard', 'mega')),
  wager_usd numeric(12,2) not null check (wager_usd > 0),
  token_symbol text,
  token_mint text,
  total_base_units text,
  status text not null check (status in ('created', 'locked', 'settling', 'settled', 'refunding', 'refunded', 'forfeiting', 'forfeited', 'failed')),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists match_fund_lock_players (
  id uuid primary key,
  match_fund_lock_id uuid not null references match_fund_locks(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete restrict,
  wallet_address text not null,
  deposit_intent_id uuid not null references deposit_intents(id) on delete restrict,
  amount_base_units text,
  created_at timestamptz not null,
  unique (match_fund_lock_id, wallet_id),
  unique (deposit_intent_id)
);

create table if not exists settlement_attempts (
  id uuid primary key,
  match_id text not null,
  idempotency_key text not null unique,
  result_hash text not null,
  payout_hash text not null,
  status text not null check (status in ('pending', 'submitted', 'confirmed', 'failed', 'retriable', 'finalized')),
  tx_signature text,
  error text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create index if not exists settlement_attempts_match_id_idx on settlement_attempts(match_id);
create unique index if not exists settlement_attempts_tx_signature_unique_idx
  on settlement_attempts(tx_signature)
  where tx_signature is not null;

create table if not exists payout_records (
  id uuid primary key,
  settlement_attempt_id uuid references settlement_attempts(id) on delete set null,
  match_id text not null,
  wallet_id uuid references wallets(id) on delete set null,
  wallet_address text not null,
  gross_base_units text not null,
  platform_fee_base_units text not null,
  net_base_units text not null,
  status text not null check (status in ('pending', 'submitted', 'confirmed', 'failed', 'forfeited')),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (match_id, wallet_address)
);
