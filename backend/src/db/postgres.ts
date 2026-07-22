import pg from "pg";
import { CONFIG } from "../config.js";

const { Pool } = pg;
type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export interface UserDocument {
  id: string;
  displayName?: string;
  status: "active" | "blocked";
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletDocument {
  id: string;
  userId: string;
  chainType: "solana" | "evm";
  chainId: string;
  address: string;
  addressNormalized: string;
  firstVerifiedAt: Date;
  lastVerifiedAt: Date;
  createdAt: Date;
}

export interface AuthChallengeDocument {
  id: string;
  nonceHash: string;
  chainType: "solana" | "evm";
  chainId: string;
  addressNormalized: string;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt?: Date;
  consumedByWalletId?: string;
  ipHash?: string;
  userAgentHash?: string;
  createdAt: Date;
}

export interface SessionDocument {
  id: string;
  userId: string;
  sessionTokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  lastSeenAt: Date;
  ipHash?: string;
  userAgentHash?: string;
}

export interface AuthAuditLogDocument {
  id: string;
  userId?: string;
  walletId?: string;
  eventType: string;
  success: boolean;
  reason?: string;
  ipHash?: string;
  userAgentHash?: string;
  createdAt: Date;
}

export type DepositIntentStatus =
  | "created"
  | "awaiting_payment"
  | "submitted"
  | "verified"
  | "expired"
  | "consumed"
  | "failed"
  | "refunded"
  | "forfeited";

export interface DepositIntentDocument {
  id: string;
  userId: string;
  walletId: string;
  walletAddress: string;
  chainType: "solana" | "evm";
  chainId: string;
  arena: "standard" | "mega";
  wagerUsd: string;
  tokenSymbol?: string;
  tokenMint?: string;
  amountBaseUnits?: string;
  status: DepositIntentStatus;
  contractStatus: "not_configured" | "configured";
  txSignature?: string;
  verificationError?: string;
  idempotencyKey: string;
  expiresAt: Date;
  verifiedAt?: Date;
  consumedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pool = new Pool({
  connectionString: CONFIG.DATABASE_URL,
  max: CONFIG.DATABASE_POOL_MAX,
  ssl: CONFIG.DATABASE_SSL ? { rejectUnauthorized: CONFIG.DATABASE_SSL_REJECT_UNAUTHORIZED } : undefined,
  connectionTimeoutMillis: CONFIG.DATABASE_CONNECTION_TIMEOUT_MS,
});

export const db = {
  async connect() {
    const client = await pool.connect();
    client.release();
  },

  async close() {
    await pool.end();
  },

  async transaction<T>(work: (tx: AuthRepository) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await work(createRepository(client));
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async insertChallenge(challenge: AuthChallengeDocument) {
    await pool.query(
      `insert into auth_challenges (
        id, nonce_hash, chain_type, chain_id, address_normalized, message,
        issued_at, expires_at, ip_hash, user_agent_hash, created_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        challenge.id,
        challenge.nonceHash,
        challenge.chainType,
        challenge.chainId,
        challenge.addressNormalized,
        challenge.message,
        challenge.issuedAt,
        challenge.expiresAt,
        challenge.ipHash,
        challenge.userAgentHash,
        challenge.createdAt,
      ],
    );
  },

  async findChallengeById(id: string) {
    const result = await pool.query(`select * from auth_challenges where id = $1`, [id]);
    return result.rows[0] ? mapChallenge(result.rows[0]) : null;
  },

  async consumeChallenge(id: string, walletId: string, consumedAt: Date) {
    const result = await pool.query(
      `update auth_challenges
       set consumed_at = $2, consumed_by_wallet_id = $3
       where id = $1 and consumed_at is null`,
      [id, consumedAt, walletId],
    );
    return result.rowCount === 1;
  },

  async findWallet(chainType: string, chainId: string, addressNormalized: string) {
    const result = await pool.query(
      `select * from wallets
       where chain_type = $1 and chain_id = $2 and address_normalized = $3`,
      [chainType, chainId, addressNormalized],
    );
    return result.rows[0] ? mapWallet(result.rows[0]) : null;
  },

  async insertWallet(wallet: WalletDocument) {
    await pool.query(
      `insert into wallets (
        id, user_id, chain_type, chain_id, address, address_normalized,
        first_verified_at, last_verified_at, created_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        wallet.id,
        wallet.userId,
        wallet.chainType,
        wallet.chainId,
        wallet.address,
        wallet.addressNormalized,
        wallet.firstVerifiedAt,
        wallet.lastVerifiedAt,
        wallet.createdAt,
      ],
    );
  },

  async updateWalletVerifiedAt(id: string, verifiedAt: Date) {
    await pool.query(`update wallets set last_verified_at = $2 where id = $1`, [id, verifiedAt]);
  },

  async findUserById(id: string) {
    const result = await pool.query(`select * from users where id = $1`, [id]);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  },

  async insertUser(user: UserDocument) {
    await pool.query(
      `insert into users (id, display_name, status, created_at, updated_at)
       values ($1,$2,$3,$4,$5)`,
      [user.id, user.displayName, user.status, user.createdAt, user.updatedAt],
    );
  },

  async updateUserDisplayName(id: string, displayName: string, updatedAt: Date) {
    const result = await pool.query(
      `update users
       set display_name = $2,
           updated_at = $3
       where id = $1
       returning *`,
      [id, displayName, updatedAt],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  },

  async insertSession(session: SessionDocument) {
    await pool.query(
      `insert into sessions (
        id, user_id, session_token_hash, created_at, expires_at,
        last_seen_at, ip_hash, user_agent_hash
      ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        session.id,
        session.userId,
        session.sessionTokenHash,
        session.createdAt,
        session.expiresAt,
        session.lastSeenAt,
        session.ipHash,
        session.userAgentHash,
      ],
    );
  },

  async findActiveSession(sessionTokenHash: string, now = new Date()) {
    const result = await pool.query(
      `select * from sessions
       where session_token_hash = $1
         and revoked_at is null
         and expires_at > $2`,
      [sessionTokenHash, now],
    );
    return result.rows[0] ? mapSession(result.rows[0]) : null;
  },

  async updateSessionLastSeen(id: string, lastSeenAt: Date) {
    await pool.query(`update sessions set last_seen_at = $2 where id = $1`, [id, lastSeenAt]);
  },

  async revokeSession(sessionTokenHash: string, now = new Date()) {
    await pool.query(
      `update sessions
       set revoked_at = $2
       where session_token_hash = $1
         and revoked_at is null
         and expires_at > $2`,
      [sessionTokenHash, now],
    );
  },

  async findWalletsByUserId(userId: string) {
    const result = await pool.query(`select * from wallets where user_id = $1 order by created_at asc`, [userId]);
    return result.rows.map(mapWallet);
  },

  async insertAuditLog(log: AuthAuditLogDocument) {
    await createRepository(pool).insertAuditLog(log);
  },

  async insertDepositIntent(intent: DepositIntentDocument) {
    await pool.query(
      `insert into deposit_intents (
        id, user_id, wallet_id, wallet_address, chain_type, chain_id,
        arena, wager_usd, token_symbol, token_mint, amount_base_units,
        status, contract_status, tx_signature, verification_error,
        idempotency_key, expires_at, verified_at, consumed_at, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        intent.id,
        intent.userId,
        intent.walletId,
        intent.walletAddress,
        intent.chainType,
        intent.chainId,
        intent.arena,
        intent.wagerUsd,
        intent.tokenSymbol,
        intent.tokenMint,
        intent.amountBaseUnits,
        intent.status,
        intent.contractStatus,
        intent.txSignature,
        intent.verificationError,
        intent.idempotencyKey,
        intent.expiresAt,
        intent.verifiedAt,
        intent.consumedAt,
        intent.createdAt,
        intent.updatedAt,
      ],
    );
  },

  async findDepositIntentById(id: string) {
    const result = await pool.query(`select * from deposit_intents where id = $1`, [id]);
    return result.rows[0] ? mapDepositIntent(result.rows[0]) : null;
  },

  async findLatestDepositIntent(args: {
    userId: string;
    walletId: string;
    arena: string;
    wagerUsd: string;
  }) {
    const result = await pool.query(
      `select * from deposit_intents
       where user_id = $1
         and wallet_id = $2
         and arena = $3
         and wager_usd = $4
         and consumed_at is null
       order by created_at desc
       limit 1`,
      [args.userId, args.walletId, args.arena, args.wagerUsd],
    );
    return result.rows[0] ? mapDepositIntent(result.rows[0]) : null;
  },

  async consumeVerifiedDepositIntent(args: {
    id: string;
    userId?: string;
    walletId?: string;
    arena: string;
    wagerUsd: string;
    consumedAt: Date;
    allowMissingUser?: boolean;
  }) {
    const result = await pool.query(
      `update deposit_intents
       set status = 'consumed',
           consumed_at = $4,
           updated_at = $4
       where id = $1
         and arena = $2
         and wager_usd = $3
         and status = 'verified'
         and consumed_at is null
         and expires_at > $4
         and verification_error is distinct from 'refunding'
         and ($5::uuid is null or user_id = $5)
         and ($6::uuid is null or wallet_id = $6)`,
      [
        args.id,
        args.arena,
        args.wagerUsd,
        args.consumedAt,
        args.userId ?? null,
        args.walletId ?? null,
      ],
    );
    return result.rowCount === 1;
  },

  /** Reverse a pre-lock consume if the on-chain lock fails. */
  async releaseConsumedDepositIntent(args: { id: string; updatedAt: Date }) {
    const result = await pool.query(
      `update deposit_intents
       set status = 'verified',
           consumed_at = null,
           updated_at = $2
       where id = $1
         and status = 'consumed'`,
      [args.id, args.updatedAt],
    );
    return result.rowCount === 1;
  },

  /**
   * Soft-claim a deposit for refund (concurrency guard).
   * Only refundable DB statuses; never consumed / refunded / forfeited.
   */
  async claimDepositIntentForRefund(args: {
    id: string;
    userId: string;
    walletId: string;
    claimedAt: Date;
    staleBefore: Date;
  }) {
    const result = await pool.query(
      `update deposit_intents
       set verification_error = 'refunding',
           updated_at = $4
       where id = $1
         and user_id = $2
         and wallet_id = $3
         and consumed_at is null
         and status = any($5::text[])
         and (
           verification_error is distinct from 'refunding'
           or updated_at < $6
         )
       returning *`,
      [
        args.id,
        args.userId,
        args.walletId,
        args.claimedAt,
        ["verified", "awaiting_payment", "submitted", "expired", "failed"],
        args.staleBefore,
      ],
    );
    return result.rows[0] ? mapDepositIntent(result.rows[0] as Record<string, unknown>) : null;
  },

  async markDepositIntentRefunded(args: {
    id: string;
    updatedAt: Date;
    /** Optional note; does not overwrite deposit tx_signature. */
    note?: string | null;
  }) {
    const result = await pool.query(
      `update deposit_intents
       set status = 'refunded',
           verification_error = $3,
           consumed_at = null,
           updated_at = $2
       where id = $1
         and status is distinct from 'refunded'`,
      [args.id, args.updatedAt, args.note ?? null],
    );
    return result.rowCount === 1;
  },

  async clearDepositRefundClaim(args: { id: string; updatedAt: Date }) {
    await pool.query(
      `update deposit_intents
       set verification_error = null,
           updated_at = $2
       where id = $1
         and verification_error = 'refunding'
         and status is distinct from 'refunded'`,
      [args.id, args.updatedAt],
    );
  },

  /** Active/finished match paths that must never be refunded at deposit level. */
  async findBlockingMatchLocksForDeposit(depositIntentId: string) {
    const result = await pool.query(
      `select l.match_id, l.status, l.on_chain_match_id_hex, l.updated_at
       from match_fund_lock_players p
       join match_fund_locks l on l.id = p.match_fund_lock_id
       where p.deposit_intent_id = $1
         and l.status = any($2::text[])
       order by l.updated_at desc
       limit 5`,
      [
        depositIntentId,
        ["created", "locked", "settling", "settled", "forfeiting", "forfeited"],
      ],
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        matchId: String(r.match_id),
        status: String(r.status),
        onChainMatchIdHex: r.on_chain_match_id_hex
          ? String(r.on_chain_match_id_hex)
          : undefined,
        updatedAt: r.updated_at as Date,
      };
    });
  },

  async findRefundableDepositIntents(args: {
    userId: string;
    walletId: string;
    limit?: number;
  }) {
    const result = await pool.query(
      `select *
       from deposit_intents
       where user_id = $1
         and wallet_id = $2
         and consumed_at is null
         and status = any($3::text[])
       order by created_at desc
       limit $4`,
      [
        args.userId,
        args.walletId,
        ["verified", "awaiting_payment", "submitted", "expired"],
        args.limit ?? 20,
      ],
    );
    return result.rows.map((row) => mapDepositIntent(row as Record<string, unknown>));
  },

  /** Expired unused deposits for recovery auto-refund (DB expired or past expires_at). */
  async findExpiredUnusedDepositsForRefund(args: { olderThan: Date; limit?: number }) {
    const result = await pool.query(
      `select *
       from deposit_intents
       where consumed_at is null
         and status = any($1::text[])
         and expires_at < $2
         and (verification_error is distinct from 'refunding' or updated_at < $2)
       order by expires_at asc
       limit $3`,
      [["verified", "awaiting_payment", "submitted", "expired"], args.olderThan, args.limit ?? 20],
    );
    return result.rows.map((row) => mapDepositIntent(row as Record<string, unknown>));
  },

  async consumeVerifiedDepositIntentsAtomic(args: {
    ids: string[];
    arena: string;
    wagerUsd: string;
    consumedAt: Date;
  }) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const consumed: string[] = [];
      for (const id of args.ids) {
        const result = await client.query(
          `update deposit_intents
           set status = 'consumed',
               consumed_at = $4,
               updated_at = $4
           where id = $1
             and arena = $2
             and wager_usd = $3
             and status = 'verified'
             and consumed_at is null
             and expires_at > $4
             and verification_error is distinct from 'refunding'`,
          [id, args.arena, args.wagerUsd, args.consumedAt],
        );
        if (result.rowCount !== 1) {
          await client.query("rollback");
          return { ok: false as const, consumed: [] as string[] };
        }
        consumed.push(id);
      }
      await client.query("commit");
      return { ok: true as const, consumed };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async updateDepositIntent(args: {
    id: string;
    status?: DepositIntentStatus;
    txSignature?: string | null;
    verifiedAt?: Date | null;
    verificationError?: string | null;
    tokenMint?: string | null;
    tokenSymbol?: string | null;
    amountBaseUnits?: string | null;
    updatedAt: Date;
  }) {
    await pool.query(
      `update deposit_intents
       set status = coalesce($2, status),
           tx_signature = case when $3::bool then $4 else tx_signature end,
           verified_at = case when $5::bool then $6 else verified_at end,
           verification_error = case when $7::bool then $8 else verification_error end,
           token_mint = case when $9::bool then $10 else token_mint end,
           token_symbol = case when $11::bool then $12 else token_symbol end,
           amount_base_units = case when $13::bool then $14 else amount_base_units end,
           updated_at = $15
       where id = $1`,
      [
        args.id,
        args.status ?? null,
        args.txSignature !== undefined,
        args.txSignature ?? null,
        args.verifiedAt !== undefined,
        args.verifiedAt ?? null,
        args.verificationError !== undefined,
        args.verificationError ?? null,
        args.tokenMint !== undefined,
        args.tokenMint ?? null,
        args.tokenSymbol !== undefined,
        args.tokenSymbol ?? null,
        args.amountBaseUnits !== undefined,
        args.amountBaseUnits ?? null,
        args.updatedAt,
      ],
    );
  },

  async insertMatchFundLock(args: {
    id: string;
    matchId: string;
    arena: string;
    wagerUsd: string;
    tokenSymbol?: string;
    tokenMint?: string;
    totalBaseUnits?: string;
    status: string;
    onChainMatchIdHex?: string;
    lockTxSignature?: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    await pool.query(
      `insert into match_fund_locks (
        id, match_id, arena, wager_usd, token_symbol, token_mint, total_base_units,
        status, on_chain_match_id_hex, lock_tx_signature, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      on conflict (match_id) do update set
        status = excluded.status,
        on_chain_match_id_hex = excluded.on_chain_match_id_hex,
        lock_tx_signature = excluded.lock_tx_signature,
        total_base_units = excluded.total_base_units,
        updated_at = excluded.updated_at`,
      [
        args.id,
        args.matchId,
        args.arena,
        args.wagerUsd,
        args.tokenSymbol ?? null,
        args.tokenMint ?? null,
        args.totalBaseUnits ?? null,
        args.status,
        args.onChainMatchIdHex ?? null,
        args.lockTxSignature ?? null,
        args.createdAt,
        args.updatedAt,
      ],
    );
  },

  async findMatchFundLockByMatchId(matchId: string) {
    const result = await pool.query(`select * from match_fund_locks where match_id = $1`, [matchId]);
    if (!result.rows[0]) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      matchId: String(row.match_id),
      arena: String(row.arena),
      wagerUsd: String(row.wager_usd),
      tokenSymbol: row.token_symbol ? String(row.token_symbol) : undefined,
      tokenMint: row.token_mint ? String(row.token_mint) : undefined,
      totalBaseUnits: row.total_base_units ? String(row.total_base_units) : undefined,
      status: String(row.status),
      onChainMatchIdHex: row.on_chain_match_id_hex ? String(row.on_chain_match_id_hex) : undefined,
      lockTxSignature: row.lock_tx_signature ? String(row.lock_tx_signature) : undefined,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  },

  async updateMatchFundLockStatus(args: {
    matchId: string;
    status: string;
    updatedAt: Date;
    lockTxSignature?: string;
    error?: string;
  }) {
    await pool.query(
      `update match_fund_locks
       set status = $2,
           updated_at = $3,
           lock_tx_signature = coalesce($4, lock_tx_signature)
       where match_id = $1`,
      [args.matchId, args.status, args.updatedAt, args.lockTxSignature ?? null],
    );
  },

  async findStuckMatchFundLocks(args: {
    statuses: string[];
    olderThan: Date;
    limit?: number;
  }) {
    const result = await pool.query(
      `select * from match_fund_locks
       where status = any($1::text[])
         and updated_at < $2
       order by updated_at asc
       limit $3`,
      [args.statuses, args.olderThan, args.limit ?? 40],
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        matchId: String(r.match_id),
        arena: String(r.arena),
        wagerUsd: String(r.wager_usd),
        tokenSymbol: r.token_symbol ? String(r.token_symbol) : undefined,
        tokenMint: r.token_mint ? String(r.token_mint) : undefined,
        totalBaseUnits: r.total_base_units ? String(r.total_base_units) : undefined,
        status: String(r.status),
        onChainMatchIdHex: r.on_chain_match_id_hex ? String(r.on_chain_match_id_hex) : undefined,
        lockTxSignature: r.lock_tx_signature ? String(r.lock_tx_signature) : undefined,
        createdAt: r.created_at as Date,
        updatedAt: r.updated_at as Date,
      };
    });
  },

  async findSettlementAttemptsForMatch(matchId: string) {
    const result = await pool.query(
      `select * from settlement_attempts
       where match_id = $1
       order by created_at desc
       limit 10`,
      [matchId],
    );
    return result.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        matchId: String(r.match_id),
        idempotencyKey: String(r.idempotency_key),
        resultHash: String(r.result_hash),
        payoutHash: String(r.payout_hash),
        status: String(r.status),
        txSignature: r.tx_signature ? String(r.tx_signature) : undefined,
        error: r.error ? String(r.error) : undefined,
        createdAt: r.created_at as Date,
        updatedAt: r.updated_at as Date,
      };
    });
  },

  async findDepositIntentsByMatchLock(matchId: string) {
    // Intents linked only via timing/wallet is weak; recovery uses consumed intents near lock time.
    // Prefer match_fund_lock_players when populated.
    const linked = await pool.query(
      `select di.*
       from match_fund_lock_players p
       join match_fund_locks l on l.id = p.match_fund_lock_id
       join deposit_intents di on di.id = p.deposit_intent_id
       where l.match_id = $1`,
      [matchId],
    );
    if (linked.rows.length > 0) {
      return linked.rows.map((row) => mapDepositIntent(row as Record<string, unknown>));
    }
    return [] as DepositIntentDocument[];
  },

  async insertMatchFundLockPlayer(args: {
    id: string;
    matchFundLockId: string;
    walletId: string;
    walletAddress: string;
    depositIntentId: string;
    amountBaseUnits?: string;
    createdAt: Date;
  }) {
    await pool.query(
      `insert into match_fund_lock_players (
        id, match_fund_lock_id, wallet_id, wallet_address, deposit_intent_id, amount_base_units, created_at
      ) values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (deposit_intent_id) do nothing`,
      [
        args.id,
        args.matchFundLockId,
        args.walletId,
        args.walletAddress,
        args.depositIntentId,
        args.amountBaseUnits ?? null,
        args.createdAt,
      ],
    );
  },

  async insertSettlementAttempt(args: {
    id: string;
    matchId: string;
    idempotencyKey: string;
    resultHash: string;
    payoutHash: string;
    status: string;
    txSignature?: string;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
  }): Promise<{ id: string; status: string; txSignature?: string; created: boolean }> {
    const result = await pool.query(
      `insert into settlement_attempts (
        id, match_id, idempotency_key, result_hash, payout_hash, status, tx_signature, error, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (idempotency_key) do update
        set updated_at = settlement_attempts.updated_at
      returning id, status, tx_signature, (xmax = 0) as inserted`,
      [
        args.id,
        args.matchId,
        args.idempotencyKey,
        args.resultHash,
        args.payoutHash,
        args.status,
        args.txSignature ?? null,
        args.error ?? null,
        args.createdAt,
        args.updatedAt,
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      status: String(row.status),
      txSignature: row.tx_signature ? String(row.tx_signature) : undefined,
      created: Boolean(row.inserted),
    };
  },

  async updateSettlementAttempt(args: {
    id: string;
    status: string;
    txSignature?: string;
    error?: string;
    updatedAt: Date;
  }) {
    await pool.query(
      `update settlement_attempts
       set status = $2,
           tx_signature = coalesce($3, tx_signature),
           error = coalesce($4, error),
           updated_at = $5
       where id = $1`,
      [args.id, args.status, args.txSignature ?? null, args.error ?? null, args.updatedAt],
    );
  },

  async findSettlementAttemptByIdempotencyKey(idempotencyKey: string) {
    const result = await pool.query(
      `select * from settlement_attempts where idempotency_key = $1`,
      [idempotencyKey],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      matchId: String(row.match_id),
      idempotencyKey: String(row.idempotency_key),
      resultHash: String(row.result_hash),
      payoutHash: String(row.payout_hash),
      status: String(row.status),
      txSignature: row.tx_signature ? String(row.tx_signature) : undefined,
      error: row.error ? String(row.error) : undefined,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    };
  },
};

