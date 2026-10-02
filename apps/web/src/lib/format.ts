export function formatINR(cents: number | null | undefined, opts: { showDecimals?: boolean } = {}): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return 'None';
  const value = cents / 100;
  const hasPaisa = cents % 100 !== 0;
  const showDecimals = opts.showDecimals ?? hasPaisa;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(value);
}

export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined) return 'None';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatEta(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return 'None';
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  const hours = Math.floor(minutes / 60);
  const mins = Math.round(minutes % 60);
  return `${hours} h${mins ? ` ${mins} min` : ''}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'None';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'None';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return 'None';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'None';
  return new Intl.DateTimeFormat('en-IN', { timeStyle: 'short' }).format(date);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'None';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'None';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDateTime(iso);
}

export function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function vehicleLabel(vehicle: { make: string; model: string; registrationNumber: string } | null | undefined): string {
  if (!vehicle) return 'None';
  return `${vehicle.make} ${vehicle.model} · ${vehicle.registrationNumber}`;
}
