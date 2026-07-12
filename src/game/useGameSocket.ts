import { useCallback, useEffect, useRef, useState } from "react";
import type { Dir } from "./engine";
import {
  WS_URL,
  type EliminationPayload,
  type GameSnapshot,
  type MatchEndPayload,
  type ServerMessage,
} from "./protocol";

export interface PendingJoin {
  arena: "standard" | "mega";
  wager: number;
  username: string;
  color: string;
  depositIntentId?: string;
}

type JoinWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof window.setTimeout>;
};

export function useGameSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const pendingJoinRef = useRef<PendingJoin | null>(null);
  const authenticatedRef = useRef(false);
  const lastAuthErrorRef = useRef<string | null>(null);
  const authPromiseRef = useRef<JoinWaiter | null>(null);
  const joinAckRef = useRef<JoinWaiter | null>(null);

  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [queueNeeded, setQueueNeeded] = useState<number | null>(null);
  const [matchPreparing, setMatchPreparing] = useState(false);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [elimination, setElimination] = useState<EliminationPayload | null>(null);
  const [matchEnd, setMatchEnd] = useState<MatchEndPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearJoinAck = useCallback((err?: Error) => {
    if (!joinAckRef.current) return;
    window.clearTimeout(joinAckRef.current.timeoutId);
    if (err) joinAckRef.current.reject(err);
    else joinAckRef.current.resolve();
    joinAckRef.current = null;
  }, []);

  const send = useCallback((msg: object): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      return false;
    }
    wsRef.current.send(JSON.stringify(msg));
    return true;
  }, []);

  const handleMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "auth_ok":
          authenticatedRef.current = true;
          lastAuthErrorRef.current = null;
          setAuthenticated(true);
          setSessionId(msg.sessionId);
          setError(null);
          if (authPromiseRef.current) {
            window.clearTimeout(authPromiseRef.current.timeoutId);
            authPromiseRef.current.resolve();
            authPromiseRef.current = null;
          }
          if (pendingJoinRef.current) {
            const j = pendingJoinRef.current;
            pendingJoinRef.current = null;
            const ok = send({
              type: "join_queue",
              arena: j.arena,
              wager: j.wager,
              username: j.username,
              color: j.color,
              depositIntentId: j.depositIntentId,
            });
            if (!ok) {
              clearJoinAck(new Error("Arena connection is not ready. Please try again."));
            }
          }
          break;
        case "auth_fail":
          authenticatedRef.current = false;
          lastAuthErrorRef.current = msg.reason;
          setAuthenticated(false);
          setError(msg.reason);
          if (authPromiseRef.current) {
            window.clearTimeout(authPromiseRef.current.timeoutId);
            authPromiseRef.current.reject(new Error(msg.reason));
            authPromiseRef.current = null;
          }
          clearJoinAck(new Error(msg.reason));
          break;
        case "queue_update":
          setQueuePosition(msg.position);
          setQueueNeeded(msg.needed);
          setMatchPreparing(false);
          setError(null);
          // Server accepted join_queue.
          clearJoinAck();
          break;
        case "match_preparing":
          setMatchPreparing(true);
          setError(null);
          clearJoinAck();
          break;
        case "match_start":
          setMatchId(msg.matchId);
          setPlayerId(msg.playerId);
          setSnapshot(msg.snapshot);
          setQueuePosition(null);
          setQueueNeeded(null);
          setMatchPreparing(false);
          setElimination(null);
          setMatchEnd(null);
          clearJoinAck();
          break;
        case "state":
          setSnapshot((prev) => (prev && msg.tick <= prev.tick ? prev : msg.snapshot));
          break;
        case "eliminated":
          setElimination(msg.payload);
          break;
        case "match_end":
          setMatchEnd(msg.payload);
          break;
        case "error":
          setError(msg.message);
          setMatchPreparing(false);
          if (
            msg.code === "QUEUE_REPLACED" ||
            msg.code === "NO_ESCROW" ||
            msg.code === "LOCK_FAILED" ||
            msg.code === "LOCK_PENDING" ||
            msg.code === "UNAUTH" ||
            msg.code === "BAD_WAGER"
          ) {
            pendingJoinRef.current = null;
            setQueuePosition(null);
            setQueueNeeded(null);
            setMatchId(null);
            setPlayerId(null);
            setSnapshot(null);
          }
          clearJoinAck(new Error(msg.message));
          break;
        case "pong":
          break;
      }
    },
    [clearJoinAck, send],
  );

  const connect = useCallback(() => {
    setError(null);
    lastAuthErrorRef.current = null;

    const existing = wsRef.current;
    if (existing?.readyState === WebSocket.OPEN && authenticatedRef.current) {
      return;
    }
    // Stale socket (open but unauth, or half-open): force a clean reconnect.
    if (existing && existing.readyState !== WebSocket.CLOSED) {
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }

    authenticatedRef.current = false;
    setAuthenticated(false);
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        handleMessage(msg);
      } catch {
        setError("Invalid server message");
      }
    };

    ws.onclose = () => {
      authenticatedRef.current = false;
      setConnected(false);
      setAuthenticated(false);
      wsRef.current = null;
      if (authPromiseRef.current) {
        window.clearTimeout(authPromiseRef.current.timeoutId);
        authPromiseRef.current.reject(new Error("Arena connection closed before authentication."));
        authPromiseRef.current = null;
      }
      clearJoinAck(new Error("Arena connection closed."));
    };

    ws.onerror = () => {
      lastAuthErrorRef.current = "WebSocket connection failed";
      setError("WebSocket connection failed");
    };
  }, [clearJoinAck, handleMessage]);

  const waitForAuth = useCallback(() => {
    if (authenticatedRef.current) return Promise.resolve();
    if (lastAuthErrorRef.current) return Promise.reject(new Error(lastAuthErrorRef.current));
    return new Promise<void>((resolve, reject) => {
      if (authPromiseRef.current) {
        window.clearTimeout(authPromiseRef.current.timeoutId);
      }
      const waiter: JoinWaiter = {
        resolve,
        reject,
        timeoutId: 0 as ReturnType<typeof window.setTimeout>,
      };
      waiter.timeoutId = window.setTimeout(() => {
        if (authPromiseRef.current !== waiter) return;
        authPromiseRef.current = null;
        reject(new Error("Arena connection took too long to authenticate. Please try again."));
      }, 12_000);
      authPromiseRef.current = waiter;
    });
  }, []);

  const joinQueue = useCallback(
    (arena: "standard" | "mega", wager: number, username: string, color: string, depositIntentId?: string) => {
      setError(null);
      setQueuePosition(null);
      setQueueNeeded(null);
      setMatchPreparing(false);
      setElimination(null);
      setMatchEnd(null);
      setMatchId(null);
      setPlayerId(null);
      setSnapshot(null);

      return new Promise<void>((resolve, reject) => {
        if (joinAckRef.current) {
          window.clearTimeout(joinAckRef.current.timeoutId);
          joinAckRef.current.reject(new Error("Replaced by a new join request."));
        }
        const waiter: JoinWaiter = {
          resolve,
          reject,
          timeoutId: 0 as ReturnType<typeof window.setTimeout>,
        };
        waiter.timeoutId = window.setTimeout(() => {
          if (joinAckRef.current !== waiter) return;
          joinAckRef.current = null;
          reject(new Error("Join timed out waiting for arena server. Please try again."));
        }, 20_000);
        joinAckRef.current = waiter;

        if (authenticatedRef.current) {
          const ok = send({ type: "join_queue", arena, wager, username, color, depositIntentId });
          if (!ok) {
            clearJoinAck(new Error("Arena connection is not ready. Please try again."));
          }
        } else {
          pendingJoinRef.current = { arena, wager, username, color, depositIntentId };
        }
      });
    },
    [clearJoinAck, send],
  );

  const leaveQueue = useCallback(() => {
    pendingJoinRef.current = null;
    // Resolve (not reject) so intentional cancel does not surface as a join error.
    if (joinAckRef.current) {
      window.clearTimeout(joinAckRef.current.timeoutId);
      joinAckRef.current.resolve();
      joinAckRef.current = null;
    }
    send({ type: "leave_queue" });
    setError(null);
    setQueuePosition(null);
    setQueueNeeded(null);
    setMatchPreparing(false);
  }, [send]);

  const sendInput = useCallback(
    (dir: Dir) => {
      send({ type: "input", dir, seq: ++seqRef.current });
    },
    [send],
  );

  const reset = useCallback(() => {
    leaveQueue();
    setMatchId(null);
    setPlayerId(null);
    setSnapshot(null);
    setElimination(null);
    setMatchEnd(null);
    setMatchPreparing(false);
    setError(null);
  }, [leaveQueue]);

  const disconnect = useCallback(() => {
    leaveQueue();
    wsRef.current?.close();
    wsRef.current = null;
    authenticatedRef.current = false;
    lastAuthErrorRef.current = null;
    setConnected(false);
    setAuthenticated(false);
    setSessionId(null);
  }, [leaveQueue]);

  useEffect(() => {
    return () => {
      pendingJoinRef.current = null;
      authenticatedRef.current = false;
      lastAuthErrorRef.current = null;
      if (authPromiseRef.current) {
        window.clearTimeout(authPromiseRef.current.timeoutId);
      }
      authPromiseRef.current?.reject(new Error("Disconnected"));
      authPromiseRef.current = null;
      if (joinAckRef.current) {
        window.clearTimeout(joinAckRef.current.timeoutId);
      }
      joinAckRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return {
    connected,
    authenticated,
    sessionId,
    queuePosition,
    queueNeeded,
    matchPreparing,
    matchId,
    playerId,
    snapshot,
    elimination,
    matchEnd,
    error,
    connect,
    waitForAuth,
    joinQueue,
    leaveQueue,
    sendInput,
    reset,
    disconnect,
  };
}
