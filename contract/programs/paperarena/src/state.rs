use anchor_lang::prelude::*;

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArenaType {
    Standard,
    Mega,
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum DepositStatus {
    Funded,
    Consumed,
    Refunded,
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum MatchStatus {
    Locked,
    Settled,
    Refunded,
    Forfeited,
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub game_authority: Pubkey,
    pub treasury: Pubkey,
    pub token_mint: Pubkey,
    pub vault: Pubkey,
    pub fee_bps: u16,
    pub max_deposit_ttl_secs: i64,
    pub deposits_paused: bool,
    pub locks_paused: bool,
    pub settlements_paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DepositEscrow {
    pub intent_id: [u8; 32],
    pub player: Pubkey,
    pub token_mint: Pubkey,
    pub amount: u64,
    pub arena: ArenaType,
    pub wager_tier_usd: u8,
    pub status: DepositStatus,
    pub expires_at: i64,
    pub created_at: i64,
    pub match_id: [u8; 32],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct MatchEscrow {
    pub match_id: [u8; 32],
    pub arena: ArenaType,
    pub wager_tier_usd: u8,
    pub token_mint: Pubkey,
    pub total_locked: u64,
    #[max_len(10)]
    pub players: Vec<Pubkey>,
    pub refunded_count: u8,
    pub status: MatchStatus,
    pub result_hash: [u8; 32],
    pub locked_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementRecord {
    pub match_id: [u8; 32],
    pub idempotency_key: [u8; 32],
    pub result_hash: [u8; 32],
    pub total_gross: u64,
    pub total_fee: u64,
    pub total_net: u64,
    pub residual_to_treasury: u64,
    pub recipient_count: u8,
    pub settled_at: i64,
    pub bump: u8,
}
