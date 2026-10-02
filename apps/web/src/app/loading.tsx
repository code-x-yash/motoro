export default function GlobalLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
        <p className="text-sm font-medium text-slate-500">Loading…</p>
      </div>
    </div>
  );
}
