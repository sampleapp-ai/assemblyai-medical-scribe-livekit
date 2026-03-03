# Waiting for the Agent Before Recording

## The Problem

When the clinician clicks "Start Encounter", three things happen asynchronously:

1. The token route creates the room and dispatches the agent
2. The client receives its token and joins the room
3. The agent boots up (loads VAD model, connects STT websocket) and joins the room

There's no guarantee the agent is ready when the client joins. If the clinician starts speaking before the agent is connected, that speech is lost — the scribe never hears it.

## The Solution

Two changes work together to eliminate this race condition:

### 1. Server-side: Room creation with agent dispatch (`route.ts`)

```ts
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

const roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
await roomService.createRoom({
  name: roomName,
  agents: [{ agentName: "" }],
});
```

`RoomServiceClient.createRoom` combines room creation and agent dispatch into a single call. The `agents: [{ agentName: "" }]` config tells LiveKit to start the scribe agent as soon as the room exists. This happens *before* the token is returned to the client, so the agent begins booting while the client is still receiving its connection details.

Previously this used `AgentDispatchClient.createDispatch` as a separate call after token generation — the new approach is both cleaner and starts the agent earlier.

### 2. Client-side: `useAgentReady` hook (`page.tsx`)

```tsx
import { RoomEvent, ParticipantKind } from "livekit-client";

function useAgentReady() {
  const room = useRoomContext();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Check if agent is already in the room
    for (const p of room.remoteParticipants.values()) {
      if (p.kind === ParticipantKind.AGENT) {
        setReady(true);
        return;
      }
    }

    // Listen for agent joining
    const onParticipantConnected = (participant) => {
      if (participant.kind === ParticipantKind.AGENT) {
        setReady(true);
      }
    };

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    return () => { room.off(RoomEvent.ParticipantConnected, onParticipantConnected); };
  }, [room]);

  return ready;
}
```

The hook handles two timing scenarios:

- **Agent joined first**: Iterates `room.remoteParticipants` on mount. If an agent participant is already present, returns `ready = true` immediately.
- **Client joined first**: Listens for `RoomEvent.ParticipantConnected` and checks `participant.kind === ParticipantKind.AGENT`. When the agent arrives, flips to `ready = true`.

### 3. Loading UI gate

```tsx
function MedicalScribeView() {
  const agentReady = useAgentReady();

  if (!agentReady) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
        <p className="text-zinc-400 text-sm">Connecting to scribe agent...</p>
      </div>
    );
  }

  return ( /* full recording UI */ );
}
```

The recording UI only renders once `agentReady` is `true`. Until then, the clinician sees a spinner. This prevents anyone from speaking before the scribe is actually listening.

## Connection Flow

```
User clicks "Start Encounter"
  │
  ▼
POST /api/token
  ├─ roomService.createRoom({ agents: [...] })  ← agent starts booting
  ├─ generate access token
  └─ return { token, serverUrl }
  │
  ▼
<LiveKitRoom> connects client to room
  │
  ▼
MedicalScribeView renders
  ├─ useAgentReady() → false
  └─ shows "Connecting to scribe agent..." spinner
  │
  ▼
Agent finishes booting, joins room
  │
  ▼
RoomEvent.ParticipantConnected fires (kind === AGENT)
  ├─ useAgentReady() → true
  └─ recording UI appears — no speech is missed
```
