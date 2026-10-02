'use client';

export function RetryButton() {
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="rounded-2xl bg-sun-400 px-6 py-3 text-sm font-semibold text-ink shadow-card transition hover:bg-sun-300"
    >
      Try again
    </button>
  );
}
