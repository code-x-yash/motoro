'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LoadingState } from '@rr/ui';
import { AppShell } from '@/components/app-shell';
import { RequestSession } from '@/components/request-session';

export default function RequestSessionPage() {
  return (
    <AppShell roles={['DRIVER', 'MECHANIC', 'WORKSHOP', 'OPERATIONS', 'ADMIN']}>
      <div className="mx-auto max-w-6xl space-y-4">
        <div>
          <h1 className="page-title">Assistance session</h1>
          <p className="page-subtitle">Live tracking, quotes, payment and the full event timeline.</p>
        </div>
        <Suspense fallback={<LoadingState label="Opening session…" />}>
          <SessionBody />
        </Suspense>
      </div>
    </AppShell>
  );
}

function SessionBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';

  useEffect(() => {
    if (!id) router.replace('/history');
  }, [id, router]);

  if (!id) return <LoadingState label="Redirecting to your requests…" />;
  return <RequestSession requestId={id} />;
}
