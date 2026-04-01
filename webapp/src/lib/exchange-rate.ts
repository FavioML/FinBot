/**
 * Shared exchange rate utility for USD → PEN conversion.
 * Uses dolar.pe API with 1-hour cache and fallback.
 */

const FALLBACK_RATE = 3.85;
let cachedRate: { rate: number; timestamp: number } | null = null;
const CACHE_TTL = 3600_000; // 1 hour

async function fetchRateForDate(date: string): Promise<number | null> {
  const res = await fetch(
    `https://dolar.pe/api/public/series?pair=USD-PEN&from=${date}&to=${date}`,
    { signal: AbortSignal.timeout(5000) }
  );
  if (!res.ok) return null;
  const json = await res.json();
  const series = json?.series?.['USD-PEN'];
  if (series?.data?.length > 0) {
    const lastRate = series.data[series.data.length - 1];
    if (typeof lastRate === 'number' && lastRate > 3.0 && lastRate < 5.0) {
      return lastRate;
    }
  }
  return null;
}

/** Get current USD→PEN exchange rate (server-side, cached 1h) */
export async function getExchangeRate(): Promise<number> {
  const now = Date.now();
  if (cachedRate && now - cachedRate.timestamp < CACHE_TTL) {
    return cachedRate.rate;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    let rate = await fetchRateForDate(today);

    if (!rate) {
      // dolar.pe may not have today's data before ~9am Lima
      const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      rate = await fetchRateForDate(yesterday);
    }

    if (rate) {
      cachedRate = { rate, timestamp: now };
      return rate;
    }

    return cachedRate?.rate || FALLBACK_RATE;
  } catch {
    return cachedRate?.rate || FALLBACK_RATE;
  }
}
