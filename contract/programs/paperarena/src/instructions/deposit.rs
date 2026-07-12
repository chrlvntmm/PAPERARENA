use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    events::DepositReceived,
    state::{ArenaType, DepositEscrow, DepositStatus, GlobalConfig},
};

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = player,
        space = 8 + DepositEscrow::INIT_SPACE,
        seeds = [DEPOSIT_SEED, intent_id.as_ref()],
        bump
    )]
    pub deposit_escrow: Account<'info, DepositEscrow>,
    #[account(address = config.token_mint @ ErrorCode::WrongTokenMint)]
    pub token_mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = token_mint,
        token::authority = player
    )]
    pub player_token_account: Account<'info, TokenAccount>,
    #[account(mut, address = config.vault @ ErrorCode::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(
    ctx: Context<Deposit>,
    intent_id: [u8; 32],
    amount: u64,
    arena: ArenaType,
    wager_tier_usd: u8,
    expires_at: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.deposits_paused, ErrorCode::DepositsPaused);
    require!(
        VALID_WAGER_TIERS_USD.contains(&wager_tier_usd),
        ErrorCode::InvalidWagerTier
    );

    let unit = 10u64
        .checked_pow(ctx.accounts.token_mint.decimals as u32)
        .ok_or(ErrorCode::MathOverflow)?;
    let expected_amount = (wager_tier_usd as u64)
        .checked_mul(unit)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(amount == expected_amount, ErrorCode::InvalidAmount);

    let now = Clock::get()?.unix_timestamp;
    require!(expires_at > now, ErrorCode::InvalidExpiry);
    let max_expiry = now
        .checked_add(config.max_deposit_ttl_secs)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(expires_at <= max_expiry, ErrorCode::InvalidExpiry);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.player_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        ),
        amount,
    )?;

    let escrow = &mut ctx.accounts.deposit_escrow;
    escrow.intent_id = intent_id;
    escrow.player = ctx.accounts.player.key();
    escrow.token_mint = ctx.accounts.token_mint.key();
    escrow.amount = amount;
    escrow.arena = arena;
    escrow.wager_tier_usd = wager_tier_usd;
    escrow.status = DepositStatus::Funded;
    escrow.expires_at = expires_at;
    escrow.created_at = now;
    escrow.match_id = [0u8; 32];
    escrow.bump = ctx.bumps.deposit_escrow;

    emit!(DepositReceived {
        intent_id,
        player: escrow.player,
        token_mint: escrow.token_mint,
        amount,
        arena,
        wager_tier_usd,
        expires_at,
    });

    Ok(())
}
