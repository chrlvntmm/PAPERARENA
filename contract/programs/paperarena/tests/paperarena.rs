use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            clock::Clock,
            instruction::{AccountMeta, Instruction},
            program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    paperarena::{
        error::ErrorCode, ArenaType, DepositEscrow, DepositStatus, MatchEscrow, MatchStatus,
        PayoutInput, SettlementRecord,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const FEE_BPS: u16 = 200;
const MAX_TTL: i64 = 3_600;
const USD5: u64 = 5_000_000;
const USD10: u64 = 10_000_000;

type TxResult = Result<TransactionMetadata, FailedTransactionMetadata>;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    game_authority: Keypair,
    mint: Pubkey,
    treasury_ta: Pubkey,
    config: Pubkey,
    vault: Pubkey,
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ixs: &[Instruction], extra: &[&Keypair]) -> TxResult {
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    svm.send_transaction(tx)
}

fn assert_custom_err(res: TxResult, expected: ErrorCode) {
    let failed = res.expect_err("transaction should have failed");
    let got = format!("{:?}", failed.err);
    let want = format!("Custom({})", 6_000 + expected as u32);
    assert!(
        got.contains(&want),
        "expected {want}, got {got}\nlogs: {:#?}",
        failed.meta.logs
    );
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            rent,
            spl_token::state::Mint::LEN as u64,
            &spl_token::id(),
        ),
        spl_token::instruction::initialize_mint2(
            &spl_token::id(),
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            6,
        )
        .unwrap(),
    ];
    send(svm, payer, &ixs, &[&mint]).unwrap();
    mint.pubkey()
}

fn create_token_account(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let ta = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &ta.pubkey(),
            rent,
            spl_token::state::Account::LEN as u64,
            &spl_token::id(),
        ),
        spl_token::instruction::initialize_account3(&spl_token::id(), &ta.pubkey(), mint, owner)
            .unwrap(),
    ];
    send(svm, payer, &ixs, &[&ta]).unwrap();
    ta.pubkey()
}

fn mint_to(svm: &mut LiteSVM, authority: &Keypair, mint: &Pubkey, ta: &Pubkey, amount: u64) {
    let ix = spl_token::instruction::mint_to(
        &spl_token::id(),
        mint,
        ta,
        &authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(svm, authority, &[ix], &[]).unwrap();
}

fn token_balance(svm: &LiteSVM, ta: &Pubkey) -> u64 {
    let account = svm.get_account(ta).unwrap();
    spl_token::state::Account::unpack(&account.data).unwrap().amount
}

fn now(svm: &LiteSVM) -> i64 {
    svm.get_sysvar::<Clock>().unix_timestamp
}

fn warp_forward(svm: &mut LiteSVM, secs: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp += secs;
    svm.set_sysvar(&clock);
}

fn deposit_pda(intent_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"deposit", intent_id.as_ref()], &paperarena::id()).0
}

fn match_pda(match_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"match", match_id.as_ref()], &paperarena::id()).0
}

fn settlement_pda(match_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"settlement", match_id.as_ref()], &paperarena::id()).0
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/paperarena.so"));
    svm.add_program(paperarena::id(), bytes).unwrap();

    let admin = Keypair::new();
    let game_authority = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&game_authority.pubkey(), 10_000_000_000).unwrap();

    let mint = create_mint(&mut svm, &admin);
    let treasury_owner = Keypair::new();
    let treasury_ta = create_token_account(&mut svm, &admin, &mint, &treasury_owner.pubkey());

    let config = Pubkey::find_program_address(&[b"config"], &paperarena::id()).0;
    let vault = Pubkey::find_program_address(&[b"vault"], &paperarena::id()).0;

    let ix = Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::InitializeConfig {
            admin: admin.pubkey(),
            config,
            token_mint: mint,
            vault,
            treasury_token_account: treasury_ta,
            token_program: spl_token::id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: paperarena::instruction::InitializeConfig {
            game_authority: game_authority.pubkey(),
            fee_bps: FEE_BPS,
            max_deposit_ttl_secs: MAX_TTL,
        }
        .data(),
    };
    send(&mut svm, &admin, &[ix], &[]).unwrap();

    Env {
        svm,
        admin,
        game_authority,
        mint,
        treasury_ta,
        config,
        vault,
    }
}

