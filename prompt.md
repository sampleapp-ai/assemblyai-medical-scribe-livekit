# Build: Medical Scribe Agent with LiveKit + AssemblyAI Universal-3 Pro

## Goal

Build a listen-only ambient clinical documentation agent using LiveKit Agents SDK and AssemblyAI's Universal-3 Pro streaming STT. The agent listens to a doctor-patient conversation, transcribes in real time, post-processes each finalized turn through AssemblyAI's LLM Gateway for medical terminology correction, and generates a SOAP note at session end. **No TTS output** — this is a passive ambient scribe.

---

## AssemblyAI Universal-3 Pro (U3P) Streaming Context

U3P (`speech_model: "u3-rt-pro"`) is optimized for real-time audio utterances under 10 seconds with sub-300ms time-to-complete-transcript latency. Highest accuracy for entities, rare words, and domain-specific terminology.

### Connection

WebSocket endpoint: `wss://streaming.assemblyai.com/v3/ws`

```json
{
  "speech_model": "u3-rt-pro",
  "sample_rate": 16000
}
```

### Punctuation-Based Turn Detection

| Parameter | Default | Description |
|---|---|---|
| `min_end_of_turn_silence_when_confident` | 100ms | Silence before a speculative EOT check fires. Model checks for terminal punctuation (`.` `?` `!`). |
| `max_turn_silence` | 1200ms | Maximum silence before a turn is forced to end, regardless of punctuation. |

**How it works:**
1. Silence reaches `min_end_of_turn_silence_when_confident` → model checks for terminal punctuation
2. Terminal punctuation found → turn ends (`end_of_turn: true`)
3. No terminal punctuation → partial emitted (`end_of_turn: false`), turn continues
4. Silence reaches `max_turn_silence` → turn forced to end (`end_of_turn: true`)

**Important:** `end_of_turn` and `turn_is_formatted` always have the same value.

### Prompting

**`keyterms_prompt`** — Boost recognition of medical terminology:
```json
{ "keyterms_prompt": ["metformin", "echocardiogram", "Dr. Patel", "metoprolol"] }
```

**`prompt`** — Alternative: clinical context instructions for transcription behavior.

**`prompt` and `keyterms_prompt` are mutually exclusive.** When you use `keyterms_prompt`, your terms are appended to the default prompt automatically.

### Mid-Stream Configuration Updates

`UpdateConfiguration` changes parameters during an active session without reconnecting. This is especially useful for medical scribes where conversation stages change:

```json
{
  "type": "UpdateConfiguration",
  "keyterms_prompt": ["cardiology", "echocardiogram", "Dr. Patel", "metoprolol"]
}
```

**Example stage-based updates:**

```python
# Caller identification stage
{"type": "UpdateConfiguration", "keyterms_prompt": ["Kelly Byrne-Donoghue", "date of birth", "January", "February"]}

# Medical intake stage
{"type": "UpdateConfiguration", "keyterms_prompt": ["cardiology", "echocardiogram", "Dr. Patel", "metoprolol"]}
```

### ForceEndpoint

```json
{ "type": "ForceEndpoint" }
```

Useful when provider explicitly finishes a dictation segment.

### Not Available in Streaming

- **Speaker diarization** — Coming Soon for streaming
- **PII redaction** — Async-only

> **Hybrid approach:** Stream during the visit for real-time documentation, then process the recording through the async API post-visit for speaker-labeled, PII-redacted SOAP notes.

---

## Use Case: Medical Scribe — Ambient Clinical Documentation

Ambient scribe listening to a doctor-patient conversation and generating SOAP notes via LLM post-processing.

**U3P features used:**

| Feature | How it's used |
|---|---|
| `keyterms_prompt` | Medical terminology: medication names, procedure codes, conditions. |
| `UpdateConfiguration` | Update keyterms per conversation stage (caller ID → intake → exam → plan). |
| Conservative turn detection | Long pauses normal in clinical settings (provider thinking, examining, reviewing charts). |
| `ForceEndpoint` | End turn when provider explicitly finishes dictation segment. |

**Turn detection config (conservative — long clinical pauses):**

```json
{
  "speech_model": "u3-rt-pro",
  "min_end_of_turn_silence_when_confident": 800,
  "max_turn_silence": 3600
}
```

**Example medical keyterms:**
```python
[
    "hypertension", "diabetes mellitus", "coronary artery disease",
    "metformin 1000mg", "lisinopril 10mg", "atorvastatin 20mg",
    "chief complaint", "history of present illness", "review of systems",
    "physical examination", "assessment and plan",
    "auscultation", "palpation", "echocardiogram",
]
```

