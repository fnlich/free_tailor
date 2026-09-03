import { NextResponse } from 'next/server';
import { getCalendar } from '@/lib/calendar/service';

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
    return NextResponse.json(
      { message: error instanceof Error ? error.message : 'Failed to load calendar.' },
      { status: 502 }
    );
  }
}
