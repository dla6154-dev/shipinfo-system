const RENDER_BASE = 'https://mokpo-weather-dashboard.onrender.com';
const CACHE_ID = 'kma-buoy-snapshot';
const TTL_SECONDS = 360;
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
const TARGET_STATION_IDS = new Set([
  '22500',
  '22449',
  '959',
  '22481',
  '22297',
  '22184',
  '22457',
  '690704',
  '1139001',
]);

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function buildSelectionKey(row: JsonRecord): string {
  return `${asText(row.observationType)}|${asText(row.stationId)}|${asText(row.stationName)}`;
}

function isTargetSelectionKey(selectionKey: string): boolean {
  const [, stationId = ''] = String(selectionKey || '').split('|');
  return TARGET_STATION_IDS.has(stationId.trim());
}

function buildObservedAt(row: JsonRecord): string | null {
  const explicitObservedAt = asText(row.observedAt);
  if (explicitObservedAt) {
    const parsed = new Date(explicitObservedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const year = asText(row.year);
  const monthDay = asText(row.monthDay);
  const hhmm = asText(row.hhmm);
  if (!/^\d{4}$/.test(year) || !/^\d{4}$/.test(monthDay) || !/^\d{4}$/.test(hhmm)) {
    return null;
  }

  const observedAt = new Date(`${year}-${monthDay.slice(0, 2)}-${monthDay.slice(2, 4)}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00+09:00`);
  return Number.isNaN(observedAt.getTime()) ? null : observedAt.toISOString();
}

function normalizeHistorySamples(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function pruneHistorySamples(samples: JsonRecord[], nowMs: number): JsonRecord[] {
  const cutoff = nowMs - HISTORY_WINDOW_MS;
  const deduped = new Map<string, JsonRecord>();

  for (const sample of samples) {
    const observedAt = buildObservedAt(sample);
    if (!observedAt) continue;

    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs) || observedMs < cutoff) continue;

    deduped.set(observedAt, { ...sample, observedAt });
  }

  return Array.from(deduped.values()).sort((a, b) => {
    return Date.parse(asText(a.observedAt)) - Date.parse(asText(b.observedAt));
  });
}

function buildHistoryBySelection(rawPayload: JsonRecord, existingPayload: JsonRecord | null, nowMs: number): Record<string, JsonRecord[]> {
  const nextHistory: Record<string, JsonRecord[]> = {};
  const previousHistory = isRecord(existingPayload?.historyBySelection) ? existingPayload.historyBySelection : {};

  for (const selectionKey of Object.keys(previousHistory)) {
    if (!isTargetSelectionKey(selectionKey)) continue;
    const previousSamples = normalizeHistorySamples(previousHistory[selectionKey]);
    const prunedSamples = pruneHistorySamples(previousSamples, nowMs);
    if (prunedSamples.length) {
      nextHistory[selectionKey] = prunedSamples;
    }
  }

  const rows = Array.isArray(rawPayload.rows) ? rawPayload.rows.filter(isRecord) : [];
  for (const row of rows) {
    const stationId = asText(row.stationId);
    if (!TARGET_STATION_IDS.has(stationId)) continue;

    const selectionKey = buildSelectionKey(row);
    const observedAt = buildObservedAt(row);
    if (!observedAt) continue;

    const existingSamples = nextHistory[selectionKey] ?? [];
    existingSamples.push({ ...row, observedAt });
    nextHistory[selectionKey] = pruneHistorySamples(existingSamples, nowMs);
  }

  return nextHistory;
}

async function fetchExistingPayload(supabaseUrl: string, supabaseKey: string): Promise<JsonRecord | null> {
  const res = await fetch(`${supabaseUrl}/rest/v1/external_api_cache?id=eq.${encodeURIComponent(CACHE_ID)}&select=payload`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`Supabase read failed: ${await res.text()}`);
  }

  const rows = await res.json();
  const payload = rows?.[0]?.payload;
  return isRecord(payload) ? payload : null;
}

Deno.serve(async () => {
  try {
    const now = Date.now();
    const snapshotUrl = new URL('/api/query1/snapshot', `${RENDER_BASE}/`);
    snapshotUrl.searchParams.set('_ts', String(now));
    const res = await fetch(snapshotUrl.toString(), {
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`Render HTTP ${res.status}`);

    const rawPayload = await res.json();
    if (!isRecord(rawPayload)) {
      throw new Error('Unexpected payload shape from Render');
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const expiresAt = new Date(now + TTL_SECONDS * 1000).toISOString();
    const existingPayload = await fetchExistingPayload(supabaseUrl, supabaseKey);
    const payload = {
      ...rawPayload,
      historyBySelection: buildHistoryBySelection(rawPayload, existingPayload, now),
      historyWindowHours: 6,
    };

    const upsertRes = await fetch(`${supabaseUrl}/rest/v1/external_api_cache`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        id: CACHE_ID,
        cacheKey: CACHE_ID,
        path: '/api/query1/snapshot',
        params: {},
        payload,
        ttlSeconds: TTL_SECONDS,
        fetchedAt: new Date(now).toISOString(),
        expiresAt,
      }),
    });

    if (!upsertRes.ok) throw new Error(`Supabase upsert failed: ${await upsertRes.text()}`);

    return new Response(
      JSON.stringify({ ok: true, fetchedAt: new Date(now).toISOString(), ttlSeconds: TTL_SECONDS }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