fn make_player(env: &mut Env, fund: u64) -> (Keypair, Pubkey) {
    let player = Keypair::new();
    env.svm.airdrop(&player.pubkey(), 1_000_000_000).unwrap();
    let ta = create_token_account(&mut env.svm, &player, &env.mint, &player.pubkey());
    if fund > 0 {
        let admin = env.admin.insecure_clone();
        mint_to(&mut env.svm, &admin, &env.mint, &ta, fund);
    }
    (player, ta)
}

#[allow(clippy::too_many_arguments)]
fn deposit_ix(
    env: &Env,
    player: &Pubkey,
    player_ta: &Pubkey,
    intent_id: [u8; 32],
    amount: u64,
    arena: ArenaType,
    wager_tier_usd: u8,
    expires_at: i64,
) -> Instruction {
    Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::Deposit {
            player: *player,
            config: env.config,
            deposit_escrow: deposit_pda(&intent_id),
            token_mint: env.mint,
            player_token_account: *player_ta,
            vault: env.vault,
            token_program: spl_token::id(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: paperarena::instruction::Deposit {
            intent_id,
            amount,
            arena,
            wager_tier_usd,
            expires_at,
        }
        .data(),
    }
}

fn do_deposit(env: &mut Env, player: &Keypair, ta: &Pubkey, intent_id: [u8; 32], amount: u64, tier: u8) -> TxResult {
    let expires = now(&env.svm) + 600;
    let ix = deposit_ix(env, &player.pubkey(), ta, intent_id, amount, ArenaType::Standard, tier, expires);
    send(&mut env.svm, player, &[ix], &[])
}

fn lock_ix(env: &Env, match_id: [u8; 32], deposits: &[Pubkey]) -> Instruction {
    let mut accounts = paperarena::accounts::LockMatch {
        game_authority: env.game_authority.pubkey(),
        config: env.config,
        match_escrow: match_pda(&match_id),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for d in deposits {
        accounts.push(AccountMeta::new(*d, false));
    }
    Instruction {
        program_id: paperarena::id(),
        accounts,
        data: paperarena::instruction::LockMatch { match_id }.data(),
    }
}

fn do_lock(env: &mut Env, match_id: [u8; 32], deposits: &[Pubkey]) -> TxResult {
    let ix = lock_ix(env, match_id, deposits);
    let ga = env.game_authority.insecure_clone();
    send(&mut env.svm, &ga, &[ix], &[])
}

fn settle_ix(env: &Env, match_id: [u8; 32], payouts: Vec<PayoutInput>, recipients: &[Pubkey]) -> Instruction {
    let mut accounts = paperarena::accounts::SettleMatch {
        game_authority: env.game_authority.pubkey(),
        config: env.config,
        match_escrow: match_pda(&match_id),
        settlement_record: settlement_pda(&match_id),
        vault: env.vault,
        treasury_token_account: env.treasury_ta,
        token_program: spl_token::id(),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    for r in recipients {
        accounts.push(AccountMeta::new(*r, false));
    }
    Instruction {
        program_id: paperarena::id(),
        accounts,
        data: paperarena::instruction::SettleMatch {
            match_id,
            idempotency_key: [7u8; 32],
            result_hash: [9u8; 32],
            payouts,
        }
        .data(),
    }
}

fn do_settle(env: &mut Env, match_id: [u8; 32], payouts: Vec<PayoutInput>, recipients: &[Pubkey]) -> TxResult {
    let ix = settle_ix(env, match_id, payouts, recipients);
    let ga = env.game_authority.insecure_clone();
    send(&mut env.svm, &ga, &[ix], &[])
}

fn intent(n: u8) -> [u8; 32] {
    [n; 32]
}

fn read_escrow(env: &Env, intent_id: &[u8; 32]) -> DepositEscrow {
    let account = env.svm.get_account(&deposit_pda(intent_id)).unwrap();
    DepositEscrow::try_deserialize(&mut &account.data[..]).unwrap()
}

fn read_match(env: &Env, match_id: &[u8; 32]) -> MatchEscrow {
    let account = env.svm.get_account(&match_pda(match_id)).unwrap();
    MatchEscrow::try_deserialize(&mut &account.data[..]).unwrap()
}

fn locked_match(env: &mut Env, match_id: [u8; 32]) -> Vec<(Keypair, Pubkey, Pubkey)> {
    let mut out = Vec::new();
    for n in 1..=2u8 {
        let (player, ta) = make_player(env, USD5);
        do_deposit(env, &player, &ta, intent(n), USD5, 5).unwrap();
        out.push((player, ta, deposit_pda(&intent(n))));
    }
    let deposits: Vec<Pubkey> = out.iter().map(|p| p.2).collect();
    do_lock(env, match_id, &deposits).unwrap();
    out
}

#[test]
fn deposit_succeeds_and_records_escrow() {
    let mut env = setup();
    let (player, ta) = make_player(&mut env, USD5);

    do_deposit(&mut env, &player, &ta, intent(1), USD5, 5).unwrap();

    assert_eq!(token_balance(&env.svm, &env.vault), USD5);
    assert_eq!(token_balance(&env.svm, &ta), 0);
    let escrow = read_escrow(&env, &intent(1));
    assert_eq!(escrow.player, player.pubkey());
    assert_eq!(escrow.amount, USD5);
    assert_eq!(escrow.status, DepositStatus::Funded);
    assert_eq!(escrow.wager_tier_usd, 5);
}

#[test]
fn deposit_rejects_wrong_amount() {
    let mut env = setup();
    let (player, ta) = make_player(&mut env, USD10);
    let res = do_deposit(&mut env, &player, &ta, intent(1), USD5 + 1, 5);
    assert_custom_err(res, ErrorCode::InvalidAmount);
}

#[test]
fn deposit_rejects_invalid_tier() {
    let mut env = setup();
    let (player, ta) = make_player(&mut env, USD10);
    let res = do_deposit(&mut env, &player, &ta, intent(1), 7_000_000, 7);
    assert_custom_err(res, ErrorCode::InvalidWagerTier);
}

#[test]
fn deposit_rejects_reused_intent() {
    let mut env = setup();
    let (player, ta) = make_player(&mut env, USD5 * 2);
    do_deposit(&mut env, &player, &ta, intent(1), USD5, 5).unwrap();
    env.svm.expire_blockhash();
    let res = do_deposit(&mut env, &player, &ta, intent(1), USD5, 5);
    assert!(res.is_err(), "second deposit with same intent id must fail");
}

#[test]
fn deposit_rejects_expiry_beyond_max_ttl() {
    let mut env = setup();
    let (player, ta) = make_player(&mut env, USD5);
    let expires = now(&env.svm) + MAX_TTL + 60;
    let ix = deposit_ix(&env, &player.pubkey(), &ta, intent(1), USD5, ArenaType::Standard, 5, expires);
    let res = send(&mut env.svm, &player, &[ix], &[]);
    assert_custom_err(res, ErrorCode::InvalidExpiry);
}

#[test]
fn deposit_rejects_when_paused() {
    let mut env = setup();
    let pause = Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::SetPause {
            admin: env.admin.pubkey(),
            config: env.config,
        }
        .to_account_metas(None),
        data: paperarena::instruction::SetPause {
            deposits_paused: true,
            locks_paused: false,
            settlements_paused: false,
        }
        .data(),
    };
    let admin = env.admin.insecure_clone();
    send(&mut env.svm, &admin, &[pause], &[]).unwrap();

    let (player, ta) = make_player(&mut env, USD5);
    let res = do_deposit(&mut env, &player, &ta, intent(1), USD5, 5);
    assert_custom_err(res, ErrorCode::DepositsPaused);
}

#[test]
fn lock_succeeds_and_consumes_deposits() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);

    let m = read_match(&env, &match_id);
    assert_eq!(m.status, MatchStatus::Locked);
    assert_eq!(m.total_locked, USD5 * 2);
    assert_eq!(m.players.len(), 2);

    for (n, (_, _, _)) in players.iter().enumerate() {
        let escrow = read_escrow(&env, &intent(n as u8 + 1));
        assert_eq!(escrow.status, DepositStatus::Consumed);
        assert_eq!(escrow.match_id, match_id);
    }
}

