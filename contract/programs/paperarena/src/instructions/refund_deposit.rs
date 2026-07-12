use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    events::DepositRefunded,
    state::{DepositEscrow, DepositStatus, GlobalConfig},
};

pub const REFUND_REASON_AUTHORITY: u8 = 0;
pub const REFUND_REASON_EXPIRED: u8 = 1;

#[derive(Accounts)]
pub struct RefundDeposit<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, deposit_escrow.intent_id.as_ref()],
        bump = deposit_escrow.bump
    )]
    pub deposit_escrow: Account<'info, DepositEscrow>,
    #[account(mut, address = config.vault @ ErrorCode::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = config.token_mint,
        constraint = player_token_account.owner == deposit_escrow.player
            @ ErrorCode::WrongRecipientAccount
    )]
    pub player_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_refund_deposit(ctx: Context<RefundDeposit>) -> Result<()> {
    let config = &ctx.accounts.config;
    let escrow = &ctx.accounts.deposit_escrow;

    require!(
        escrow.status == DepositStatus::Funded,
        ErrorCode::DepositNotRefundable
    );

    let signer = ctx.accounts.authority.key();
    let now = Clock::get()?.unix_timestamp;

    let reason_code = if signer == config.game_authority || signer == config.admin {
        REFUND_REASON_AUTHORITY
    } else if signer == escrow.player {
        require!(now > escrow.expires_at, ErrorCode::DepositNotExpired);
        REFUND_REASON_EXPIRED
    } else {
        return err!(ErrorCode::Unauthorized);
    };

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.player_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        escrow.amount,
    )?;

    let escrow = &mut ctx.accounts.deposit_escrow;
    escrow.status = DepositStatus::Refunded;

    emit!(DepositRefunded {
        intent_id: escrow.intent_id,
        player: escrow.player,
        amount: escrow.amount,
        reason_code,
    });

    Ok(())
}
