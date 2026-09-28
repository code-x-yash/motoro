'use client';

import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Map as LeafletMap, Polyline } from 'leaflet';
import { cn } from '@rr/ui';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  label?: string;
  tone?: 'brand' | 'emerald' | 'rose' | 'amber';
  icon?: ReactNode;
}

export interface MapRoute {
  from: { latitude: number; longitude: number };
  to: { latitude: number; longitude: number };
}

export interface MapRouteInfo {
  distanceKm: number | null;
  durationMin: number | null;
  source: 'osrm' | 'straight';
}

export interface MapPanelProps {
  markers?: MapMarker[];
  className?: string;
  height?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  footer?: ReactNode;
  route?: MapRoute | null;
  onRouteInfo?: (info: MapRouteInfo | null) => void;
  mapsLink?: string | null;
}

const TONE_CLASS: Record<string, string> = {
  brand: 'bg-brand-600 text-white',
  emerald: 'bg-emerald-600 text-white',
  rose: 'bg-rose-600 text-white',
  amber: 'bg-amber-500 text-white',
};

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const OSRM_TIMEOUT_MS = 6000;

type MapMode = 'pending' | 'leaflet' | 'fallback';
type LatLngTuple = [number, number];

interface OsrmRouteDto {
  routes?: {
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: number[][] };
  }[];
}

interface ProjectedMarker extends MapMarker {
  x: number;
  y: number;
}

const ROUTE_CACHE = new Map<string, { coords: LatLngTuple[]; info: MapRouteInfo }>();

function routeKey(route: MapRoute): string {
  const at = (n: number) => n.toFixed(4);
  return `${at(route.from.latitude)},${at(route.from.longitude)}>${at(route.to.latitude)},${at(route.to.longitude)}`;
}

function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function projectMarkers(markers: MapMarker[]): ProjectedMarker[] {
  if (markers.length === 0) return [];
  const lats = markers.map((marker) => marker.latitude);
  const lngs = markers.map((marker) => marker.longitude);
  let minLat = Math.min(...lats);
  let maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);
  const padLat = Math.max((maxLat - minLat) * 0.3, 0.01);
  const padLng = Math.max((maxLng - minLng) * 0.3, 0.01);
  minLat -= padLat;
  maxLat += padLat;
  minLng -= padLng;
  maxLng += padLng;
  return markers.map((marker) => ({
    ...marker,
    x: ((marker.longitude - minLng) / (maxLng - minLng || 1)) * 100,
    y: (1 - (marker.latitude - minLat) / (maxLat - minLat || 1)) * 100,
  }));
}

/**
 * Real slippy map (OpenStreetMap tiles via Leaflet, loaded client-side only).
 * Keeps the gridded canvas underneath as an offline fallback and degrades to the
 * bounding-box projection if Leaflet cannot be loaded at all.
 */
