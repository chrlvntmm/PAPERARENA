use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;

use crate::{constants::*, error::ErrorCode, events::ConfigUpdated, state::GlobalConfig};

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(token::mint = config.token_mint)]
    pub new_treasury_token_account: Option<Account<'info, TokenAccount>>,
}

pub fn handle_update_config(
    ctx: Context<UpdateConfig>,
    new_admin: Option<Pubkey>,
    new_game_authority: Option<Pubkey>,
    new_fee_bps: Option<u16>,
    new_max_deposit_ttl_secs: Option<i64>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;

    if let Some(fee_bps) = new_fee_bps {
        require!(fee_bps <= MAX_FEE_BPS, ErrorCode::InvalidFeeBps);
        config.fee_bps = fee_bps;
    }
    if let Some(ttl) = new_max_deposit_ttl_secs {
        require!(ttl > 0, ErrorCode::InvalidDepositTtl);
        config.max_deposit_ttl_secs = ttl;
    }
    if let Some(game_authority) = new_game_authority {
        config.game_authority = game_authority;
    }
    if let Some(treasury) = &ctx.accounts.new_treasury_token_account {
        config.treasury = treasury.key();
    }
    if let Some(admin) = new_admin {
        config.admin = admin;
    }

    emit!(ConfigUpdated {
        admin: config.admin,
        game_authority: config.game_authority,
        treasury: config.treasury,
        fee_bps: config.fee_bps,
        max_deposit_ttl_secs: config.max_deposit_ttl_secs,
    });

    Ok(())
}
