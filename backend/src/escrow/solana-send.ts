import {
  Connection,
  Transaction,
  type Keypair,
} from "@solana/web3.js";

/**
 * Fast, real confirm: send with confirmed blockhash, poll status aggressively.
 * Accepts processed/confirmed/finalized so we don't wait on slow finalized tips.
 * Still fails closed if the tx errors on-chain.
 */
export async function sendAndConfirmFast(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  options: {
    label?: string;
    maxAttempts?: number;
    pollMs?: number;
    pollTimeoutMs?: number;
    onSubmitted?: (signature: string) => Promise<void> | void;
  } = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 2;
  const pollMs = options.pollMs ?? 350;
  const pollTimeoutMs = options.pollTimeoutMs ?? 14_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const fresh = cloneTx(tx);
      fresh.feePayer = signers[0]!.publicKey;
      fresh.recentBlockhash = blockhash;
      fresh.sign(...signers);

      const signature = await connection.sendRawTransaction(fresh.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 2,
      });

      if (options.onSubmitted) {
        await options.onSubmitted(signature);
      }

      const result = await pollSignature(connection, signature, {
        pollMs,
        timeoutMs: pollTimeoutMs,
        lastValidBlockHeight,
      });

      if (result === "ok") return signature;
      if (result === "err") {
        throw new Error(`${options.label ?? "tx"} failed on-chain (${signature})`);
      }

      // Timed out without confirmation — still check once more; may have landed.
      const late = await pollSignature(connection, signature, {
        pollMs: 500,
        timeoutMs: 3_000,
      });
      if (late === "ok") return signature;
      if (late === "err") {
        throw new Error(`${options.label ?? "tx"} failed on-chain (${signature})`);
      }

      lastError = new Error(
        `${options.label ?? "tx"} confirmation timed out (${signature}). Will retry if attempts remain.`,
      );
    } catch (error) {
      lastError = error;
      await sleep(250 * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${options.label ?? "tx"} failed after retries.`);
}

async function pollSignature(
  connection: Connection,
  signature: string,
  opts: { pollMs: number; timeoutMs: number; lastValidBlockHeight?: number },
): Promise<"ok" | "err" | "unknown"> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      if (opts.lastValidBlockHeight != null) {
        const height = await connection.getBlockHeight("confirmed");
        if (height > opts.lastValidBlockHeight + 32) {
          // Past validity window — still check if it landed.
          const statuses = await connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          });
          const st = statuses.value[0];
          if (st?.err) return "err";
          if (st?.confirmationStatus) return "ok";
          return "unknown";
        }
      }

      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      });
      const status = statuses.value[0];
      if (status?.err) return "err";
      // processed is enough to proceed; account reads use confirmed shortly after.
      if (
        status?.confirmationStatus === "processed" ||
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        return "ok";
      }
    } catch {
      /* keep polling */
    }
    await sleep(opts.pollMs);
  }
  return "unknown";
}

function cloneTx(tx: Transaction): Transaction {
  const fresh = new Transaction();
  for (const ix of tx.instructions) fresh.add(ix);
  return fresh;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
