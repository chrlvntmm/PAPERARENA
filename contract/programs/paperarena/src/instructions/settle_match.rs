use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::*,
    error::ErrorCode,
    events::MatchSettled,
    state::{GlobalConfig, MatchEscrow, MatchStatus, SettlementRecord},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PayoutInput {
    pub player_index: u8,
    pub gross: u64,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct SettleMatch<'info> {
    #[account(mut)]
    pub game_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = game_authority @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        mut,
        seeds = [MATCH_SEED, match_id.as_ref()],
        bump = match_escrow.bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(
        init,
        payer = game_authority,
        space = 8 + SettlementRecord::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, match_id.as_ref()],
        bump
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
    #[account(mut, address = config.vault @ ErrorCode::WrongVault)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, address = config.treasury @ ErrorCode::WrongTreasury)]
    pub treasury_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_settle_match<'info>(
    ctx: Context<'info, SettleMatch<'info>>,
    match_id: [u8; 32],
    idempotency_key: [u8; 32],
    result_hash: [u8; 32],
    payouts: Vec<PayoutInput>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.settlements_paused, ErrorCode::SettlementsPaused);
    require!(
        ctx.accounts.match_escrow.status == MatchStatus::Locked,
        ErrorCode::MatchNotLocked
    );
    require!(!payouts.is_empty(), ErrorCode::EmptyPayouts);
    require!(
        ctx.remaining_accounts.len() == payouts.len(),
        ErrorCode::AccountListMismatch
    );

    let players = ctx.accounts.match_escrow.players.clone();
    let total_locked = ctx.accounts.match_escrow.total_locked;
    let fee_bps = config.fee_bps as u64;

    let mut seen_indices: Vec<u8> = Vec::with_capacity(payouts.len());
    let mut total_gross: u64 = 0;
    let mut total_fee: u64 = 0;
    let mut total_net: u64 = 0;

    let signer_seeds: &[&[&[u8]]] = &[&[CONFIG_SEED, &[config.bump]]];

    for (payout, recipient_account) in payouts.iter().zip(ctx.remaining_accounts.iter()) {
        let index = payout.player_index;
        require!((index as usize) < players.len(), ErrorCode::InvalidPayout);
        require!(!seen_indices.contains(&index), ErrorCode::DuplicateRecipient);
        seen_indices.push(index);
        require!(payout.gross > 0, ErrorCode::InvalidPayout);

        let player = players[index as usize];
        let recipient = Account::<TokenAccount>::try_from(recipient_account)?;
        require_keys_eq!(recipient.owner, player, ErrorCode::WrongRecipientAccount);
        require_keys_eq!(
            recipient.mint,
            config.token_mint,
            ErrorCode::WrongTokenMint
        );

        let fee = ((payout.gross as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            / BPS_DENOMINATOR as u128) as u64;
        let net = payout.gross.checked_sub(fee).ok_or(ErrorCode::MathOverflow)?;

        total_gross = total_gross
            .checked_add(payout.gross)
            .ok_or(ErrorCode::MathOverflow)?;
        total_fee = total_fee.checked_add(fee).ok_or(ErrorCode::MathOverflow)?;
        total_net = total_net.checked_add(net).ok_or(ErrorCode::MathOverflow)?;
        require!(total_gross <= total_locked, ErrorCode::PayoutExceedsPot);

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: recipient_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            net,
        )?;
    }

    let residual = total_locked
        .checked_sub(total_gross)
        .ok_or(ErrorCode::MathOverflow)?;
    let to_treasury = total_fee
        .checked_add(residual)
        .ok_or(ErrorCode::MathOverflow)?;
    if to_treasury > 0 {
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
            to_treasury,
        )?;
    }

    let now = Clock::get()?.unix_timestamp;

    let match_escrow = &mut ctx.accounts.match_escrow;
    match_escrow.status = MatchStatus::Settled;
    match_escrow.result_hash = result_hash;

    let record = &mut ctx.accounts.settlement_record;
    record.match_id = match_id;
    record.idempotency_key = idempotency_key;
    record.result_hash = result_hash;
    record.total_gross = total_gross;
    record.total_fee = total_fee;
    record.total_net = total_net;
    record.residual_to_treasury = residual;
    record.recipient_count = payouts.len() as u8;
    record.settled_at = now;
    record.bump = ctx.bumps.settlement_record;

    emit!(MatchSettled {
        match_id,
        idempotency_key,
        result_hash,
        recipient_count: payouts.len() as u8,
        total_gross,
        total_fee,
        total_net,
        residual_to_treasury: residual,
    });

    Ok(())
}
