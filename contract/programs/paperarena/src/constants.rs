use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

#[constant]
pub const VAULT_SEED: &[u8] = b"vault";

#[constant]
pub const DEPOSIT_SEED: &[u8] = b"deposit";

#[constant]
pub const MATCH_SEED: &[u8] = b"match";

#[constant]
pub const SETTLEMENT_SEED: &[u8] = b"settlement";

pub const MAX_FEE_BPS: u16 = 1_000;

pub const BPS_DENOMINATOR: u64 = 10_000;

pub const MIN_PLAYERS: usize = 2;

pub const MAX_PLAYERS: usize = 10;

pub const VALID_WAGER_TIERS_USD: [u8; 3] = [5, 10, 20];
