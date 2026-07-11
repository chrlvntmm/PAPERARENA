import { Match } from "./Match.js";

export class MatchManager {
  private matches = new Map<string, Match>();

  create(match: Match): Match {
    this.matches.set(match.id, match);
    match.start();
    return match;
  }

  get(id: string): Match | undefined {
    return this.matches.get(id);
  }

  remove(id: string) {
    const match = this.matches.get(id);
    match?.destroy();
    this.matches.delete(id);
  }

  destroyAll() {
    for (const match of this.matches.values()) {
      match.destroy();
    }
    this.matches.clear();
  }
}