---

## AssemblyAI LLM Gateway

The LLM Gateway is used for post-processing each transcribed turn to correct medical terminology, and for generating the final SOAP note.

### LLM Gateway API

**Endpoint:** `https://llm-gateway.assemblyai.com/v1/chat/completions`

**Authentication:** Same AssemblyAI API key in the `Authorization` header.

**Request format:**
```python
import requests

url = "https://llm-gateway.assemblyai.com/v1/chat/completions"
headers = {
    "Authorization": os.getenv("ASSEMBLYAI_API_KEY"),
    "Content-Type": "application/json",
}
payload = {
    "model": "claude-3-5-haiku-20241022",  # or other supported model
    "messages": [
        {"role": "system", "content": "You are a clinical transcription editor..."},
        {"role": "user", "content": "Edit this transcript for medical accuracy..."},
    ],
    "max_tokens": 800,
    "temperature": 0.2,
}
response = requests.post(url, headers=headers, json=payload, timeout=60)
result = response.json()["choices"][0]["message"]["content"]
```

### Two LLM Gateway Use Cases in This App

1. **Per-turn medical editing** — On each finalized transcript turn, call LLM Gateway to correct medical terminology, drug names, dosages, anatomy terms, and punctuation for clinical readability.

2. **SOAP note generation** — At session end, send the full encounter transcript to LLM Gateway to generate a structured SOAP note (Subjective, Objective, Assessment, Plan).

### Medical Editing System Prompt

```
You are a clinical transcription editor. Keep the speaker's words, fix medical terminology (drug names, dosages, anatomy), proper nouns, and punctuation for readability. Preserve meaning and avoid inventing details. Prefer U.S. clinical style. If a medication or condition is phonetically close, correct to the most likely clinical term.
```

### SOAP Note Generation System Prompt

```
You are a clinician generating concise, structured notes. Produce a SOAP note (Subjective, Objective, Assessment, Plan). Use bullet points, keep it factual, infer reasonable clinical semantics from the transcript but do NOT invent data. Include medications with dosage and frequency if mentioned.
```

---

## Tech Stack: LiveKit Agents SDK (Listen-Only + LLM Gateway)

### Dependencies

```bash
pip install "livekit-agents[assemblyai,openai,silero]" python-dotenv requests
```

Note: No `rime` (TTS) needed. `requests` is for LLM Gateway HTTP calls.

### API Keys Needed

