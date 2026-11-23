import { NextResponse } from 'next/server';
import { requireWebRuntime, sql } from '@/lib/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'no-store'};

export async function GET() {
  try {
    await requireWebRuntime({verifyKey:true});
    await sql.one('SELECT COUNT(*) AS n FROM (SELECT id FROM workspaces LIMIT 1) AS ready');
    return NextResponse.json({status:'ready'},{headers});
  } catch {
    return NextResponse.json({status:'unavailable'},{status:503,headers});
  }
}
