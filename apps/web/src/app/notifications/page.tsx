'use client';

import { useEffect, useState } from 'react';
import type { NotificationDto, Paginated } from '@rr/types';
import { Alert, Badge, Button, Card, CardContent, EmptyState, LoadingState, cn } from '@rr/ui';
import { Bell } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { apiGet, apiPost, errorMessage } from '@/lib/api';
import { timeAgo } from '@/lib/format';

export default function NotificationsPage() {
  return (
    <AppShell>
      <NotificationsContent />
    </AppShell>
  );
}

function NotificationsContent() {
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    void apiGet<Paginated<NotificationDto>>('/api/notifications', { query: { limit: 50 } })
      .then((data) => setItems(data.items))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, []);

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
        {items.map((item) => (
          <Card key={item.id} className={cn(!item.readAt && 'border-brand-200 bg-brand-50/40')}>
            <CardContent className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">{item.title}</p>
                  {!item.readAt ? <Badge tone="blue">New</Badge> : null}
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{item.body}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {timeAgo(item.createdAt)} · {item.type}
                </p>
              </div>
              {!item.readAt ? (
                <Button size="sm" variant="ghost" onClick={() => void markRead(item.id)}>
                  Mark read
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
