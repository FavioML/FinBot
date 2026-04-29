import { NextResponse } from 'next/server';
import { getAdminContext } from '@/lib/admin';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { isAdmin } = await getAdminContext();
  return NextResponse.json({ isAdmin });
}
