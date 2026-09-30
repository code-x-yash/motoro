'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeServerMessage } from '@rr/types';
import { apiGet } from './api';

interface TicketResponse {
  ticket: string;
  connectUrl: string;
  expiresIn: number;
}

export interface RealtimeState {
  connected: boolean;
  send: (message: { type: string; payload?: Record<string, unknown> }) => void;
  close: () => void;
}

/**
 * Subscribes to a realtime room (request:{id} | user:{id} | mechanic:{id} | ops).
 * Uses a short-lived ticket so the session cookie never travels on the socket URL.
 */
export function useRealtime(
  room: string | null,
  onMessage: (message: RealtimeServerMessage) => void,
  options: { enabled?: boolean } = {},
): RealtimeState {
  const enabled = options.enabled ?? true;
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const send = useCallback((message: { type: string; payload?: Record<string, unknown> }) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  const close = useCallback(() => {
    closedRef.current = true;
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    if (!room || !enabled) {
      setConnected(false);
      return undefined;
    }
    closedRef.current = false;
    let disposed = false;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (disposed || closedRef.current) return;
      try {
        const ticket = await apiGet<TicketResponse>('/api/realtime/ticket', { query: { room } });
        if (disposed || closedRef.current) return;
        // Prefer the server-proxied connectUrl: behind the Vercel /api/* proxy
        // the socket must go straight to the Worker origin (Vercel rewrites do
        // not forward WebSocket upgrades).
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url =
          ticket.connectUrl ||
          `${proto}://${window.location.host}/api/realtime/connect?ticket=${encodeURIComponent(ticket.ticket)}`;
        const socket = new WebSocket(url);
        socketRef.current = socket;

        socket.addEventListener('open', () => {
          if (disposed) return;
          retryRef.current = 0;
          setConnected(true);
          socket.send(JSON.stringify({ type: 'subscribe' }));
          pingTimer = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }));
          }, 25_000);
        });

        socket.addEventListener('message', (event) => {
          try {
            const parsed = JSON.parse(String(event.data)) as RealtimeServerMessage;
            handlerRef.current(parsed);
          } catch {
            /* ignore malformed frames */
          }
        });

        socket.addEventListener('close', () => {
          if (pingTimer) clearInterval(pingTimer);
          setConnected(false);
          if (disposed || closedRef.current) return;
          retryRef.current = Math.min(retryRef.current + 1, 6);
          retryTimer = setTimeout(() => void connect(), 1000 * retryRef.current);
        });

        socket.addEventListener('error', () => {
          socket.close();
        });
      } catch {
        if (disposed || closedRef.current) return;
        retryRef.current = Math.min(retryRef.current + 1, 6);
        retryTimer = setTimeout(() => void connect(), 1500 * retryRef.current);
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (retryTimer) clearTimeout(retryTimer);
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [room, enabled]);

  return { connected, send, close };
}
