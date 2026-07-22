import { Match } from "./Match.js";

export class MatchManager {
  private matches = new Map<string, Match>();
  /** walletId / identity → active match id for reconnect. */
  private identityToMatch = new Map<string, string>();

  create(match: Match): Match {
    this.matches.set(match.id, match);
    for (const identity of match.getIdentityKeys()) {
      this.identityToMatch.set(identity, match.id);
    }
    match.start();
    return match;
  }

  get(id: string): Match | undefined {
    return this.matches.get(id);
  }

  findByIdentity(identityKey: string | undefined | null): Match | undefined {
    if (!identityKey) return undefined;
    const matchId = this.identityToMatch.get(identityKey);
    if (!matchId) return undefined;
    return this.matches.get(matchId);
  }

  list(): Match[] {
    return [...this.matches.values()];
  }

  activeCount(): number {
    return this.matches.size;
  }

  /** End every live match (territory standings) so settlement can run before exit. */
  forceEndAll() {
    for (const match of [...this.matches.values()]) {
      try {
        match.forceEndForShutdown();
      } catch (error) {
        console.error("[matches] forceEnd failed", {
          matchId: match.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  remove(id: string) {
    const match = this.matches.get(id);
    if (!match) return;
    this.matches.delete(id);
    for (const identity of match.getIdentityKeys()) {
      if (this.identityToMatch.get(identity) === id) {
        this.identityToMatch.delete(identity);
      }
    }
    // destroy() may call onEnd → remove again (no-op once deleted).
    match.destroy();
  }

  destroyAll() {
    const ids = [...this.matches.keys()];
    for (const id of ids) {
      this.remove(id);
    }
  }
}
