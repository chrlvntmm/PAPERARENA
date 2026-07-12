use anchor_lang::prelude::*;

use crate::state::ArenaType;

#[event]
pub struct DepositReceived {
    pub intent_id: [u8; 32],
    pub player: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub arena: ArenaType,
    pub wager_tier_usd: u8,
    pub expires_at: i64,
}

#[event]
pub struct MatchLocked {
    pub match_id: [u8; 32],
    pub arena: ArenaType,
    pub wager_tier_usd: u8,
    pub token_mint: Pubkey,
    pub players: Vec<Pubkey>,
    pub intent_ids: Vec<[u8; 32]>,
    pub total_locked: u64,
}

#[event]
pub struct MatchSettled {
    pub match_id: [u8; 32],
    pub idempotency_key: [u8; 32],
    pub result_hash: [u8; 32],
    pub recipient_count: u8,
    pub total_gross: u64,
    pub total_fee: u64,
    pub total_net: u64,
    pub residual_to_treasury: u64,
}

#[event]
pub struct DepositRefunded {
    pub intent_id: [u8; 32],
    pub player: Pubkey,
    pub amount: u64,
    pub reason_code: u8,
}

#[event]
pub struct MatchRefundProgressed {
    pub match_id: [u8; 32],
    pub refunded_count: u8,
    pub player_count: u8,
    pub fully_refunded: bool,
}

#[event]
pub struct MatchForfeited {
    pub match_id: [u8; 32],
    pub amount: u64,
    pub destination: Pubkey,
    pub reason_code: u8,
}

#[event]
pub struct ConfigUpdated {
    pub admin: Pubkey,
    pub game_authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub max_deposit_ttl_secs: i64,
}

#[event]
pub struct PauseSet {
    pub deposits_paused: bool,
    pub locks_paused: bool,
    pub settlements_paused: bool,
}
