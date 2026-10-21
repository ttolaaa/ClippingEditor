import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe used by the Docker HEALTHCHECK; also reports the deployed git commit. */
export async function GET() {
  return NextResponse.json({ status: "ok", version: process.env.APP_VERSION || "dev", uptime: Math.round(process.uptime()) });
}
