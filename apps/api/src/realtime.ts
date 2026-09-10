import { Injectable, MessageEvent, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AuthScope } from '@eveops/contracts';
import { Client } from 'pg';
import { filter, interval, map, merge, Observable, Subject } from 'rxjs';

export interface DomainEvent {
  id?: string;
  eventId: string;
  hallId?: string;
  stallId?: string;
  assigneeId?: string;
  assigneeIds?: string[];
  type: string;
  data: object;
}

export function canReceiveEvent(scope: AuthScope, event: DomainEvent) {
  if (!scope.eventIds.includes(event.eventId)) return false;
  if (scope.role === 'STALL') return event.stallId === scope.stallId;
  if (scope.role === 'STAFF') return event.assigneeId === scope.userId || event.assigneeIds?.includes(scope.userId) === true;
  if (scope.role === 'HALL_MANAGER') return !!event.hallId && scope.hallIds.includes(event.hallId);
  return scope.role === 'ADMIN' || scope.role === 'SUPER_ADMIN';
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly events = new Subject<DomainEvent>();
  private listener?: Client;
  private stopped = false;

  async onModuleInit() {
    if (!process.env.DATABASE_URL) return;
    await this.connectListener();
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.listener?.end().catch(() => undefined);
    this.events.complete();
  }

  publish(event: DomainEvent) { this.events.next(event); }
  stream(scope: AuthScope): Observable<MessageEvent> {
    const scoped = this.events.pipe(
      filter((event) => canReceiveEvent(scope, event)),
      map((event) => ({ id: event.id, type: event.type, data: event.data })),
    );
    const heartbeat = interval(20000).pipe(map(() => ({ type: 'heartbeat', data: { time: new Date().toISOString() } })));
    return merge(scoped, heartbeat);
  }

  private async connectListener() {
    if (this.stopped) return;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('notification', (message) => {
      if (!message.payload) return;
      try {
        const event = JSON.parse(message.payload) as DomainEvent;
        if (event.eventId) this.publish(event);
      } catch {
        // Invalid database notifications are ignored; authoritative REST state remains available.
      }
    });
    client.on('error', () => {
      if (!this.stopped) setTimeout(() => void this.connectListener().catch(() => undefined), 2000);
    });
    await client.connect();
    await client.query('LISTEN expoops_events');
    this.listener = client;
  }
}