export function MapPanel({
  markers = [],
  className,
  height = 'h-64',
  selectedId,
  onSelect,
  footer,
  route,
  onRouteInfo,
  mapsLink,
}: MapPanelProps) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const lineRef = useRef<Polyline | null>(null);
  const markersRef = useRef(markers);
  const routeRef = useRef(route);
  const onRouteInfoRef = useRef(onRouteInfo);
  const needsFitRef = useRef(true);

  const [mode, setMode] = useState<MapMode>('pending');
  const [points, setPoints] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    markersRef.current = markers;
  });

  useEffect(() => {
    routeRef.current = route;
    onRouteInfoRef.current = onRouteInfo;
  });

  useEffect(
    () => () => {
      onRouteInfoRef.current?.(null);
    },
    [],
  );

  const projected = useMemo(() => projectMarkers(markers), [markers]);

  const updatePoints = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const next: Record<string, { x: number; y: number }> = {};
    for (const marker of markersRef.current) {
      const point = map.latLngToContainerPoint([marker.latitude, marker.longitude]);
      next[marker.id] = { x: point.x, y: point.y };
    }
    setPoints(next);
  }, []);

  const enabled = markers.length > 0;

  useEffect(() => {
    const el = mapElRef.current;
    if (!enabled || !el) return;
    let disposed = false;
    let map: LeafletMap | null = null;
    let observer: ResizeObserver | null = null;

    void (async () => {
      try {
        const L = await import('leaflet');
        if (disposed) return;
        const first = markersRef.current[0];
        map = L.map(el, { zoomControl: true, attributionControl: true });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);
        map.on('move', updatePoints);
        map.on('resize', updatePoints);
        if (first) map.setView([first.latitude, first.longitude], 15);
        leafletRef.current = L;
        mapRef.current = map;
        updatePoints();
        setMode('leaflet');
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(() => {
            mapRef.current?.invalidateSize();
            updatePoints();
          });
          observer.observe(el);
        }
      } catch {
        if (!disposed) setMode('fallback');
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      leafletRef.current = null;
      mapRef.current = null;
      lineRef.current = null;
      map?.remove();
      map = null;
      setPoints({});
      setMode('pending');
    };
  }, [enabled, updatePoints]);

  const markerSignature = markers.map((marker) => marker.id).join('|');

  useEffect(() => {
    const list = markersRef.current;
    const map = mapRef.current;
    if (!map || list.length === 0) return;
    if (list.length === 1) {
      map.setView([list[0].latitude, list[0].longitude], 15);
    } else {
      map.fitBounds(
        list.map((marker) => [marker.latitude, marker.longitude] as LatLngTuple),
        { padding: [48, 48] },
      );
    }
  }, [mode, markerSignature]);

  useEffect(() => {
    updatePoints();
  }, [mode, markers, updatePoints]);

  const routeKeyStr = route ? routeKey(route) : '';

  useEffect(() => {
    const notify = (info: MapRouteInfo | null) => onRouteInfoRef.current?.(info);
    const clearLine = () => {
      lineRef.current?.remove();
      lineRef.current = null;
    };
    const active = routeRef.current;
    if (!active) {
      clearLine();
      needsFitRef.current = true;
      notify(null);
      return;
    }
    const L = leafletRef.current;
    const map = mapRef.current;
    if (mode !== 'leaflet' || !L || !map) return;

    let disposed = false;
    const key = routeKeyStr;
    const from = active.from;
    const to = active.to;

    const draw = (coords: LatLngTuple[], info: MapRouteInfo) => {
      if (disposed) return;
      clearLine();
      lineRef.current = L.polyline(
        coords,
        info.source === 'osrm'
          ? { color: '#d93809', weight: 5, opacity: 0.8 }
          : { color: '#d93809', weight: 5, opacity: 0.8, dashArray: '8 8' },
      ).addTo(map);
      const bounds = lineRef.current.getBounds();
      if (needsFitRef.current || !map.getBounds().contains(bounds)) {
        map.fitBounds(bounds, { padding: [48, 48] });
        needsFitRef.current = false;
      }
      notify(info);
    };

    const straightFallback = () => {
      const coords: LatLngTuple[] = [
        [from.latitude, from.longitude],
        [to.latitude, to.longitude],
      ];
      const km = haversineKm(from, to);
      const info: MapRouteInfo = {
        distanceKm: Math.round(km * 10) / 10,
        durationMin: Math.max(1, Math.round(km * 1.5)),
        source: 'straight',
      };
      ROUTE_CACHE.set(key, { coords, info });
      draw(coords, info);
    };

    const cached = ROUTE_CACHE.get(key);
    if (cached) {
      draw(cached.coords, cached.info);
      return () => {
        disposed = true;
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    const url = `${OSRM_URL}/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=full&geometries=geojson`;

    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`OSRM ${response.status}`);
        return response.json() as Promise<OsrmRouteDto>;
      })
      .then((data) => {
        const best = data.routes?.[0];
        const raw = best?.geometry?.coordinates;
        if (!best || typeof best.distance !== 'number' || typeof best.duration !== 'number' || !raw?.length) {
          throw new Error('OSRM returned no route');
        }
        const coords = raw
          .filter((point) => Array.isArray(point) && point.length >= 2)
          .map((point) => [point[1], point[0]] as LatLngTuple);
        if (coords.length < 2) throw new Error('OSRM returned no geometry');
        const info: MapRouteInfo = {
          distanceKm: Math.round((best.distance / 1000) * 10) / 10,
          durationMin: Math.max(1, Math.round(best.duration / 60)),
          source: 'osrm',
        };
        ROUTE_CACHE.set(key, { coords, info });
        draw(coords, info);
      })
      .catch(() => {
        if (!disposed) straightFallback();
      })
      .finally(() => clearTimeout(timer));

    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [mode, routeKeyStr]);

  const leafletPins = mode === 'leaflet';
  const pins: { marker: MapMarker; left: number | string; top: number | string }[] = leafletPins
    ? markers.flatMap((marker) => {
        const point = points[marker.id];
        return point ? [{ marker, left: point.x, top: point.y }] : [];
      })
    : projected.map((marker) => ({ marker, left: `${marker.x}%`, top: `${marker.y}%` }));

  return (
    <div className={cn('relative overflow-hidden rounded-xl border border-slate-200 bg-slate-100', className)}>
      <div className={cn('map-canvas relative w-full', height)}>
        <div ref={mapElRef} className="absolute inset-0" />
        {markers.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 z-[600] flex items-center justify-center text-xs text-slate-400">
            Waiting for location…
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-0 z-[500]">
          {pins.map(({ marker, left, top }) => {
            const selected = marker.id === selectedId;
            return (
              <button
                key={marker.id}
                type="button"
                onClick={() => onSelect?.(marker.id)}
                className={cn(
                  'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-md transition-transform hover:scale-110',
                  TONE_CLASS[marker.tone ?? 'brand'],
                  selected ? 'ring-4 ring-brand-300' : '',
                  marker.icon ? 'flex h-8 w-8 items-center justify-center text-sm' : 'h-4 w-4',
                )}
                style={{ left, top }}
                title={marker.label}
                aria-label={marker.label}
              >
                {marker.icon}
              </button>
            );
          })}
        </div>
        {mapsLink ? (
          <a
            href={mapsLink}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute bottom-8 right-2 z-[600] rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 shadow-md ring-1 ring-slate-900/10 transition-colors hover:bg-slate-50"
          >
            Open in Google Maps
          </a>
        ) : null}
        <div className="pointer-events-none absolute bottom-2 left-2 z-[600] rounded bg-white/90 px-2 py-1 text-[10px] text-slate-500 shadow-sm">
          {markers.length} location{markers.length === 1 ? '' : 's'} · live
        </div>
      </div>
      {footer ? <div className="border-t border-slate-200 bg-white px-3 py-2">{footer}</div> : null}
    </div>
  );
}
