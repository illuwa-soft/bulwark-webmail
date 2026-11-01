import type { NextRequest } from 'next/server';
import { officeProxy } from '@/lib/eurooffice/connector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ slot: string; owner: string; path?: string[] }> };

async function serve(request: NextRequest, context: Route) {
  const params = await context.params;
  return officeProxy(request, { ...params, path: params.path ?? [] });
}

export const GET = serve;
export const HEAD = serve;
export const POST = serve;
export const PUT = serve;
