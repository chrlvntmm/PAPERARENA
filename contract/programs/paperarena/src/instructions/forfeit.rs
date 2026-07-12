use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    events::MatchForfeited,
    state::{GlobalConfig, MatchEscrow, MatchStatus},
};

#[derive(Accounts)]
pub struct Forfeit<'info> {
    pub game_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = game_authority @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [MATCH_SEED, match_escrow.match_id.as_ref()],
        bump = match_escrow.bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(mut, address = config.vault @ ErrorCode::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury @ ErrorCode::WrongTreasury)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_forfeit(ctx: Context<Forfeit>, reason_code: u8) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.settlements_paused, ErrorCode::SettlementsPaused);
    require!(
        ctx.accounts.match_escrow.status == MatchStatus::Locked,
        ErrorCode::MatchNotLocked
    );

    let amount = ctx.accounts.match_escrow.total_locked;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    let match_escrow = &mut ctx.accounts.match_escrow;
    match_escrow.status = MatchStatus::Forfeited;

    emit!(MatchForfeited {
        match_id: match_escrow.match_id,
        amount,
        destination: ctx.accounts.treasury_token_account.key(),
        reason_code,
    });

    Ok(())
}
