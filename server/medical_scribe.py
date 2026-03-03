import logging
import json
import os
import asyncio
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import AgentSession, Agent, RoomInputOptions
from livekit.plugins import (
    assemblyai,
    noise_cancellation,
    silero,
)

# Load shared .env from the medical-scribe root (when running locally), then local overrides
_server_dir = Path(__file__).resolve().parent
_shared_env = _server_dir.parent.parent / ".env"
if _shared_env.exists():
    load_dotenv(_shared_env)
load_dotenv()  # local server/.env (or Docker env vars) can override

logger = logging.getLogger("medical-scribe")

# ── Medical keyterms for recognition boost ────────────────────
MEDICAL_KEYTERMS = [
    "hypertension",
    "diabetes mellitus",
    "coronary artery disease",
    "metformin 1000mg",
    "lisinopril 10mg",
    "atorvastatin 20mg",
    "chief complaint",
    "history of present illness",
    "review of systems",
    "physical examination",
    "assessment and plan",
    "auscultation",
    "palpation",
    "echocardiogram",
    "hemoglobin A1c",
    "blood pressure",
    "heart rate",
    "respiratory rate",
    "oxygen saturation",
    "body mass index",
]

LLM_GATEWAY_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions"

SOAP_NOTE_SYSTEM_PROMPT = (
    "You are a clinician generating concise, structured notes. "
    "Produce a SOAP note (Subjective, Objective, Assessment, Plan). "
    "Use bullet points, keep it factual, infer reasonable clinical "
    "semantics from the transcript but do NOT invent data. Include "
    "medications with dosage and frequency if mentioned."
)


class MedicalScribe(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are an ambient medical scribe. Listen to the clinical "
                "encounter and collect all transcript turns. Do not speak."
            )
        )
        self.encounter_buffer: list[dict] = []

    async def on_user_turn_completed(self, turn_ctx, new_message):
        return  # listen-only scribe — suppress auto-reply

    def _publish(self, data: dict, *, reliable: bool = True):
        """Fire-and-forget publish a JSON message to the room."""
        room = self.session.room
        asyncio.create_task(
            room.local_participant.publish_data(
                json.dumps(data).encode(), reliable=reliable,
            )
        )

    def on_transcription(self, ev):
        """Handle both partial and final transcription events."""
        if not ev.is_final:
            self._publish(
                {"type": "partial_transcript", "text": ev.transcript},
                reliable=False,
            )
            return

        entry = {
            "timestamp": datetime.now().strftime("%H:%M:%S"),
            "text": ev.transcript,
        }
        self.encounter_buffer.append(entry)
        logger.info(f"Turn collected ({len(self.encounter_buffer)} total)")

    def on_data_received(self, packet: rtc.DataPacket):
        """Handle data messages from client (e.g. SOAP generation requests)."""
        try:
            message = json.loads(packet.data.decode())
            if message.get("type") == "generate_soap":
                asyncio.create_task(self._handle_soap_request())
        except Exception as e:
            logger.error(f"Error processing data message: {e}")

    async def _handle_soap_request(self):
        if not self.encounter_buffer:
            self._publish({
                "type": "soap_note",
                "content": "No transcript data available. Please ensure the encounter has started.",
            })
            return

        self._publish({"type": "status", "message": "Generating SOAP note..."})

        soap = await self._generate_soap_note()
        self._publish({"type": "soap_note", "content": soap})
        logger.info("SOAP note generated and sent to client")

    async def _generate_soap_note(self) -> str:
        transcript_text = "\n".join(
            f"[{e['timestamp']}] {e['text']}" for e in self.encounter_buffer
        )
        result = await _call_llm_gateway(
            SOAP_NOTE_SYSTEM_PROMPT,
            f"Create a SOAP note from this clinical encounter:\n\n{transcript_text}",
            max_tokens=1500,
        )
        return result or "Unable to generate SOAP note. Please try again."


async def _call_llm_gateway(system_prompt: str, user_content: str, max_tokens: int = 800) -> str | None:
    """Call AssemblyAI LLM Gateway for medical text processing."""
    headers = {
        "Authorization": os.getenv("ASSEMBLYAI_API_KEY", ""),
        "Content-Type": "application/json",
    }
    payload = {
        "model": os.getenv("LLM_GATEWAY_MODEL", "claude-haiku-4-5-20251001"),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(LLM_GATEWAY_URL, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        logger.error(f"LLM Gateway error: {e}")
        return None


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()

    scribe = MedicalScribe()

    session = AgentSession(
        stt=assemblyai.STT(
            min_end_of_turn_silence_when_confident=800,
            max_turn_silence=3600,
            keyterms_prompt=MEDICAL_KEYTERMS,
        ),
        vad=silero.VAD.load(),
        turn_detection="stt",
    )

    session.on("user_input_transcribed", scribe.on_transcription)
    ctx.room.on("data_received", scribe.on_data_received)

    await session.start(
        room=ctx.room,
        agent=scribe,
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
            close_on_disconnect=False,
        ),
    )


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
