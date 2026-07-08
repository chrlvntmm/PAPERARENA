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
