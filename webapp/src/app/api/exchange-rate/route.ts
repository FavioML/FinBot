import { NextResponse } from 'next/server';
import { getExchangeRate } from '@/lib/exchange-rate';

export async function GET() {
  const rate = await getExchangeRate();
  return NextResponse.json({
    rate,
    pair: 'USD-PEN',
    updatedAt: new Date().toISOString(),
  });
}
