import { NextResponse } from 'next/server';
import { getEvent } from '@/lib/calendar/service';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ shareId: string; eventId: string }> }
) {
  const { shareId, eventId } = await context.params;
  const { searchParams } = new URL(request.url);
  const timeZone = searchParams.get('timeZone') ?? undefined;

  try {
    const result = await getEvent(shareId, eventId, { timeZone });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to load calendar event.' },
      { status: 502 }
    );
  }
}
