import { NextResponse } from 'next/server';
import { getEvent } from '@/lib/calendar/service';
import { calendarFailure } from '@/lib/calendar/routeFailure';

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
    return calendarFailure('calendar event', error);
  }
}