#[test]
fn lock_rejects_mixed_tiers() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD10);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    do_deposit(&mut env, &p2, &ta2, intent(2), USD10, 10).unwrap();
    let res = do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]);
    assert_custom_err(res, ErrorCode::MixedWagerTiers);
}

#[test]
fn lock_rejects_mixed_arenas() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    let expires = now(&env.svm) + 600;
    let ix = deposit_ix(&env, &p2.pubkey(), &ta2, intent(2), USD5, ArenaType::Mega, 5, expires);
    send(&mut env.svm, &p2, &[ix], &[]).unwrap();
    let res = do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]);
    assert_custom_err(res, ErrorCode::MixedArenas);
}

#[test]
fn lock_rejects_unauthorized_signer() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    do_deposit(&mut env, &p2, &ta2, intent(2), USD5, 5).unwrap();

    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    let mut ix = lock_ix(&env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]);
    ix.accounts[0] = AccountMeta::new(intruder.pubkey(), true);
    let res = send(&mut env.svm, &intruder, &[ix], &[]);
    assert!(res.is_err(), "lock by non-game-authority must fail");
}

#[test]
fn lock_rejects_already_consumed_deposit() {
    let mut env = setup();
    locked_match(&mut env, [42u8; 32]);
    let (p3, ta3) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p3, &ta3, intent(3), USD5, 5).unwrap();
    let res = do_lock(&mut env, [43u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(3))]);
    assert_custom_err(res, ErrorCode::DepositNotFunded);
}

