'use client';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-50 px-4 text-center">
      <p className="text-sm font-semibold text-red-600">Something went wrong</p>
      <h1 className="text-xl font-semibold text-slate-900">We hit a snag</h1>
      <p className="max-w-md text-sm text-slate-500">
        An unexpected error occurred. Nothing you did. Please try again, or head back home.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => reset()}
          className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Try again
        </button>
        <a
          href="/"
          className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Back to home
        </a>
      </div>
    </div>
  );
}
