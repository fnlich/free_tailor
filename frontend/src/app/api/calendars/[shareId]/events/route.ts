import { NextResponse } from 'next/server';
import { getDefaultRange, getEvents } from '@/lib/calendar/service';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ shareId: string }> }
) {
  const { shareId } = await context.params;
  const { searchParams } = new URL(request.url);

  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const timeZone = searchParams.get('timeZone') ?? undefined;
  const fallbackRange = getDefaultRange();

  try {
    const result = await getEvents(shareId, {
      startDate: startDate ?? fallbackRange.startDate,
      endDate: endDate ?? fallbackRange.endDate,
      timeZone,
    });

    return NextResponse.json({
      ...result,
      range: {
        startDate: startDate ?? fallbackRange.startDate,
        endDate: endDate ?? fallbackRange.endDate,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to load calendar events.' },
      { status: 502 }
    );
  }
}
