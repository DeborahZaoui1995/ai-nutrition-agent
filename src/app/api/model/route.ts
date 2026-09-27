import { NextResponse } from "next/server";

const MODEL_BASE_URL = "https://teachablemachine.withgoogle.com/models/sMyhSfR1W/";

export async function GET() {
  return NextResponse.json({
    modelUrl: `${MODEL_BASE_URL}model.json`,
    metadataUrl: `${MODEL_BASE_URL}metadata.json`,
    classes: ["Water", "HEALTHY_SNACK", "UNHEALTHY_SNACK", "NO_OBJECT"],
  });
}
