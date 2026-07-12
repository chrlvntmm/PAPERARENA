use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    events::{DepositRefunded, MatchRefundProgressed},
    instructions::lock_match::{read_deposit_escrow, write_deposit_escrow},
    instructions::refund_deposit::REFUND_REASON_AUTHORITY,
    state::{DepositStatus, GlobalConfig, MatchEscrow, MatchStatus},
};

#[derive(Accounts)]
pub struct RefundMatch<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [MATCH_SEED, match_escrow.match_id.as_ref()],
        bump = match_escrow.bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(mut, address = config.vault @ ErrorCode::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_refund_match<'info>(ctx: Context<'info, RefundMatch<'info>>) -> Result<()> {
    let config = &ctx.accounts.config;
    let signer = ctx.accounts.authority.key();
    require!(
        signer == config.game_authority || signer == config.admin,
        ErrorCode::Unauthorized
    );
    require!(
        ctx.accounts.match_escrow.status == MatchStatus::Locked,
        ErrorCode::MatchNotLocked
    );
    require!(
        !ctx.remaining_accounts.is_empty() && ctx.remaining_accounts.len() % 2 == 0,
        ErrorCode::AccountListMismatch
    );

    let match_id = ctx.accounts.match_escrow.match_id;
    let player_count = ctx.accounts.match_escrow.players.len() as u8;
    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];
    let mut refunded_now: u8 = 0;

    for pair in ctx.remaining_accounts.chunks(2) {
        let deposit_account = &pair[0];
        let token_account_info = &pair[1];

        let mut escrow = read_deposit_escrow(deposit_account, ctx.program_id)?;
        require!(escrow.match_id == match_id, ErrorCode::DepositMatchMismatch);
        require!(
            escrow.status == DepositStatus::Consumed,
            ErrorCode::DepositNotRefundable
        );

        let recipient = Account::<TokenAccount>::try_from(token_account_info)?;
        require_keys_eq!(
            recipient.owner,
            escrow.player,
            ErrorCode::WrongRecipientAccount
        );
        require_keys_eq!(
            recipient.mint,
            config.token_mint,
            ErrorCode::WrongTokenMint
        );

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: token_account_info.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            escrow.amount,
        )?;

        escrow.status = DepositStatus::Refunded;
        write_deposit_escrow(deposit_account, &escrow)?;
        refunded_now = refunded_now.checked_add(1).ok_or(ErrorCode::MathOverflow)?;

        emit!(DepositRefunded {
            intent_id: escrow.intent_id,
            player: escrow.player,
            amount: escrow.amount,
            reason_code: REFUND_REASON_AUTHORITY,
        });
    }

    let match_escrow = &mut ctx.accounts.match_escrow;
    match_escrow.refunded_count = match_escrow
        .refunded_count
        .checked_add(refunded_now)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(
        match_escrow.refunded_count <= player_count,
        ErrorCode::AccountListMismatch
    );

    let fully_refunded = match_escrow.refunded_count == player_count;
    if fully_refunded {
        match_escrow.status = MatchStatus::Refunded;
    }

    emit!(MatchRefundProgressed {
        match_id,
        refunded_count: match_escrow.refunded_count,
        player_count,
        fully_refunded,
    });

    Ok(())
}
