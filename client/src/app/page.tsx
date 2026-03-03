"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  LiveKitRoom,
  DisconnectButton,
  useTrackTranscription,
  useLocalParticipant,
} from "@livekit/components-react";
import { Track, RoomEvent } from "livekit-client";
import { useRoomContext } from "@livekit/components-react";

/* ================================================================
   Pre-connection screen
   ================================================================ */

export default function Page() {
  const [connectionDetails, setConnectionDetails] = useState<{
    token: string;
    serverUrl: string;
  } | null>(null);

  const connect = useCallback(async () => {
    const res = await fetch("/api/token", { method: "POST" });
    const data = await res.json();
    setConnectionDetails(data);
  }, []);

  const disconnect = useCallback(() => {
    setConnectionDetails(null);
  }, []);

  if (!connectionDetails) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-8">
        <div className="scribe-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 18.5a6.5 6.5 0 0 0 6.5-6.5V6a6.5 6.5 0 0 0-13 0v6a6.5 6.5 0 0 0 6.5 6.5Z" />
            <path d="M12 18.5V22" />
            <path d="M8 22h8" />
          </svg>
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Medical Scribe
          </h1>
          <p className="text-zinc-500 text-sm text-center max-w-xs">
            Ambient clinical documentation powered by Universal-3 Pro
          </p>
        </div>
        <button
          onClick={connect}
          className="px-10 py-3 bg-emerald-600 text-white rounded-full font-medium text-base hover:bg-emerald-500 transition-colors cursor-pointer"
        >
          Start Encounter
        </button>
      </div>
    );
  }

  return (
    <LiveKitRoom
      token={connectionDetails.token}
      serverUrl={connectionDetails.serverUrl}
      connect={true}
      audio={true}
      onDisconnected={disconnect}
      className="flex flex-col min-h-screen"
    >
      <MedicalScribeView />
    </LiveKitRoom>
  );
}

/* ================================================================
   Encounter timer hook
   ================================================================ */

