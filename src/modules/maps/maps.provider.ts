import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { AppError, notFound } from '../../lib/errors.js';
import { distanceMeters } from '../../lib/geo.js';

/**
 * Maps behind one interface (approved provider: Google Maps Platform). Secrets stay
 * on the server: place search, place details, reverse geocoding and routes are all
 * called from here, never from the browser.
 */
export interface LatLng {
  lat: number;
  lng: number;
}
export interface PlaceSuggestion {
  placeId: string;
  primary: string;
  secondary: string | null;
}
export interface PlaceDetails {
  placeId: string;
  address: string;
  lat: number;
  lng: number;
}
export interface RouteEstimate {
  distanceM: number;
  /** null when the provider cannot estimate travel time (development). */
  durationS: number | null;
  polyline: string | null;
  /** `route` = road route from the provider; `straight_line` = distance as the crow flies. */
  kind: 'route' | 'straight_line';
}

export interface MapsProvider {
  readonly name: 'dev' | 'google';
  readonly supportsSearch: boolean;
  autocomplete(input: string, sessionToken: string): Promise<PlaceSuggestion[]>;
  place(placeId: string, sessionToken: string | null): Promise<PlaceDetails>;
  reverse(at: LatLng): Promise<string | null>;
  route(from: LatLng, to: LatLng): Promise<RouteEstimate>;
}

const straightLine = (from: LatLng, to: LatLng): RouteEstimate => ({ distanceM: distanceMeters(from, to), durationS: null, polyline: null, kind: 'straight_line' });

/**
 * DEVELOPMENT ONLY (refused in production). Invents nothing: no place results, no
 * addresses, no travel times. Distance is a straight line and labelled as such.
 */
export class DevMapsProvider implements MapsProvider {
  readonly name = 'dev' as const;
  readonly supportsSearch = false;
  async autocomplete(): Promise<PlaceSuggestion[]> {
    return [];
  }
  async place(): Promise<PlaceDetails> {
    throw notFound('Place search is not available until the Google Maps key is configured.');
  }
  async reverse(): Promise<string | null> {
    return null;
  }
  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    return straightLine(from, to);
  }
}

/** Kigali city centre, used to bias place search (not to restrict it). */
const KIGALI = { latitude: -1.9441, longitude: 30.0619 };

type FetchLike = typeof fetch;

/**
 * Google Maps Platform: Places API (New) for search and details, Geocoding API for
 * reverse geocoding, Routes API for road distance and traffic-aware ETA. Requests
 * use field masks so only the billed fields we need are returned.
 */
export class GoogleMapsProvider implements MapsProvider {
  readonly name = 'google' as const;
  readonly supportsSearch = true;
  constructor(
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call(url: string, init: RequestInit & { fieldMask?: string }): Promise<unknown> {
    const headers: Record<string, string> = { 'X-Goog-Api-Key': this.key };
    if (init.fieldMask) headers['X-Goog-FieldMask'] = init.fieldMask;
    if (init.body) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(url, { method: init.method ?? 'GET', body: init.body, headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) {
      // Never log the key or the user's query; the status is enough to diagnose.
      logger.warn({ status: res.status, api: new URL(url).hostname }, 'maps provider error');
      throw new AppError(502, 'maps_unavailable', 'Map search is temporarily unavailable. Type the address instead.');
    }
    return res.json();
  }

  async autocomplete(input: string, sessionToken: string): Promise<PlaceSuggestion[]> {
    const body = {
      input,
      sessionToken,
      includedRegionCodes: ['rw'],
      locationBias: { circle: { center: KIGALI, radius: 50_000 } },
      languageCode: 'en',
    };
    const json = (await this.call('https://places.googleapis.com/v1/places:autocomplete', { method: 'POST', body: JSON.stringify(body) })) as {
      suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }>;
    };
    return (json.suggestions ?? [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId))
      .slice(0, 8)
      .map((p) => ({
        placeId: p.placeId!,
        primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary: p.structuredFormat?.secondaryText?.text ?? null,
      }));
  }

  async place(placeId: string, sessionToken: string | null): Promise<PlaceDetails> {
    const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
    const json = (await this.call(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}${qs}`, { fieldMask: 'id,displayName,formattedAddress,location' })) as {
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      location?: { latitude?: number; longitude?: number };
    };
    if (typeof json.location?.latitude !== 'number' || typeof json.location?.longitude !== 'number') throw notFound('Place not found.');
    const name = json.displayName?.text;
    const address = name && json.formattedAddress && !json.formattedAddress.startsWith(name) ? `${name}, ${json.formattedAddress}` : (json.formattedAddress ?? name ?? '');
    return { placeId: json.id ?? placeId, address: address.slice(0, 300), lat: json.location.latitude, lng: json.location.longitude };
  }

  async reverse(at: LatLng): Promise<string | null> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${at.lat},${at.lng}&language=en`;
    const json = (await this.call(url, {})) as { status?: string; results?: Array<{ formatted_address?: string }> };
    return json.status === 'OK' ? (json.results?.[0]?.formatted_address?.slice(0, 300) ?? null) : null;
  }

  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    const body = {
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
    };
    try {
      const json = (await this.call('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        body: JSON.stringify(body),
        fieldMask: 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
      })) as { routes?: Array<{ duration?: string; distanceMeters?: number; polyline?: { encodedPolyline?: string } }> };
      const r = json.routes?.[0];
      const seconds = r?.duration ? Number.parseInt(r.duration, 10) : NaN;
      if (!r || typeof r.distanceMeters !== 'number' || !Number.isFinite(seconds)) return straightLine(from, to);
      return { distanceM: r.distanceMeters, durationS: seconds, polyline: r.polyline?.encodedPolyline ?? null, kind: 'route' };
    } catch {
      // A failed route never blocks tracking: fall back to a labelled straight-line distance.
      return straightLine(from, to);
    }
  }
}

let cached: MapsProvider | null = null;
export function mapsProvider(): MapsProvider {
  if (!cached) {
    const e = env();
    cached = e.MAPS_PROVIDER === 'google' ? new GoogleMapsProvider(e.MAPS_SERVER_KEY!) : new DevMapsProvider();
  }
  return cached;
}
/** Test helper. */
export function setMapsProvider(p: MapsProvider | null): void {
  cached = p;
}
