import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Offline',
  robots: { index: false, follow: false },
};

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 py-16 text-center text-ink">
      <img src="/icon.svg" alt="" width={80} height={80} className="h-20 w-20 rounded-3xl shadow-card" />
      <h1 className="mt-6 text-2xl font-bold tracking-tight">You are offline</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-600">
        Motoro cannot reach the network right now. Your live request tracking will resume as soon as
        you are back online.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <a
          href="/"
          className="rounded-2xl bg-ink px-6 py-3 text-sm font-semibold text-white shadow-pop transition hover:opacity-90"
        >
          Back to Motoro
        </a>
        <a
          href="/offline"
          className="rounded-2xl bg-sun-400 px-6 py-3 text-sm font-semibold text-ink shadow-card transition hover:bg-sun-300"
        >
          Try again
        </a>
      </div>
    </main>
  );
}
