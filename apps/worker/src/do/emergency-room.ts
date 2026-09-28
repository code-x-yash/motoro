import type { RealtimeServerMessage } from '@rr/types';
import type { Env } from '../env';
import { loadRequestDto } from '../lib/requests';
import { logger } from '../lib/logger';
import { sweepExpiredAttempts } from '../dispatch/service';

/**
 * Emergency session room — Durable Object with the WebSocket Hibernation API.
 *
 * Coordinates the live request between driver, mechanic and operations:
 *   - hydrates newly connected clients with the current authoritative state
 *   - broadcasts state / timeline / location updates
 *   - stores no business truth (D1 remains the system of record)
 *   - arms an alarm to time out dispatch offers precisely
 */

interface TicketRecord {
  room: string;
  userId: string;
  role: string;
  exp: number;
}

interface ClientMeta {
  userId: string;
  role: string;
}

export class EmergencyRoom {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private roomName(): string {
    return this.state.id.name ?? 'unnamed-room';
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/broadcast') {
      const message = (await request.json()) as RealtimeServerMessage;
      this.sendAll(message);
      return new Response('ok');
    }

    if (request.method === 'POST' && path === '/alarm') {
      const at = url.searchParams.get('at');
      const clear = url.searchParams.get('clear');
      if (clear === '1') {
        await this.state.storage.deleteAlarm();
      } else if (at) {
        await this.state.storage.setAlarm(Number(at));
      }
      return new Response('ok');
    }

    if (request.method === 'POST' && path === '/sync') {
      await this.pushStateToAll();
      return new Response('ok');
    }

    if (request.method === 'GET' && path === '/connect') {
      return this.handleConnect(request, url);
    }

    return new Response('not found', { status: 404 });
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    const ticket = url.searchParams.get('ticket');
    if (!ticket) return new Response('missing ticket', { status: 401 });

    const raw = await this.env.KV.get(`ws_ticket:${ticket}`, 'json');
    if (!raw) return new Response('invalid or expired ticket', { status: 401 });
    const record = raw as TicketRecord;
    if (record.exp < Date.now()) {
      await this.env.KV.delete(`ws_ticket:${ticket}`);
      return new Response('ticket expired', { status: 401 });
    }
    if (record.room !== this.roomName()) return new Response('room mismatch', { status: 403 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const meta: ClientMeta = { userId: record.userId, role: record.role };
    this.state.acceptWebSocket(server);
    server.serializeAttachment(meta);

    return new Response(null, { status: 101, webSocket: client });
  }

  private metaOf(ws: WebSocket): ClientMeta {
    try {
      const attachment = (ws as unknown as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
      if (attachment && typeof attachment === 'object') return attachment as ClientMeta;
    } catch {
      /* fall through */
    }
    return { userId: 'unknown', role: 'unknown' };
  }

  /** Hibernation API hooks. */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: { type?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      return;
    }
    const meta = this.metaOf(ws);

    switch (parsed.type) {
      case 'ping':
        ws.send(
          JSON.stringify({
            type: 'presence',
            payload: { pong: true, room: this.roomName() },
            at: new Date().toISOString(),
          } satisfies RealtimeServerMessage),
        );
        return;
      case 'location': {
        const payload = parsed.payload ?? {};
        const latitude = Number(payload.latitude);
        const longitude = Number(payload.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
        await this.persistLocation(meta, latitude, longitude);
        this.sendAll(
          {
            type: meta.role === 'MECHANIC' ? 'mechanic.location' : 'request.location',
            requestId: this.requestIdFromRoom(),
            payload: { ...payload, latitude, longitude, source: meta.role },
            at: new Date().toISOString(),
          },
          ws,
        );
        return;
      }
      case 'subscribe':
        await this.pushStateTo(ws);
        return;
      default:
        return;
    }
  }

  async webSocketClose(_ws: WebSocket): Promise<void> {
    this.broadcastPresence();
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    logger.warn('room', 'socket_error', { room: this.roomName() });
  }

  private requestIdFromRoom(): string | undefined {
    const name = this.roomName();
    return name.startsWith('request:') ? name.slice('request:'.length) : undefined;
  }

  private async persistLocation(meta: ClientMeta, latitude: number, longitude: number): Promise<void> {
    const requestId = this.requestIdFromRoom();
    if (!requestId) return;
    try {
      const source = meta.role === 'MECHANIC' ? 'MECHANIC' : meta.role === 'DRIVER' ? 'DRIVER' : 'OPS';
      await this.env.DB.prepare(
        `INSERT INTO emergency_locations (id, request_id, source, actor_user_id, latitude, longitude, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).bind(crypto.randomUUID(), requestId, source, meta.userId, latitude, longitude).run();
      if (meta.role === 'MECHANIC') {
        await this.env.DB.prepare(
          `UPDATE mechanics SET last_known_latitude = ?, last_known_longitude = ?,
             last_location_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE user_id = ?`,
        ).bind(latitude, longitude, meta.userId).run();
      }
    } catch (err) {
      logger.warn('room', 'persist_location_failed', { error: String(err) });
    }
  }

  private sendAll(message: RealtimeServerMessage, except?: WebSocket): void {
    const data = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      if (except && ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* socket will be reaped */
      }
    }
  }

  private async pushStateTo(ws: WebSocket): Promise<void> {
    const requestId = this.requestIdFromRoom();
    if (!requestId) return;
    try {
      const dto = await loadRequestDto(this.env, requestId, { withTimeline: true });
      ws.send(
        JSON.stringify({
          type: 'request.state',
          requestId,
          payload: { request: dto },
          at: new Date().toISOString(),
        } satisfies RealtimeServerMessage),
      );
    } catch (err) {
      logger.warn('room', 'push_state_failed', { error: String(err) });
    }
  }

  private async pushStateToAll(): Promise<void> {
    const requestId = this.requestIdFromRoom();
    if (!requestId) return;
    try {
      const dto = await loadRequestDto(this.env, requestId, { withTimeline: true });
      this.sendAll({
        type: 'request.state',
        requestId,
        payload: { request: dto },
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('room', 'push_state_failed', { error: String(err) });
    }
  }

  private broadcastPresence(): void {
    const sockets = this.state.getWebSockets();
    this.sendAll({
      type: 'presence',
      requestId: this.requestIdFromRoom(),
      payload: { connected: sockets.length },
      at: new Date().toISOString(),
    });
  }

  /** Alarm: dispatch offer timeout (precise, per-room). */
  async alarm(): Promise<void> {
    const requestId = this.requestIdFromRoom();
    logger.info('room', 'alarm_fired', { room: this.roomName(), requestId });
    try {
      await sweepExpiredAttempts(this.env);
    } catch (err) {
      logger.error('room', 'alarm_sweep_failed', { error: String(err) });
    }
    // Re-arm while pending offers remain.
    try {
      if (requestId) {
        const pending = await this.env.DB.prepare(
          `SELECT MIN(timeout_at) AS next FROM dispatch_attempts WHERE request_id = ? AND status = 'PENDING'`,
        )
          .bind(requestId)
          .first<{ next: string | null }>();
        if (pending?.next) {
          const at = new Date(pending.next).getTime();
          if (at > Date.now()) await this.state.storage.setAlarm(at);
        }
      }
    } catch {
      /* ignore */
    }
  }
}