#[test]
fn lock_rejects_expired_deposit() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    do_deposit(&mut env, &p2, &ta2, intent(2), USD5, 5).unwrap();
    warp_forward(&mut env.svm, 601);
    let res = do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]);
    assert_custom_err(res, ErrorCode::DepositExpired);
}

#[test]
fn lock_rejects_single_player() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    let res = do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1))]);
    assert_custom_err(res, ErrorCode::InvalidPlayerCount);
}

#[test]
fn settle_pays_winner_fee_and_residual() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);
    let winner_ta = players[0].1;

    let gross = USD5 * 2 * 8 / 10;
    do_settle(&mut env, match_id, vec![PayoutInput { player_index: 0, gross }], &[winner_ta]).unwrap();

    let fee = gross * FEE_BPS as u64 / 10_000;
    let residual = USD5 * 2 - gross;
    assert_eq!(token_balance(&env.svm, &winner_ta), gross - fee);
    assert_eq!(token_balance(&env.svm, &env.treasury_ta), fee + residual);
    assert_eq!(token_balance(&env.svm, &env.vault), 0);

    let m = read_match(&env, &match_id);
    assert_eq!(m.status, MatchStatus::Settled);

    let record_account = env.svm.get_account(&settlement_pda(&match_id)).unwrap();
    let record = SettlementRecord::try_deserialize(&mut &record_account.data[..]).unwrap();
    assert_eq!(record.total_gross, gross);
    assert_eq!(record.total_fee, fee);
    assert_eq!(record.residual_to_treasury, residual);
}

