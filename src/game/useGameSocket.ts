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
}

export function useGameSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef(0);
  const pendingJoinRef = useRef<PendingJoin | null>(null);
  const authenticatedRef = useRef(false);
  const lastAuthErrorRef = useRef<string | null>(null);
  const authPromiseRef = useRef<{
    resolve: () => void;
    reject: (err: Error) => void;
    timeoutId: ReturnType<typeof window.setTimeout>;
  } | null>(null);

  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [queueNeeded, setQueueNeeded] = useState<number | null>(null);
  const [matchId, setMatchId] = useState<string | null>(null);
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [elimination, setElimination] = useState<EliminationPayload | null>(null);
  const [matchEnd, setMatchEnd] = useState<MatchEndPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case "auth_ok":
        authenticatedRef.current = true;
        lastAuthErrorRef.current = null;
        setAuthenticated(true);
        setSessionId(msg.sessionId);
        setError(null);
        if (authPromiseRef.current) {
          window.clearTimeout(authPromiseRef.current.timeoutId);
        }
        authPromiseRef.current?.resolve();
        authPromiseRef.current = null;
        if (pendingJoinRef.current) {
          const j = pendingJoinRef.current;
          pendingJoinRef.current = null;
          send({
            type: "join_queue",
            arena: j.arena,
            wager: j.wager,
            username: j.username,
            color: j.color,
          });
        }
        break;
      case "auth_fail":
        authenticatedRef.current = false;
        lastAuthErrorRef.current = msg.reason;
        setAuthenticated(false);
        setError(msg.reason);
        if (authPromiseRef.current) {
          window.clearTimeout(authPromiseRef.current.timeoutId);
        }
        authPromiseRef.current?.reject(new Error(msg.reason));
        authPromiseRef.current = null;
        break;
      case "queue_update":
        setQueuePosition(msg.position);
        setQueueNeeded(msg.needed);
        setError(null);
        break;
      case "match_start":
        setMatchId(msg.matchId);
        setPlayerId(msg.playerId);
        setSnapshot(msg.snapshot);
        setQueuePosition(null);
        setQueueNeeded(null);
        setElimination(null);
        setMatchEnd(null);
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
        if (msg.code === "QUEUE_REPLACED") {
          pendingJoinRef.current = null;
          setQueuePosition(null);
          setQueueNeeded(null);
          setMatchId(null);
          setPlayerId(null);
          setSnapshot(null);
        }
        break;
      case "pong":
        break;
    }
  }, [send]);

  const connect = useCallback(() => {
    setError(null);
    lastAuthErrorRef.current = null;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
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
    };

    ws.onerror = () => {
      lastAuthErrorRef.current = "WebSocket connection failed";
      setError("WebSocket connection failed");
    };
  }, [handleMessage]);

  const waitForAuth = useCallback(() => {
    if (authenticatedRef.current) return Promise.resolve();
    if (lastAuthErrorRef.current) return Promise.reject(new Error(lastAuthErrorRef.current));
    return new Promise<void>((resolve, reject) => {
      if (authPromiseRef.current) {
        window.clearTimeout(authPromiseRef.current.timeoutId);
      }
      const waiter = {
        resolve,
        reject,
        timeoutId: 0 as ReturnType<typeof window.setTimeout>,
      };
      waiter.timeoutId = window.setTimeout(() => {
        if (authPromiseRef.current !== waiter) return;
        authPromiseRef.current = null;
        reject(new Error("Arena connection took too long to authenticate. Please try again."));
      }, 8000);
      authPromiseRef.current = waiter;
    });
  }, []);

  const joinQueue = useCallback(
    (arena: "standard" | "mega", wager: number, username: string, color: string) => {
      setError(null);
      setQueuePosition(null);
      setQueueNeeded(null);
      setElimination(null);
      setMatchEnd(null);
      setMatchId(null);
      setPlayerId(null);
      setSnapshot(null);
      if (authenticatedRef.current) {
        send({ type: "join_queue", arena, wager, username, color });
      } else {
        pendingJoinRef.current = { arena, wager, username, color };
      }
    },
    [send],
  );

  const leaveQueue = useCallback(() => {
    pendingJoinRef.current = null;
    send({ type: "leave_queue" });
    setError(null);
    setQueuePosition(null);
    setQueueNeeded(null);
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
