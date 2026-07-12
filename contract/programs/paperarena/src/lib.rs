pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EQyF5gzy1hzY38fiQhtW3CHLNYaAt3oknb39ceigZtNM");

#[program]
pub mod paperarena {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        game_authority: Pubkey,
        fee_bps: u16,
        max_deposit_ttl_secs: i64,
    ) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(
            ctx,
            game_authority,
            fee_bps,
            max_deposit_ttl_secs,
        )
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Option<Pubkey>,
        new_game_authority: Option<Pubkey>,
        new_fee_bps: Option<u16>,
        new_max_deposit_ttl_secs: Option<i64>,
    ) -> Result<()> {
        instructions::update_config::handle_update_config(
            ctx,
            new_admin,
            new_game_authority,
            new_fee_bps,
            new_max_deposit_ttl_secs,
        )
    }

    pub fn set_pause(
        ctx: Context<SetPause>,
        deposits_paused: bool,
        locks_paused: bool,
        settlements_paused: bool,
    ) -> Result<()> {
        instructions::set_pause::handle_set_pause(
            ctx,
            deposits_paused,
            locks_paused,
            settlements_paused,
        )
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        intent_id: [u8; 32],
        amount: u64,
        arena: ArenaType,
        wager_tier_usd: u8,
        expires_at: i64,
    ) -> Result<()> {
        instructions::deposit::handle_deposit(
            ctx,
            intent_id,
            amount,
            arena,
            wager_tier_usd,
            expires_at,
        )
    }

    pub fn lock_match(ctx: Context<LockMatch>, match_id: [u8; 32]) -> Result<()> {
        instructions::lock_match::handle_lock_match(ctx, match_id)
    }

    pub fn settle_match<'info>(
        ctx: Context<'info, SettleMatch<'info>>,
        match_id: [u8; 32],
        idempotency_key: [u8; 32],
        result_hash: [u8; 32],
        payouts: Vec<PayoutInput>,
    ) -> Result<()> {
        instructions::settle_match::handle_settle_match(
            ctx,
            match_id,
            idempotency_key,
            result_hash,
            payouts,
        )
    }

    pub fn refund_deposit(ctx: Context<RefundDeposit>) -> Result<()> {
        instructions::refund_deposit::handle_refund_deposit(ctx)
    }

    pub fn refund_match<'info>(ctx: Context<'info, RefundMatch<'info>>) -> Result<()> {
        instructions::refund_match::handle_refund_match(ctx)
    }

    pub fn forfeit(ctx: Context<Forfeit>, reason_code: u8) -> Result<()> {
        instructions::forfeit::handle_forfeit(ctx, reason_code)
    }
}
