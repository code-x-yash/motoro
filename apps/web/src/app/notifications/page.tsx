'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { NotificationDto, Paginated } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, EmptyState, LoadingState, cn } from '@rr/ui';
import { Bell } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { api, apiGet, apiPost, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/realtime';
import { timeAgo } from '@/lib/format';

function urlBase64ToUint8Array(base64String: string): BufferSource {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export default function NotificationsPage() {
  return (
    <AppShell>
      <NotificationsContent />
    </AppShell>
  );
}

function NotificationsContent() {
  const { user } = useAuth();
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushSupported] = useState(
    () =>
      typeof window !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window,
  );
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const load = () =>
    void apiGet<Paginated<NotificationDto>>('/api/notifications', { query: { limit: 50 } })
      .then((data) => setItems(data.items))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    // Realtime pushes new notifications instantly; slow poll self-heals.
    const timer = setInterval(() => void load(), 600_000);
    return () => clearInterval(timer);
  }, []);

  useRealtime(
    user ? `user:${user.id}` : null,
    (message) => {
      if (message.type === 'notification') void load();
    },
    { enabled: Boolean(user) },
  );

  useEffect(() => {
    if (!pushSupported) return;
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setPushEnabled(Boolean(sub)))
      .catch(() => undefined);
  }, [pushSupported]);

  const togglePush = async () => {
    setPushBusy(true);
    setError(null);
    try {
      if (pushEnabled) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api('/api/notifications/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } });
          await sub.unsubscribe();
        }
        setPushEnabled(false);
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setError('Browser permission for notifications was not granted.');
        return;
      }
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await apiGet<{ publicKey: string }>('/api/notifications/vapid-public-key');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }
      const json = sub.toJSON();
      await apiPost('/api/notifications/push-subscriptions', {
        endpoint: sub.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
      });
      setPushEnabled(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPushBusy(false);
    }
  };

  const markRead = async (id: string) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)));
    try {
      await apiPost(`/api/notifications/${id}/read`);
    } catch {
      void load();
    }
  };

  const markAll = async () => {
    setBusy(true);
    try {
      await apiPost('/api/notifications/read-all');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-subtitle">Dispatch updates, quotes, payments and system notices.</p>
        </div>
        <Button variant="secondary" size="sm" loading={busy} onClick={markAll}>
          Mark all read
        </Button>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {pushSupported ? (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-900">Browser notifications</p>
              <p className="text-sm text-slate-600">
                Get push alerts for dispatch offers, arrivals, quotes and payments — even when this tab is closed.
              </p>
            </div>
            <Button variant={pushEnabled ? 'secondary' : 'primary'} size="sm" loading={pushBusy} onClick={() => void togglePush()}>
              {pushEnabled ? 'Turn off' : 'Enable'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {loading ? <LoadingState /> : null}

      {!loading && items.length === 0 ? (
        <Card>
          <EmptyState
            title="No notifications"
            description="You will see dispatch, quote and payment updates here."
            icon={<Bell className="h-10 w-10" />}
          />
        </Card>
      ) : null}

      <div className="space-y-2">
        {items.map((item) => {
          const requestId = typeof item.data?.requestId === 'string' ? item.data.requestId : null;
          const text = (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                {!item.readAt ? <Badge tone="blue">New</Badge> : null}
              </div>
              <p className="mt-0.5 text-sm text-slate-600">{item.body}</p>
              <p className="mt-1 text-xs text-slate-400">
                {timeAgo(item.createdAt)} · {item.type}
                {requestId ? ' · View request →' : ''}
              </p>
            </>
          );
          return (
            <Card key={item.id} className={cn(!item.readAt && 'border-brand-200 bg-brand-50/40')}>
              <CardContent className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  {requestId ? (
                    <Link href={`/requests/detail?id=${requestId}`} className="block hover:opacity-80">
                      {text}
                    </Link>
                  ) : (
                    text
                  )}
                </div>
                {!item.readAt ? (
                  <Button size="sm" variant="ghost" onClick={() => void markRead(item.id)}>
                    Mark read
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