function useEncounterTimer() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    startRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const hrs = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;
  const formatted = hrs > 0
    ? `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  return formatted;
}

/* ================================================================
   Data channel hook — receive SOAP note from the server agent
   ================================================================ */

function useAgentData() {
  const room = useRoomContext();
  const [soapNote, setSoapNote] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [partialTranscript, setPartialTranscript] = useState<string | null>(null);

  useEffect(() => {
    const handler = (payload: Uint8Array) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        console.log("[DataChannel] received:", data.type, data);
        if (data.type === "soap_note") {
          setSoapNote(data.content);
          setStatus(null);
        } else if (data.type === "status") {
          setStatus(data.message);
        } else if (data.type === "partial_transcript") {
          console.log("[DataChannel] PARTIAL:", data.text);
          setPartialTranscript(data.text);
        }
      } catch {
        // ignore malformed data
      }
    };

    room.on(RoomEvent.DataReceived, handler);
    return () => { room.off(RoomEvent.DataReceived, handler); };
  }, [room]);

  const requestSoapNote = useCallback(() => {
    const encoder = new TextEncoder();
    room.localParticipant.publishData(
      encoder.encode(JSON.stringify({ type: "generate_soap" })),
      { reliable: true }
    );
    setStatus("Generating SOAP note...");
  }, [room]);

  // Clear partial when a final segment arrives (called from outside)
  const clearPartial = useCallback(() => setPartialTranscript(null), []);

  return { soapNote, status, partialTranscript, clearPartial, requestSoapNote };
}

/* ================================================================
   Main encounter view
   ================================================================ */

function MedicalScribeView() {
  const { localParticipant } = useLocalParticipant();
  const timer = useEncounterTimer();
  const { soapNote, status, partialTranscript, clearPartial, requestSoapNote } = useAgentData();
  const [phase, setPhase] = useState<"recording" | "review">("recording");

  // Get raw transcription from local mic (real-time display)
  const localMicTrack = localParticipant.getTrackPublications().find(
    (pub) => pub.track?.source === Track.Source.Microphone
  );
  const trackRef = localMicTrack
    ? { participant: localParticipant, publication: localMicTrack, source: Track.Source.Microphone }
    : undefined;
  const { segments: rawSegments } = useTrackTranscription(trackRef);

  // Debug logging — check browser console to see how segments stream in
  useEffect(() => {
    console.log(
      "[Transcription] rawSegments update:",
      rawSegments.map((s) => ({
        id: s.id,
        final: s.final,
        text: s.text.substring(0, 80),
      }))
    );
    // Clear the data-channel partial when a new final segment arrives
    const lastSeg = rawSegments[rawSegments.length - 1];
    if (lastSeg?.final) {
      clearPartial();
    }
  }, [rawSegments, clearPartial]);

  const endEncounter = useCallback(() => {
    localParticipant.setMicrophoneEnabled(false);
    setPhase("review");
  }, [localParticipant]);

  const isRecording = phase === "recording";

  return (
    <div className="flex flex-col h-screen">
      {/* ── Header ────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/60">
        <div className="flex items-center gap-3">
          {isRecording ? (
            <>
              <div className="recording-dot" />
              <span className="text-sm font-medium text-red-400 uppercase tracking-wider">
                Recording
              </span>
            </>
          ) : (
            <>
              <div className="w-3 h-3 rounded-full bg-amber-500 shrink-0" />
              <span className="text-sm font-medium text-amber-400 uppercase tracking-wider">
                Review
              </span>
            </>
          )}
        </div>
        <h1 className="text-lg font-semibold">Medical Scribe</h1>
        <div className="flex items-center gap-2 text-zinc-400 text-sm font-mono">
          <ClockIcon />
          {timer}
        </div>
      </header>

      {/* ── Main content: transcript + SOAP note ─────── */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Transcript panel */}
        <div className="flex-1 flex flex-col border-b lg:border-b-0 lg:border-r border-zinc-800/60 min-h-0">
          <div className="px-6 py-3 border-b border-zinc-800/40">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              {isRecording ? "Live Transcript" : "Encounter Transcript"}
            </h2>
          </div>
          <TranscriptPanel rawSegments={rawSegments} partialTranscript={partialTranscript} />
        </div>

        {/* SOAP note panel */}
        <div className="flex-1 flex flex-col min-h-0 lg:max-w-[50%]">
          <div className="px-6 py-3 border-b border-zinc-800/40 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wider">
              SOAP Note
            </h2>
            {!isRecording && (
              <button
                onClick={requestSoapNote}
                disabled={!!status || !!soapNote}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-xs font-medium rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                {status || (soapNote ? "Generated" : "Generate")}
              </button>
            )}
          </div>
          <SoapNotePanel soapNote={soapNote} status={status} phase={phase} requestSoapNote={requestSoapNote} />
        </div>
      </div>

      {/* ── Footer controls ──────────────────────────── */}
      <footer className="flex items-center justify-center gap-4 px-6 py-4 border-t border-zinc-800/60">
        {isRecording ? (
          <button
            onClick={endEncounter}
            className="px-6 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-full font-medium transition-colors cursor-pointer text-sm"
          >
            End Encounter
          </button>
        ) : (
          <DisconnectButton className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-full font-medium transition-colors cursor-pointer text-sm">
            Close Session
          </DisconnectButton>
        )}
      </footer>
    </div>
  );
}

/* ================================================================
   Transcript panel — shows raw STT segments
   ================================================================ */

interface Segment {
  text: string;
  firstReceivedTime: number;
  id: string;
  final: boolean;
}

function TranscriptPanel({ rawSegments, partialTranscript }: { rawSegments: Segment[]; partialTranscript: string | null }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const sorted = [...rawSegments]
      .filter((s) => s.text.trim())
      .sort((a, b) => a.firstReceivedTime - b.firstReceivedTime);

    const result: Segment[] = [];
    let pendingInterims: Segment[] = [];

    for (const seg of sorted) {
      if (seg.final) {
        // Final segment replaces any preceding interim segments
        pendingInterims = [];
        result.push(seg);
      } else {
        pendingInterims.push(seg);
      }
    }

    // Keep any trailing interims (currently streaming)
    result.push(...pendingInterims);
    return result;
  }, [rawSegments]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-sm">
          <div className="waveform mx-auto mb-6 justify-center">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="waveform-bar"
                style={{
                  height: `${12 + Math.sin(i * 1.2) * 10}px`,
                  animationDelay: `${i * 0.1}s`,
                }}
              />
            ))}
          </div>
          <h3 className="text-zinc-300 text-sm font-semibold mb-3 text-center">
            Ambient Scribe Active
          </h3>
          <p className="text-zinc-500 text-sm leading-relaxed text-center mb-4">
            This scribe is listening to the clinical encounter and transcribing
            in real time. Speak naturally — it captures everything automatically.
          </p>
          <div className="space-y-2 text-xs text-zinc-600">
            <div className="flex items-start gap-2">
              <span className="text-emerald-500 mt-0.5">1.</span>
              <span>Conversation is transcribed live as you speak</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-emerald-500 mt-0.5">2.</span>
              <span>Click <strong className="text-zinc-400">End Encounter</strong> when finished</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-emerald-500 mt-0.5">3.</span>
              <span>Generate a structured SOAP note from the transcript</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-3 scrollbar-thin"
    >
      {entries.map((seg) => {
        const time = new Date(seg.firstReceivedTime);
        const timestamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}:${String(time.getSeconds()).padStart(2, "0")}`;
        return (
          <div key={seg.id} className="flex gap-3">
            <span className="text-zinc-600 text-xs font-mono mt-0.5 shrink-0 w-14">
              {timestamp}
            </span>
            <p className={`text-sm leading-relaxed flex-1 ${seg.final ? "text-zinc-200" : "text-zinc-400 italic"}`}>
              {seg.text.trim()}
              {!seg.final && <span className="text-zinc-600 text-xs ml-2">(partial)</span>}
            </p>
          </div>
        );
      })}
      {/* Show live partial transcript from data channel */}
      {partialTranscript && (
        <div className="flex gap-3 opacity-60">
          <span className="text-zinc-600 text-xs font-mono mt-0.5 shrink-0 w-14">
            ...
          </span>
          <p className="text-sm text-emerald-400/70 leading-relaxed flex-1 italic">
            {partialTranscript}
            <span className="inline-block w-1.5 h-4 bg-emerald-400/50 ml-0.5 animate-pulse align-middle" />
          </p>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   SOAP note panel
   ================================================================ */

function SoapNotePanel({
  soapNote,
  status,
  phase,
  requestSoapNote,
}: {
  soapNote: string | null;
  status: string | null;
  phase: "recording" | "review";
  requestSoapNote: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  if (status && !soapNote) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent mb-3" />
          <p className="text-zinc-400 text-sm">{status}</p>
        </div>
      </div>
    );
  }

  if (!soapNote) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="text-center max-w-xs">
          <NoteIcon />
          {phase === "review" ? (
            <>
              <p className="text-zinc-400 text-sm mt-3">
                Encounter ended. Ready to generate your SOAP note.
              </p>
              <button
                onClick={requestSoapNote}
                className="mt-4 px-8 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-full transition-colors cursor-pointer"
              >
                Generate SOAP Note
              </button>
            </>
          ) : (
            <>
              <p className="text-zinc-500 text-sm mt-3">
                SOAP note will be generated from the encounter transcript
              </p>
              <p className="text-zinc-600 text-xs mt-1">
                End the encounter first, then generate
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-6 py-4 scrollbar-thin"
    >
      <div className="soap-section prose prose-sm prose-invert max-w-none">
        <div className="soap-content text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
          {soapNote}
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   Small UI components
   ================================================================ */

function ClockIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg className="w-10 h-10 text-zinc-600 mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}
