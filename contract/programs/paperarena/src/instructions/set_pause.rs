use anchor_lang::prelude::*;

use crate::{constants::*, error::ErrorCode, events::PauseSet, state::GlobalConfig};

#[derive(Accounts)]
pub struct SetPause<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handle_set_pause(
    ctx: Context<SetPause>,
    deposits_paused: bool,
    locks_paused: bool,
    settlements_paused: bool,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.deposits_paused = deposits_paused;
    config.locks_paused = locks_paused;
    config.settlements_paused = settlements_paused;

    emit!(PauseSet {
        deposits_paused,
        locks_paused,
        settlements_paused,
    });

    Ok(())
}
