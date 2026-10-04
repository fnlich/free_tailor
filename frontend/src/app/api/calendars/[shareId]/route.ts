import { NextResponse } from 'next/server';
import { getCalendar } from '@/lib/calendar/service';
import { calendarFailure } from '@/lib/calendar/routeFailure';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ shareId: string }> }
) {
  const { shareId } = await context.params;

  try {
    const result = await getCalendar(shareId);
    return NextResponse.json(result);
  } catch (error) {
    return calendarFailure('calendar', error);
  }
}
