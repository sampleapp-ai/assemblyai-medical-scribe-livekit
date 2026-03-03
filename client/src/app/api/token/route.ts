import { AccessToken, AgentDispatchClient } from "livekit-server-sdk";
import { NextResponse } from "next/server";

export async function POST() {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    return NextResponse.json(
      { error: "Missing LIVEKIT_API_KEY, LIVEKIT_API_SECRET, or LIVEKIT_URL" },
      { status: 500 }
    );
  }

  const roomName = `medical-scribe-room-${Math.random().toString(36).slice(2, 8)}`;
  const participantName = `clinician-${Math.random().toString(36).slice(2, 8)}`;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: participantName,
    ttl: "60m",
  });

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  const token = await at.toJwt();

  // Explicitly dispatch an agent to the room
  const dispatch = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);
  await dispatch.createDispatch(roomName, "");

  return NextResponse.json(
    { token, serverUrl: livekitUrl },
    { headers: { "Cache-Control": "no-store" } }
  );
}
