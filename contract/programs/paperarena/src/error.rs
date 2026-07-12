use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("New deposits are paused")]
    DepositsPaused,
    #[msg("Match locking is paused")]
    LocksPaused,
    #[msg("Settlements are paused")]
    SettlementsPaused,
    #[msg("Fee basis points exceed the allowed maximum")]
    InvalidFeeBps,
    #[msg("Wager tier must be 5, 10 or 20 USD")]
    InvalidWagerTier,
    #[msg("Deposit amount does not match the wager tier")]
    InvalidAmount,
    #[msg("Token mint does not match the configured wager token")]
    WrongTokenMint,
    #[msg("Deposit intent has expired")]
    DepositExpired,
    #[msg("Deposit intent has not expired yet")]
    DepositNotExpired,
    #[msg("Deposit is not in a refundable state")]
    DepositNotRefundable,
    #[msg("Deposit is not funded or was already used")]
    DepositNotFunded,
    #[msg("Expiry timestamp is invalid")]
    InvalidExpiry,
    #[msg("Deposit TTL must be positive")]
    InvalidDepositTtl,
    #[msg("Player count is outside the allowed range")]
    InvalidPlayerCount,
    #[msg("Deposits with different wager tiers cannot be locked together")]
    MixedWagerTiers,
    #[msg("Deposits from different arenas cannot be locked together")]
    MixedArenas,
    #[msg("The same player appears more than once in the match")]
    DuplicatePlayer,
    #[msg("Match is not in the locked state")]
    MatchNotLocked,
    #[msg("Total payouts exceed the locked pot")]
    PayoutExceedsPot,
    #[msg("Payout entry is invalid")]
    InvalidPayout,
    #[msg("Payout recipient is not a player in this match")]
    RecipientNotInMatch,
    #[msg("The same recipient appears more than once in the payout list")]
    DuplicateRecipient,
    #[msg("Recipient token account does not match the expected player")]
    WrongRecipientAccount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Account is not a valid deposit escrow for this program")]
    InvalidDepositAccount,
    #[msg("Vault account does not match the configured vault")]
    WrongVault,
    #[msg("Treasury account does not match the configured treasury")]
    WrongTreasury,
    #[msg("Payout list is empty")]
    EmptyPayouts,
    #[msg("Deposit does not belong to this match")]
    DepositMatchMismatch,
    #[msg("Remaining accounts do not line up with the payout list")]
    AccountListMismatch,
}
