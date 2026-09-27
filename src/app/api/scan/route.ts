import { NextRequest, NextResponse } from "next/server";

interface ScanPayload {
  className: string;
  confidence: number;
  timestamp: number;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Partial<ScanPayload>;

  if (
    typeof body.className !== "string" ||
    typeof body.confidence !== "number" ||
    typeof body.timestamp !== "number"
  ) {
    return NextResponse.json({ ok: false, error: "Invalid scan payload" }, { status: 400 });
  }

  console.log(
    `[scan] ${body.className} (${(body.confidence * 100).toFixed(1)}%) at ${new Date(
      body.timestamp
    ).toISOString()}`
  );

  return NextResponse.json({ ok: true });
}