- **AssemblyAI** — STT + LLM Gateway (same key) (`ASSEMBLYAI_API_KEY`)
- **LiveKit Cloud** — WebRTC transport (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`)

### .env.example

```env
ASSEMBLYAI_API_KEY=your_assemblyai_api_key
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_api_key
LIVEKIT_API_SECRET=your_livekit_api_secret
LLM_GATEWAY_MODEL=claude-3-5-haiku-20241022
```

### Adaptation: Voice Agent Pattern → Listen-Only Medical Scribe

Start from the LiveKit voice agent pattern but make these key changes:

1. **Remove TTS** — No TTS, no Rime dependency
2. **Remove `generate_reply`** — The agent never speaks
3. **Add transcript collection** — Listen for STT events and accumulate finalized turns
4. **Add LLM Gateway per-turn editing** — On each finalized turn, call LLM Gateway for medical terminology correction
5. **Add SOAP note generation** — At session end, call LLM Gateway with the full encounter transcript
6. **Adjust turn detection** — Use conservative config (800ms / 3600ms) for clinical pauses

### Conceptual Code Structure

```python
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import AgentSession, Agent
from livekit.plugins import assemblyai, openai, silero
import requests
import os
import json
from datetime import datetime

load_dotenv()

# Encounter buffer
encounter_buffer = []

MEDICAL_KEYTERMS = [
    "hypertension", "diabetes mellitus", "coronary artery disease",
    "metformin 1000mg", "lisinopril 10mg", "atorvastatin 20mg",
    "chief complaint", "history of present illness", "review of systems",
    "physical examination", "assessment and plan",
    "auscultation", "palpation", "echocardiogram",
]


class MedicalScribe(Agent):
    def __init__(self) -> None:
        super().__init__(instructions="You are an ambient medical scribe. Listen to the clinical encounter and collect all transcript turns.")


def post_process_with_llm(text: str) -> str:
    """Medical editing via LLM Gateway."""
    url = "https://llm-gateway.assemblyai.com/v1/chat/completions"
    headers = {
        "Authorization": os.getenv("ASSEMBLYAI_API_KEY"),
        "Content-Type": "application/json",
    }
    payload = {
        "model": os.getenv("LLM_GATEWAY_MODEL", "claude-3-5-haiku-20241022"),
        "messages": [
            {"role": "system", "content": "You are a clinical transcription editor. Keep the speaker's words, fix medical terminology, proper nouns, and punctuation. Preserve meaning."},
            {"role": "user", "content": f"Edit for medical accuracy:\n\n{text}"},
        ],
        "max_tokens": 600,
        "temperature": 0.2,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    if resp.status_code == 200:
        return resp.json()["choices"][0]["message"]["content"].strip()
    return text  # fallback to original


def generate_soap_note(encounter_buffer):
    """Generate SOAP note from encounter transcript via LLM Gateway."""
    transcript_text = "\n".join([f"[{e['timestamp']}] {e['text']}" for e in encounter_buffer])
    url = "https://llm-gateway.assemblyai.com/v1/chat/completions"
    headers = {
        "Authorization": os.getenv("ASSEMBLYAI_API_KEY"),
        "Content-Type": "application/json",
    }
    payload = {
        "model": os.getenv("LLM_GATEWAY_MODEL", "claude-3-5-haiku-20241022"),
        "messages": [
            {"role": "system", "content": "You are a clinician generating concise, structured notes. Produce a SOAP note (Subjective, Objective, Assessment, Plan). Use bullet points, keep it factual, do NOT invent data."},
            {"role": "user", "content": f"Create a SOAP note from this clinical encounter:\n\n{transcript_text}"},
        ],
        "max_tokens": 1200,
        "temperature": 0.2,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    if resp.status_code == 200:
        soap = resp.json()["choices"][0]["message"]["content"].strip()
        fname = f"clinical_note_soap_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
        with open(fname, "w") as f:
            f.write(soap)
        print(f"SOAP note saved: {fname}")
        return soap
    return None


async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()

    session = AgentSession(
        stt=assemblyai.STT(
            min_end_of_turn_silence_when_confident=800,
            max_turn_silence=3600,
            keyterms_prompt=MEDICAL_KEYTERMS,
        ),
        llm=openai.LLM.with_cerebras(model="llama3.1-8b", temperature=0.3),
        vad=silero.VAD.load(),
        turn_detection="stt",
        # NO TTS — listen-only scribe
    )

    @session.on("user_input_transcribed")
    def on_transcription(transcript):
        if transcript.is_final:
            # Post-process through LLM Gateway for medical accuracy
            edited_text = post_process_with_llm(transcript.text)
            encounter_buffer.append({
                "timestamp": datetime.now().isoformat(),
                "text": edited_text,
                "original": transcript.text,
            })

    await session.start(room=ctx.room, agent=MedicalScribe())

    @ctx.room.on("disconnected")
    async def on_disconnect():
        generate_soap_note(encounter_buffer)


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
```

**Important:** This is a conceptual structure. The actual event names and API may differ — consult the LiveKit Agents SDK documentation for the correct event handlers. The key architectural decisions are:
- No TTS in the pipeline
- Conservative turn detection (800ms / 3600ms)
- Per-turn LLM Gateway post-processing for medical terminology
- SOAP note generation at session end via LLM Gateway

### How to Run

```bash
python medical_scribe.py dev
```

Then open LiveKit Agents Playground, select your project, and click "Connect". The agent will listen and transcribe without speaking. SOAP note is generated when the session ends.

---

## Deliverables Checklist

- [ ] `medical_scribe.py` — Working listen-only medical scribe agent with LLM Gateway integration
- [ ] `.env.example` — Template with all required API keys + LLM Gateway model config
- [ ] `requirements.txt` — All Python dependencies
- [ ] `README.md` — Setup instructions, prerequisites, how to run, architecture overview (STT → LLM Gateway editing → SOAP note), hybrid approach explanation
- [ ] `guide.mdx` — Step-by-step documentation using `codefocussection` components

### guide.mdx Format

```jsx
<codefocussection
  filepath="medical_scribe.py"
  filerange="1-15"
  title="Import libraries and configure environment"
  themeColor="#0000FF"
  label="Server"
>
  Description of imports and setup.
</codefocussection>
```

Break the guide into: imports, medical keyterms config, LLM Gateway helpers (per-turn editing + SOAP generation), agent class, session setup (conservative turn detection), transcript collection with LLM Gateway post-processing, SOAP note generation, and running the agent.

### Async-Only Note

Speaker diarization and PII redaction are async-only. The recommended approach is a hybrid workflow: stream during the visit for real-time documentation, then process the recording through the async API post-visit for speaker-labeled, PII-redacted SOAP notes. Mention this prominently in the README.
