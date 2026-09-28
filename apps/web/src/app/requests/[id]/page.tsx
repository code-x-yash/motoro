'use client';

import { useParams } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { RequestSession } from '@/components/request-session';

export default function RequestSessionPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';

  return (
    <AppShell roles={['DRIVER', 'OPERATIONS', 'ADMIN']}>
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="page-title">Assistance session</h1>
          <p className="page-subtitle">Live tracking, quotes, payment and the full event timeline.</p>
        </div>
        {id ? <RequestSession requestId={id} /> : null}
      </div>
    </AppShell>
  );
}
