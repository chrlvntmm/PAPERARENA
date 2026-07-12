use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::{constants::*, error::ErrorCode, events::ConfigUpdated, state::GlobalConfig};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,
    pub token_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED],
        bump,
        token::mint = token_mint,
        token::authority = config
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(token::mint = token_mint)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    game_authority: Pubkey,
    fee_bps: u16,
    max_deposit_ttl_secs: i64,
) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, ErrorCode::InvalidFeeBps);
    require!(max_deposit_ttl_secs > 0, ErrorCode::InvalidDepositTtl);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.game_authority = game_authority;
    config.treasury = ctx.accounts.treasury_token_account.key();
    config.token_mint = ctx.accounts.token_mint.key();
    config.vault = ctx.accounts.vault.key();
    config.fee_bps = fee_bps;
    config.max_deposit_ttl_secs = max_deposit_ttl_secs;
    config.deposits_paused = false;
    config.locks_paused = false;
    config.settlements_paused = false;
    config.bump = ctx.bumps.config;

    emit!(ConfigUpdated {
        admin: config.admin,
        game_authority: config.game_authority,
        treasury: config.treasury,
        fee_bps: config.fee_bps,
        max_deposit_ttl_secs: config.max_deposit_ttl_secs,
    });

    Ok(())
}
