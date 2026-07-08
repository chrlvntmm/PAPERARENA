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
  const authPromiseRef = useRef<{ resolve: () => void; reject: (err: Error) => void } | null>(null);

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
        setAuthenticated(true);
        setSessionId(msg.sessionId);
        setError(null);
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
        setError(msg.reason);
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
        break;
      case "pong":
        break;
    }
  }, [send]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

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
      setConnected(false);
      setAuthenticated(false);
      wsRef.current = null;
    };

    ws.onerror = () => {
      setError("WebSocket connection failed");
    };
  }, [handleMessage]);

  const waitForAuth = useCallback(() => {
    if (authenticated) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      authPromiseRef.current = { resolve, reject };
    });
  }, [authenticated]);

  const joinQueue = useCallback(
    (arena: "standard" | "mega", wager: number, username: string, color: string) => {
      setElimination(null);
      setMatchEnd(null);
      setMatchId(null);
      setPlayerId(null);
      setSnapshot(null);
      if (authenticated) {
        send({ type: "join_queue", arena, wager, username, color });
      } else {
        pendingJoinRef.current = { arena, wager, username, color };
      }
    },
    [authenticated, send],
  );

  const leaveQueue = useCallback(() => {
    pendingJoinRef.current = null;
    send({ type: "leave_queue" });
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
    setConnected(false);
    setAuthenticated(false);
    setSessionId(null);
  }, [leaveQueue]);

  useEffect(() => {
    return () => {
      pendingJoinRef.current = null;
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