#[test]
fn settle_rejects_double_settlement() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);
    let winner_ta = players[0].1;
    do_settle(&mut env, match_id, vec![PayoutInput { player_index: 0, gross: USD5 }], &[winner_ta]).unwrap();
    env.svm.expire_blockhash();
    let res = do_settle(&mut env, match_id, vec![PayoutInput { player_index: 0, gross: USD5 }], &[winner_ta]);
    assert!(res.is_err(), "second settlement for the same match must fail");
}

#[test]
fn settle_rejects_overpayment() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);
    let winner_ta = players[0].1;
    let res = do_settle(
        &mut env,
        match_id,
        vec![PayoutInput { player_index: 0, gross: USD5 * 2 + 1 }],
        &[winner_ta],
    );
    assert_custom_err(res, ErrorCode::PayoutExceedsPot);
}

#[test]
fn settle_rejects_unauthorized_signer() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);
    let winner_ta = players[0].1;

    let intruder = Keypair::new();
    env.svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    let mut ix = settle_ix(&env, match_id, vec![PayoutInput { player_index: 0, gross: USD5 }], &[winner_ta]);
    ix.accounts[0] = AccountMeta::new(intruder.pubkey(), true);
    let res = send(&mut env.svm, &intruder, &[ix], &[]);
    assert!(res.is_err(), "settlement by non-game-authority must fail");
}

#[test]
fn settle_rejects_recipient_outside_match() {
    let mut env = setup();
    let match_id = [42u8; 32];
    locked_match(&mut env, match_id);
    let (_outsider, outsider_ta) = make_player(&mut env, 0);
    let res = do_settle(
        &mut env,
        match_id,
        vec![PayoutInput { player_index: 0, gross: USD5 }],
        &[outsider_ta],
    );
    assert_custom_err(res, ErrorCode::WrongRecipientAccount);
}

#[test]
fn refund_deposit_by_authority_and_by_player_after_expiry() {
    let mut env = setup();
    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    do_deposit(&mut env, &p2, &ta2, intent(2), USD5, 5).unwrap();

    let refund = |env: &Env, signer: &Pubkey, intent_id: [u8; 32], ta: Pubkey| Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::RefundDeposit {
            authority: *signer,
            config: env.config,
            deposit_escrow: deposit_pda(&intent_id),
            vault: env.vault,
            player_token_account: ta,
            token_program: spl_token::id(),
        }
        .to_account_metas(None),
        data: paperarena::instruction::RefundDeposit {}.data(),
    };

    let ga = env.game_authority.insecure_clone();
    let ix = refund(&env, &ga.pubkey(), intent(1), ta1);
    send(&mut env.svm, &ga, &[ix], &[]).unwrap();
    assert_eq!(token_balance(&env.svm, &ta1), USD5);
    assert_eq!(read_escrow(&env, &intent(1)).status, DepositStatus::Refunded);

    let ix = refund(&env, &p2.pubkey(), intent(2), ta2);
    let res = send(&mut env.svm, &p2, &[ix], &[]);
    assert_custom_err(res, ErrorCode::DepositNotExpired);

    warp_forward(&mut env.svm, 601);
    env.svm.expire_blockhash();
    let ix = refund(&env, &p2.pubkey(), intent(2), ta2);
    send(&mut env.svm, &p2, &[ix], &[]).unwrap();
    assert_eq!(token_balance(&env.svm, &ta2), USD5);
}

#[test]
fn refund_rejects_consumed_deposit() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);
    let ga = env.game_authority.insecure_clone();
    let ix = Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::RefundDeposit {
            authority: ga.pubkey(),
            config: env.config,
            deposit_escrow: players[0].2,
            vault: env.vault,
            player_token_account: players[0].1,
            token_program: spl_token::id(),
        }
        .to_account_metas(None),
        data: paperarena::instruction::RefundDeposit {}.data(),
    };
    let res = send(&mut env.svm, &ga, &[ix], &[]);
    assert_custom_err(res, ErrorCode::DepositNotRefundable);
}