export type AuthRepository = ReturnType<typeof createRepository>;

function createRepository(queryable: Queryable) {
  return {
    async findChallengeById(id: string) {
      const result = await queryable.query(`select * from auth_challenges where id = $1`, [id]);
      return result.rows[0] ? mapChallenge(result.rows[0]) : null;
    },

    async consumeChallenge(id: string, walletId: string, consumedAt: Date) {
      const result = await queryable.query(
        `update auth_challenges
         set consumed_at = $2, consumed_by_wallet_id = $3
         where id = $1 and consumed_at is null`,
        [id, consumedAt, walletId],
      );
      return result.rowCount === 1;
    },

    async findWallet(chainType: string, chainId: string, addressNormalized: string) {
      const result = await queryable.query(
        `select * from wallets
         where chain_type = $1 and chain_id = $2 and address_normalized = $3`,
        [chainType, chainId, addressNormalized],
      );
      return result.rows[0] ? mapWallet(result.rows[0]) : null;
    },

    async insertWallet(wallet: WalletDocument) {
      await queryable.query(
        `insert into wallets (
          id, user_id, chain_type, chain_id, address, address_normalized,
          first_verified_at, last_verified_at, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          wallet.id,
          wallet.userId,
          wallet.chainType,
          wallet.chainId,
          wallet.address,
          wallet.addressNormalized,
          wallet.firstVerifiedAt,
          wallet.lastVerifiedAt,
          wallet.createdAt,
        ],
      );
    },

    async updateWalletVerifiedAt(id: string, verifiedAt: Date) {
      await queryable.query(`update wallets set last_verified_at = $2 where id = $1`, [id, verifiedAt]);
    },

    async findUserById(id: string) {
      const result = await queryable.query(`select * from users where id = $1`, [id]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async insertUser(user: UserDocument) {
      await queryable.query(
        `insert into users (id, display_name, status, created_at, updated_at)
         values ($1,$2,$3,$4,$5)`,
        [user.id, user.displayName, user.status, user.createdAt, user.updatedAt],
      );
    },

    async insertSession(session: SessionDocument) {
      await queryable.query(
        `insert into sessions (
          id, user_id, session_token_hash, created_at, expires_at,
          last_seen_at, ip_hash, user_agent_hash
        ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          session.id,
          session.userId,
          session.sessionTokenHash,
          session.createdAt,
          session.expiresAt,
          session.lastSeenAt,
          session.ipHash,
          session.userAgentHash,
        ],
      );
    },

    async insertAuditLog(log: AuthAuditLogDocument) {
      await queryable.query(
        `insert into auth_audit_logs (
          id, user_id, wallet_id, event_type, success, reason,
          ip_hash, user_agent_hash, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          log.id,
          log.userId,
          log.walletId,
          log.eventType,
          log.success,
          log.reason,
          log.ipHash,
          log.userAgentHash,
          log.createdAt,
        ],
      );
    },
  };
}

function mapUser(row: Record<string, unknown>): UserDocument {
  return {
    id: String(row.id),
    displayName: row.display_name ? String(row.display_name) : undefined,
    status: row.status as "active" | "blocked",
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function mapWallet(row: Record<string, unknown>): WalletDocument {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    chainType: row.chain_type as "solana" | "evm",
    chainId: String(row.chain_id),
    address: String(row.address),
    addressNormalized: String(row.address_normalized),
    firstVerifiedAt: row.first_verified_at as Date,
    lastVerifiedAt: row.last_verified_at as Date,
    createdAt: row.created_at as Date,
  };
}

function mapChallenge(row: Record<string, unknown>): AuthChallengeDocument {
  return {
    id: String(row.id),
    nonceHash: String(row.nonce_hash),
    chainType: row.chain_type as "solana" | "evm",
    chainId: String(row.chain_id),
    addressNormalized: String(row.address_normalized),
    message: String(row.message),
    issuedAt: row.issued_at as Date,
    expiresAt: row.expires_at as Date,
    consumedAt: row.consumed_at ? (row.consumed_at as Date) : undefined,
    consumedByWalletId: row.consumed_by_wallet_id ? String(row.consumed_by_wallet_id) : undefined,
    ipHash: row.ip_hash ? String(row.ip_hash) : undefined,
    userAgentHash: row.user_agent_hash ? String(row.user_agent_hash) : undefined,
    createdAt: row.created_at as Date,
  };
}

function mapSession(row: Record<string, unknown>): SessionDocument {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    sessionTokenHash: String(row.session_token_hash),
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
    revokedAt: row.revoked_at ? (row.revoked_at as Date) : undefined,
    lastSeenAt: row.last_seen_at as Date,
    ipHash: row.ip_hash ? String(row.ip_hash) : undefined,
    userAgentHash: row.user_agent_hash ? String(row.user_agent_hash) : undefined,
  };
}

function mapDepositIntent(row: Record<string, unknown>): DepositIntentDocument {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    walletId: String(row.wallet_id),
    walletAddress: String(row.wallet_address),
    chainType: row.chain_type as "solana" | "evm",
    chainId: String(row.chain_id),
    arena: row.arena as "standard" | "mega",
    wagerUsd: String(row.wager_usd),
    tokenSymbol: row.token_symbol ? String(row.token_symbol) : undefined,
    tokenMint: row.token_mint ? String(row.token_mint) : undefined,
    amountBaseUnits: row.amount_base_units ? String(row.amount_base_units) : undefined,
    status: row.status as DepositIntentStatus,
    contractStatus: row.contract_status as "not_configured" | "configured",
    txSignature: row.tx_signature ? String(row.tx_signature) : undefined,
    verificationError: row.verification_error ? String(row.verification_error) : undefined,
    idempotencyKey: String(row.idempotency_key),
    expiresAt: row.expires_at as Date,
    verifiedAt: row.verified_at ? (row.verified_at as Date) : undefined,
    consumedAt: row.consumed_at ? (row.consumed_at as Date) : undefined,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
