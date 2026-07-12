use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    events::MatchLocked,
    state::{ArenaType, DepositEscrow, DepositStatus, GlobalConfig, MatchEscrow, MatchStatus},
};

#[derive(Accounts)]
#[instruction(match_id: [u8; 32])]
pub struct LockMatch<'info> {
    #[account(mut)]
    pub game_authority: Signer<'info>,
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = game_authority @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
    #[account(
        init,
        payer = game_authority,
        space = 8 + MatchEscrow::INIT_SPACE,
        seeds = [MATCH_SEED, match_id.as_ref()],
        bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    pub system_program: Program<'info, System>,
}

pub fn read_deposit_escrow(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<DepositEscrow> {
    require!(account.owner == program_id, ErrorCode::InvalidDepositAccount);
    let data = account.try_borrow_data()?;
    let escrow = DepositEscrow::try_deserialize(&mut &data[..])?;
    let expected = Pubkey::create_program_address(
        &[DEPOSIT_SEED, escrow.intent_id.as_ref(), &[escrow.bump]],
        program_id,
    )
    .map_err(|_| ErrorCode::InvalidDepositAccount)?;
    require_keys_eq!(*account.key, expected, ErrorCode::InvalidDepositAccount);
    Ok(escrow)
}

pub fn write_deposit_escrow(account: &AccountInfo, escrow: &DepositEscrow) -> Result<()> {
    let mut data = account.try_borrow_mut_data()?;
    let mut writer: &mut [u8] = &mut data;
    escrow.try_serialize(&mut writer)?;
    Ok(())
}

pub fn handle_lock_match(ctx: Context<LockMatch>, match_id: [u8; 32]) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.locks_paused, ErrorCode::LocksPaused);

    let deposit_accounts = ctx.remaining_accounts;
    let count = deposit_accounts.len();
    require!(
        (MIN_PLAYERS..=MAX_PLAYERS).contains(&count),
        ErrorCode::InvalidPlayerCount
    );

    let now = Clock::get()?.unix_timestamp;
    let mut players: Vec<Pubkey> = Vec::with_capacity(count);
    let mut intent_ids: Vec<[u8; 32]> = Vec::with_capacity(count);
    let mut total_locked: u64 = 0;
    let mut arena: Option<ArenaType> = None;
    let mut wager_tier_usd: Option<u8> = None;

    for account in deposit_accounts.iter() {
        let mut escrow = read_deposit_escrow(account, ctx.program_id)?;

        require!(
            escrow.status == DepositStatus::Funded,
            ErrorCode::DepositNotFunded
        );
        require!(now <= escrow.expires_at, ErrorCode::DepositExpired);
        require_keys_eq!(
            escrow.token_mint,
            config.token_mint,
            ErrorCode::WrongTokenMint
        );

        match arena {
            None => arena = Some(escrow.arena),
            Some(a) => require!(a == escrow.arena, ErrorCode::MixedArenas),
        }
        match wager_tier_usd {
            None => wager_tier_usd = Some(escrow.wager_tier_usd),
            Some(t) => require!(t == escrow.wager_tier_usd, ErrorCode::MixedWagerTiers),
        }
        require!(!players.contains(&escrow.player), ErrorCode::DuplicatePlayer);

        players.push(escrow.player);
        intent_ids.push(escrow.intent_id);
        total_locked = total_locked
            .checked_add(escrow.amount)
            .ok_or(ErrorCode::MathOverflow)?;

        escrow.status = DepositStatus::Consumed;
        escrow.match_id = match_id;
        write_deposit_escrow(account, &escrow)?;
    }

    let arena = arena.ok_or(ErrorCode::InvalidPlayerCount)?;
    let wager_tier_usd = wager_tier_usd.ok_or(ErrorCode::InvalidPlayerCount)?;

    let match_escrow = &mut ctx.accounts.match_escrow;
    match_escrow.match_id = match_id;
    match_escrow.arena = arena;
    match_escrow.wager_tier_usd = wager_tier_usd;
    match_escrow.token_mint = config.token_mint;
    match_escrow.total_locked = total_locked;
    match_escrow.players = players.clone();
    match_escrow.refunded_count = 0;
    match_escrow.status = MatchStatus::Locked;
    match_escrow.result_hash = [0u8; 32];
    match_escrow.locked_at = now;
    match_escrow.bump = ctx.bumps.match_escrow;

    emit!(MatchLocked {
        match_id,
        arena,
        wager_tier_usd,
        token_mint: config.token_mint,
        players,
        intent_ids,
        total_locked,
    });

    Ok(())
}