#[test]
fn refund_match_returns_funds_and_blocks_settlement() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);

    let mut accounts = paperarena::accounts::RefundMatch {
        authority: env.game_authority.pubkey(),
        config: env.config,
        match_escrow: match_pda(&match_id),
        vault: env.vault,
        token_program: spl_token::id(),
    }
    .to_account_metas(None);
    for (_, ta, dep) in &players {
        accounts.push(AccountMeta::new(*dep, false));
        accounts.push(AccountMeta::new(*ta, false));
    }
    let ix = Instruction {
        program_id: paperarena::id(),
        accounts,
        data: paperarena::instruction::RefundMatch {}.data(),
    };
    let ga = env.game_authority.insecure_clone();
    send(&mut env.svm, &ga, &[ix], &[]).unwrap();

    for (_, ta, _) in &players {
        assert_eq!(token_balance(&env.svm, ta), USD5);
    }
    assert_eq!(read_match(&env, &match_id).status, MatchStatus::Refunded);

    let res = do_settle(&mut env, match_id, vec![PayoutInput { player_index: 0, gross: USD5 }], &[players[0].1]);
    assert_custom_err(res, ErrorCode::MatchNotLocked);
}

#[test]
fn forfeit_moves_pot_to_treasury_and_blocks_settlement() {
    let mut env = setup();
    let match_id = [42u8; 32];
    let players = locked_match(&mut env, match_id);

    let ix = Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::Forfeit {
            game_authority: env.game_authority.pubkey(),
            config: env.config,
            match_escrow: match_pda(&match_id),
            vault: env.vault,
            treasury_token_account: env.treasury_ta,
            token_program: spl_token::id(),
        }
        .to_account_metas(None),
        data: paperarena::instruction::Forfeit { reason_code: 1 }.data(),
    };
    let ga = env.game_authority.insecure_clone();
    send(&mut env.svm, &ga, &[ix], &[]).unwrap();

    assert_eq!(token_balance(&env.svm, &env.treasury_ta), USD5 * 2);
    assert_eq!(read_match(&env, &match_id).status, MatchStatus::Forfeited);

    let res = do_settle(&mut env, match_id, vec![PayoutInput { player_index: 0, gross: USD5 }], &[players[0].1]);
    assert_custom_err(res, ErrorCode::MatchNotLocked);
}

#[test]
fn update_config_rotates_game_authority() {
    let mut env = setup();
    let new_ga = Keypair::new();
    env.svm.airdrop(&new_ga.pubkey(), 10_000_000_000).unwrap();

    let ix = Instruction {
        program_id: paperarena::id(),
        accounts: paperarena::accounts::UpdateConfig {
            admin: env.admin.pubkey(),
            config: env.config,
            new_treasury_token_account: None,
        }
        .to_account_metas(None),
        data: paperarena::instruction::UpdateConfig {
            new_admin: None,
            new_game_authority: Some(new_ga.pubkey()),
            new_fee_bps: None,
            new_max_deposit_ttl_secs: None,
        }
        .data(),
    };
    let admin = env.admin.insecure_clone();
    send(&mut env.svm, &admin, &[ix], &[]).unwrap();

    let (p1, ta1) = make_player(&mut env, USD5);
    let (p2, ta2) = make_player(&mut env, USD5);
    do_deposit(&mut env, &p1, &ta1, intent(1), USD5, 5).unwrap();
    do_deposit(&mut env, &p2, &ta2, intent(2), USD5, 5).unwrap();
    let res = do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]);
    assert!(res.is_err(), "old game authority must be rejected after rotation");

    env.game_authority = new_ga;
    do_lock(&mut env, [42u8; 32], &[deposit_pda(&intent(1)), deposit_pda(&intent(2))]).unwrap();
    assert_eq!(read_match(&env, &[42u8; 32]).status, MatchStatus::Locked);
}
