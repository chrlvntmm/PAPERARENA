import { randomUUID } from "node:crypto";
import { CONFIG } from "../config.js";
import { db, type AuthRepository, type SessionDocument, type UserDocument, type WalletDocument } from "../db/postgres.js";
import { hmacToken, randomToken, sha256, hashRequestValue } from "./crypto.js";
import {
  assertValidWalletAddress,
  normalizeWalletAddress,
  verifyWalletSignature,
  type ChainType,
} from "./wallet-verification.js";

export interface RequestFingerprint {
  ip?: string;
  userAgent?: string;
}

export interface AuthenticatedIdentity {
  user: UserDocument;
  session: SessionDocument;
  wallets: WalletDocument[];
}

function nowPlusSeconds(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function buildChallengeMessage(args: {
  address: string;
  chainType: ChainType;
  chainId: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}) {
  return [
    CONFIG.AUTH.APP_NAME,
    "",
    `Sign in to ${CONFIG.AUTH.APP_NAME}.`,
    "",
    `Wallet: ${args.address}`,
    `Chain Type: ${args.chainType}`,
    `Chain ID: ${args.chainId}`,
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt.toISOString()}`,
    `Expires At: ${args.expiresAt.toISOString()}`,
    `Domain: ${CONFIG.AUTH.EXPECTED_DOMAIN}`,
    `URI: ${CONFIG.AUTH.EXPECTED_URI}`,
  ].join("\n");
}

export async function createAuthChallenge(args: {
  chainType: ChainType;
  chainId: string;
  address: string;
  fingerprint: RequestFingerprint;
}) {
  assertValidWalletAddress(args.chainType, args.address);
  const addressNormalized = normalizeWalletAddress(args.chainType, args.address);
  const issuedAt = new Date();
  const expiresAt = nowPlusSeconds(CONFIG.AUTH.CHALLENGE_TTL_SECONDS);
  const nonce = randomToken();
  const nonceHash = sha256(nonce);
  const message = buildChallengeMessage({
    address: args.address,
    chainType: args.chainType,
    chainId: args.chainId,
    nonce,
    issuedAt,
    expiresAt,
  });

  const challenge = {
    id: randomUUID(),
    nonceHash,
    chainType: args.chainType,
    chainId: args.chainId,
    addressNormalized,
    message,
    issuedAt,
    expiresAt,
    ipHash: hashRequestValue(args.fingerprint.ip),
    userAgentHash: hashRequestValue(args.fingerprint.userAgent),
    createdAt: issuedAt,
  };

  await db.insertChallenge(challenge);

  return {
    challengeId: challenge.id,
    message,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function verifyAuthChallenge(args: {
  challengeId: string;
  chainType: ChainType;
  chainId: string;
  address: string;
  signature: string;
  fingerprint: RequestFingerprint;
}) {
  assertValidWalletAddress(args.chainType, args.address);
  const addressNormalized = normalizeWalletAddress(args.chainType, args.address);
  const now = new Date();
  const challenge = await db.findChallengeById(args.challengeId);

  if (!challenge) {
    throw new Error("Challenge not found.");
  }
  if (challenge.consumedAt) {
    throw new Error("Challenge already used.");
  }
  if (challenge.expiresAt <= now) {
    throw new Error("Challenge expired.");
  }
  if (
    challenge.chainType !== args.chainType ||
    challenge.chainId !== args.chainId ||
    challenge.addressNormalized !== addressNormalized
  ) {
    throw new Error("Challenge wallet mismatch.");
  }

  const verified = await verifyWalletSignature({
    chainType: args.chainType,
    address: args.address,
    message: challenge.message,
    signature: args.signature,
  });

  if (!verified) {
    await writeAuditLog({
      eventType: "auth.verify",
      success: false,
      reason: "invalid_signature",
      fingerprint: args.fingerprint,
    });
    throw new Error("Invalid signature.");
  }

  const rawSessionToken = randomToken();

  const result = await db.transaction(async (tx) => {
    const existingWallet = await tx.findWallet(args.chainType, args.chainId, addressNormalized);

    let user: UserDocument;
    let wallet: WalletDocument;

    if (existingWallet) {
      const existingUser = await tx.findUserById(existingWallet.userId);
      if (!existingUser || existingUser.status !== "active") {
        throw new Error("User unavailable.");
      }
      wallet = {
        ...existingWallet,
        lastVerifiedAt: now,
      };
      user = existingUser;
      await tx.updateWalletVerifiedAt(wallet.id, now);
    } else {
      user = {
        id: randomUUID(),
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      wallet = {
        id: randomUUID(),
        userId: user.id,
        chainType: args.chainType,
        chainId: args.chainId,
        address: args.address,
        addressNormalized,
        firstVerifiedAt: now,
        lastVerifiedAt: now,
        createdAt: now,
      };
      await tx.insertUser(user);
      await tx.insertWallet(wallet);
    }

    const consumed = await tx.consumeChallenge(challenge.id, wallet.id, now);

    if (!consumed) {
      throw new Error("Challenge already used.");
    }

    const session: SessionDocument = {
      id: randomUUID(),
      userId: user.id,
      sessionTokenHash: hmacToken(rawSessionToken),
      createdAt: now,
      expiresAt: nowPlusSeconds(CONFIG.AUTH.SESSION_TTL_SECONDS),
      lastSeenAt: now,
      ipHash: hashRequestValue(args.fingerprint.ip),
      userAgentHash: hashRequestValue(args.fingerprint.userAgent),
    };

    await tx.insertSession(session);
    await writeAuditLog(
      {
        userId: user.id,
        walletId: wallet.id,
        eventType: "auth.login",
        success: true,
        fingerprint: args.fingerprint,
      },
      tx,
    );

    return { user, wallet };
  });

  return {
    rawSessionToken,
    user: publicUser(result.user),
    wallets: [publicWallet(result.wallet)],
  };
}

export async function authenticateSessionToken(rawSessionToken: string | undefined) {
  if (!rawSessionToken) return null;
  const sessionTokenHash = hmacToken(rawSessionToken);
  const session = await db.findActiveSession(sessionTokenHash);
  if (!session) return null;

  const user = await db.findUserById(session.userId);
  if (user?.status !== "active") return null;
  if (!user) return null;

  const wallets = await db.findWalletsByUserId(user.id);
  await db.updateSessionLastSeen(session.id, new Date());

  return { user, session, wallets };
}

export async function revokeSession(rawSessionToken: string | undefined) {
  if (!rawSessionToken) return;
  await db.revokeSession(hmacToken(rawSessionToken));
}

export function publicUser(user: UserDocument) {
  return {
    id: user.id,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

export function publicWallet(wallet: WalletDocument) {
  return {
    id: wallet.id,
    chainType: wallet.chainType,
    chainId: wallet.chainId,
    address: wallet.address,
    verifiedAt: wallet.lastVerifiedAt.toISOString(),
  };
}

export function publicIdentity(identity: AuthenticatedIdentity) {
  return {
    user: publicUser(identity.user),
    wallets: identity.wallets.map(publicWallet),
    session: {
      expiresAt: identity.session.expiresAt.toISOString(),
    },
  };
}

async function writeAuditLog(args: {
  userId?: string;
  walletId?: string;
  eventType: string;
  success: boolean;
  reason?: string;
  fingerprint: RequestFingerprint;
}, repository: Pick<AuthRepository, "insertAuditLog"> = db) {
  await repository.insertAuditLog({
    id: randomUUID(),
    userId: args.userId,
    walletId: args.walletId,
    eventType: args.eventType,
    success: args.success,
    reason: args.reason,
    ipHash: hashRequestValue(args.fingerprint.ip),
    userAgentHash: hashRequestValue(args.fingerprint.userAgent),
    createdAt: new Date(),
  });
}
