import logging
import json
import os
import asyncio
from datetime import datetime

import httpx
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import AgentSession, Agent, RoomInputOptions
from livekit.plugins import (
    assemblyai,
    noise_cancellation,
    silero,
)

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("medical-scribe")
logger.setLevel(logging.DEBUG)

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

    async def on_user_turn_completed(self, turn_ctx, new_message):
        # Suppress auto-reply — this is a listen-only scribe
        return


async def call_llm_gateway(system_prompt: str, user_content: str, max_tokens: int = 800) -> str | None:
    """Call AssemblyAI LLM Gateway for medical text processing."""
    headers = {
        "Authorization": os.getenv("ASSEMBLYAI_API_KEY", ""),
        "Content-Type": "application/json",
    }
    payload = {
        "model": os.getenv("LLM_GATEWAY_MODEL", "claude-3-haiku-20240307"),
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


async def generate_soap_note(encounter_buffer: list[dict]) -> str:
    """Generate a SOAP note from the full encounter transcript."""
    transcript_text = "\n".join(
        f"[{entry['timestamp']}] {entry['text']}" for entry in encounter_buffer
    )
    result = await call_llm_gateway(
        SOAP_NOTE_SYSTEM_PROMPT,
        f"Create a SOAP note from this clinical encounter:\n\n{transcript_text}",
        max_tokens=1500,
    )
    return result or "Unable to generate SOAP note. Please try again."


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()

    encounter_buffer: list[dict] = []

    stt_instance = assemblyai.STT(
        min_end_of_turn_silence_when_confident=800,
        max_turn_silence=3600,
        keyterms_prompt=MEDICAL_KEYTERMS,
    )

    session = AgentSession(
        stt=stt_instance,
        vad=silero.VAD.load(),
        turn_detection="stt",
        # No LLM or TTS — this is a listen-only scribe
    )

    # ── Collect raw transcription turns ─────────────────────────
    @session.on("user_input_transcribed")
    def on_transcription(ev):
        label = "FINAL" if ev.is_final else "PARTIAL"
        logger.info(f"[STT {label}] is_final={ev.is_final} transcript={ev.transcript[:120]!r}")

        # Send partial transcripts to the client so the UI can display live text
        if not ev.is_final:
            asyncio.create_task(
                ctx.room.local_participant.publish_data(
                    json.dumps({
                        "type": "partial_transcript",
                        "text": ev.transcript,
                    }).encode(),
                    reliable=False,  # unreliable is fine for partials — lower latency
                )
            )

        if ev.is_final:
            entry = {
                "timestamp": datetime.now().strftime("%H:%M:%S"),
                "text": ev.transcript,
            }
            encounter_buffer.append(entry)
            logger.info(f"Turn collected ({len(encounter_buffer)} total): {ev.transcript[:80]}...")

    # ── Handle data messages from client (SOAP generation) ────
    @ctx.room.on("data_received")
    def on_data_received(packet: rtc.DataPacket):
        try:
            message = json.loads(packet.data.decode())
            if message.get("type") == "generate_soap":
                asyncio.create_task(_handle_soap_request())
        except Exception as e:
            logger.error(f"Error processing data message: {e}")

    async def _handle_soap_request():
        if not encounter_buffer:
            await ctx.room.local_participant.publish_data(
                json.dumps({
                    "type": "soap_note",
                    "content": "No transcript data available. Please ensure the encounter has started.",
                }).encode(),
                reliable=True,
            )
            return

        # Notify client that generation is in progress
        await ctx.room.local_participant.publish_data(
            json.dumps({"type": "status", "message": "Generating SOAP note..."}).encode(),
            reliable=True,
        )

        soap = await generate_soap_note(encounter_buffer)

        await ctx.room.local_participant.publish_data(
            json.dumps({"type": "soap_note", "content": soap}).encode(),
            reliable=True,
        )
        logger.info("SOAP note generated and sent to client")

    await session.start(
        room=ctx.room,
        agent=MedicalScribe(),
        room_input_options=RoomInputOptions(
            noise_cancellation=noise_cancellation.BVC(),
            close_on_disconnect=False,
        ),
    )


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
