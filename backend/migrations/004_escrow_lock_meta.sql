alter table match_fund_locks
  add column if not exists on_chain_match_id_hex text,
  add column if not exists lock_tx_signature text;

create unique index if not exists match_fund_locks_on_chain_match_id_hex_uidx
  on match_fund_locks(on_chain_match_id_hex)
  where on_chain_match_id_hex is not null;
