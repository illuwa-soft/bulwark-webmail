import type { NextRequest } from 'next/server';
import { officeSettings } from '@/lib/eurooffice/connector';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: NextRequest) => officeSettings(request);
export const POST = (request: NextRequest) => officeSettings(request);
