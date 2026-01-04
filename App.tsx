
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveSession, LiveServerMessage, Modality } from '@google/genai';
import { type TranscriptEntry, type VoicePersona } from './types';
import { decode, encode, decodeAudioData, createBlob } from './utils/audioUtils';
import { MicrophoneIcon, StopIcon, InfoIcon, LoadingIcon, SettingsIcon, TrashIcon, DnaIcon } from './components/icons';
import PricingModal from './components/PricingModal';
import AudioPlayer from './components/AudioPlayer';
import PersonaModal from './components/PersonaModal';

type InputMode = 'streaming' | 'batch';
type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';

const API_KEY = process.env.API_KEY;
const AVAILABLE_VOICES: VoiceName[] = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
const STORAGE_KEY = 'gemini_voice_history';
const PERSONA_KEY = 'gemini_voice_persona';

function mergeUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}

const App: React.FC = () => {
    const [inputMode, setInputMode] = useState<InputMode>('streaming');
    const [selectedVoice, setSelectedVoice] = useState<VoiceName>('Zephyr');
    const [voicePersona, setVoicePersona] = useState<VoicePersona | null>(() => {
        const saved = localStorage.getItem(PERSONA_KEY);
        return saved ? JSON.parse(saved) : null;
    });
    
    const [isSessionActive, setIsSessionActive] = useState<boolean>(false);
    const [isProcessing, setIsProcessing] = useState<boolean>(false);
    const [isRecording, setIsRecording] = useState<boolean>(false);
    const [status, setStatus] = useState<string>('Ready to chat');
    const [transcripts, setTranscripts] = useState<TranscriptEntry[]>(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try { return JSON.parse(saved); } catch (e) { return []; }
        }
        return [];
    });
    
    const [isPricingModalOpen, setIsPricingModalOpen] = useState<boolean>(false);
    const [isPersonaModalOpen, setIsPersonaModalOpen] = useState<boolean>(false);

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const recordedChunksRef = useRef<Float32Array[]>([]);
    const currentModelAudioChunksRef = useRef<Uint8Array[]>([]);
    const currentInputTranscriptionRef = useRef<string>('');
    const currentOutputTranscriptionRef = useRef<string>('');
    const nextStartTimeRef = useRef<number>(0);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const transcriptEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(transcripts));
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcripts]);

    useEffect(() => {
        if (voicePersona) {
            localStorage.setItem(PERSONA_KEY, JSON.stringify(voicePersona));
        }
    }, [voicePersona]);

    const stopAudioPlayback = () => {
        if (outputAudioContextRef.current) {
            audioSourcesRef.current.forEach(source => {
                try { source.stop(); } catch(e) {}
            });
            audioSourcesRef.current.clear();
            nextStartTimeRef.current = 0;
        }
    };

    const clearHistory = () => {
        if (window.confirm('Clear conversation history?')) setTranscripts([]);
    };

    const handleOnMessage = useCallback(async (message: LiveServerMessage) => {
        if (message.serverContent?.outputTranscription) {
            const text = message.serverContent.outputTranscription.text;
            currentOutputTranscriptionRef.current += text;
            setTranscripts(prev => {
                const last = prev[prev.length - 1];
                if (last && last.speaker === 'model' && last.mode === 'streaming') {
                    return [...prev.slice(0, -1), { ...last, text: currentOutputTranscriptionRef.current }];
                }
                return [...prev, { speaker: 'model', text: currentOutputTranscriptionRef.current, mode: 'streaming', timestamp: Date.now() }];
            });
        } else if (message.serverContent?.inputTranscription) {
            const text = message.serverContent.inputTranscription.text;
            currentInputTranscriptionRef.current += text;
            setTranscripts(prev => {
                const last = prev[prev.length - 1];
                if (last && last.speaker === 'user' && last.mode === 'streaming') {
                    return [...prev.slice(0, -1), { ...last, text: currentInputTranscriptionRef.current }];
                }
                return [...prev, { speaker: 'user', text: currentInputTranscriptionRef.current, mode: 'streaming', timestamp: Date.now() }];
            });
        }

        if (message.serverContent?.turnComplete) {
            if (currentModelAudioChunksRef.current.length > 0) {
                const fullPcm = mergeUint8Arrays(currentModelAudioChunksRef.current);
                setTranscripts(prev => {
                    const lastModelIndex = prev.map(t => t.speaker).lastIndexOf('model');
                    if (lastModelIndex !== -1) {
                        const newTranscripts = [...prev];
                        newTranscripts[lastModelIndex] = { ...newTranscripts[lastModelIndex], pcmData: fullPcm };
                        return newTranscripts;
                    }
                    return prev;
                });
                currentModelAudioChunksRef.current = [];
            }
            currentInputTranscriptionRef.current = '';
            currentOutputTranscriptionRef.current = '';
        }

        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
        if (base64Audio && outputAudioContextRef.current) {
            const decoded = decode(base64Audio);
            currentModelAudioChunksRef.current.push(decoded);
            const audioContext = outputAudioContextRef.current;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContext.currentTime);
            const audioBuffer = await decodeAudioData(decoded, audioContext, 24000, 1);
            const source = audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContext.destination);
            source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
            source.start(nextStartTimeRef.current);
            nextStartTimeRef.current += audioBuffer.duration;
            audioSourcesRef.current.add(source);
        }

        if (message.serverContent?.interrupted) {
            stopAudioPlayback();
            currentModelAudioChunksRef.current = [];
        }
    }, []);

    const startStreaming = async () => {
        if (!API_KEY) return;
        setIsProcessing(true);
        setStatus('Connecting live...');
        currentModelAudioChunksRef.current = [];
        
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            
            const ai = new GoogleGenAI({ apiKey: API_KEY });
            const personaPrompt = voicePersona ? `Adopt the following verbal persona characteristics analyzed from the user's voice: ${voicePersona.description}. Match their energy, speed, and emotional tone.` : "Be a helpful assistant.";

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        if (!inputAudioContextRef.current || !mediaStreamRef.current) return;
                        mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                        scriptProcessorRef.current.onaudioprocess = (e) => {
                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            sessionPromiseRef.current?.then(s => s.sendRealtimeInput({ media: pcmBlob }));
                        };
                        mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
                        setIsProcessing(false);
                        setIsSessionActive(true);
                        setStatus('Live Streaming Active');
                    },
                    onmessage: handleOnMessage,
                    onerror: (e) => { console.error(e); stopAll(); },
                    onclose: () => { setIsSessionActive(false); setStatus('Session closed'); },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    outputAudioTranscription: {},
                    inputAudioTranscription: {},
                    systemInstruction: `You are in streaming mode. ${personaPrompt}. Interruption is allowed.`,
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
                },
            });
        } catch (error) {
            console.error(error);
            setStatus('Mic access failed');
            setIsProcessing(false);
        }
    };

    const startBatchRecording = async () => {
        setIsRecording(true);
        setStatus('Recording chunk...');
        recordedChunksRef.current = [];
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(stream);
            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (e) => recordedChunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
        } catch (e) {
            console.error(e);
            setIsRecording(false);
        }
    };

    const stopAndSendBatch = async () => {
        setIsRecording(false);
        setIsProcessing(true);
        setStatus('Processing chunk...');
        scriptProcessorRef.current?.disconnect();
        mediaStreamSourceRef.current?.disconnect();
        mediaStreamRef.current?.getTracks().forEach(t => t.stop());
        const totalLength = recordedChunksRef.current.reduce((acc, chunk) => acc + chunk.length, 0);
        const flattened = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of recordedChunksRef.current) {
            flattened.set(chunk, offset);
            offset += chunk.length;
        }
        const pcmBlob = createBlob(flattened);
        
        try {
            const ai = new GoogleGenAI({ apiKey: API_KEY! });
            const personaPrompt = voicePersona ? `Adopt the following verbal persona characteristics analyzed from the user's voice: ${voicePersona.description}.` : "";
            
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: [
                    {
                        parts: [
                            { text: `${personaPrompt} Respond naturally to the user's request.` },
                            { inlineData: { data: pcmBlob.data, mimeType: pcmBlob.mimeType } }
                        ]
                    }
                ]
            });

            const textResponse = response.text || "No response generated.";
            if (!outputAudioContextRef.current) outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            
            const ttsResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: textResponse }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } },
                },
            });

            const base64Audio = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            let finalPcm: Uint8Array | undefined;
            if (base64Audio) {
                finalPcm = decode(base64Audio);
                const audioBuffer = await decodeAudioData(finalPcm, outputAudioContextRef.current, 24000, 1);
                const source = outputAudioContextRef.current.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputAudioContextRef.current.destination);
                source.start();
            }

            setTranscripts(prev => [
                ...prev, 
                { speaker: 'user', text: '[Audio Chunk Sent]', mode: 'batch', timestamp: Date.now() },
                { speaker: 'model', text: textResponse, mode: 'batch', pcmData: finalPcm, timestamp: Date.now() }
            ]);
            setStatus('Chunk processed');
        } catch (error) {
            console.error(error);
            setStatus('Error processing');
        } finally {
            setIsProcessing(false);
        }
    };

    const stopAll = useCallback(async () => {
        setIsProcessing(true);
        stopAudioPlayback();
        if (sessionPromiseRef.current) try { (await sessionPromiseRef.current).close(); } catch(e) {}
        scriptProcessorRef.current?.disconnect();
        mediaStreamSourceRef.current?.disconnect();
        mediaStreamRef.current?.getTracks().forEach(t => t.stop());
        setIsSessionActive(false);
        setIsRecording(false);
        setIsProcessing(false);
        setStatus('Ready');
    }, []);

    const handleAction = () => {
        if (inputMode === 'streaming') isSessionActive ? stopAll() : startStreaming();
        else isRecording ? stopAndSendBatch() : startBatchRecording();
    };

    const handlePersonaGenerated = (description: string) => {
        setVoicePersona({ description, analyzedAt: Date.now() });
        setStatus("Voice Persona Cloned Successfully!");
    };

    return (
        <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-sans selection:bg-blue-500/30">
            <header className="flex items-center justify-between p-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur-md sticky top-0 z-20">
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    <h1 className="text-xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-500 hidden md:block">
                        Gemini Voice Lab
                    </h1>
                    <h1 className="text-lg font-bold md:hidden">Gemini Lab</h1>
                </div>
                <div className="flex items-center gap-3">
                    <button 
                        onClick={() => setIsPersonaModalOpen(true)}
                        className={`p-2 rounded-lg border transition-all flex items-center gap-2 ${voicePersona ? 'bg-purple-500/10 border-purple-500/50 text-purple-400' : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white'}`}
                        title="Voice Persona DNA"
                    >
                        <DnaIcon />
                        <span className="text-[10px] font-bold uppercase tracking-widest hidden sm:inline">
                            {voicePersona ? 'DNA Active' : 'Clone Persona'}
                        </span>
                    </button>

                    <div className="hidden sm:flex items-center gap-2 bg-gray-800/50 border border-gray-700 px-3 py-1.5 rounded-lg shadow-inner">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">Timbre</span>
                        <select 
                            value={selectedVoice} 
                            onChange={(e) => setSelectedVoice(e.target.value as VoiceName)}
                            className="bg-transparent text-sm font-medium focus:outline-none cursor-pointer hover:text-blue-400 transition-colors appearance-none pr-1"
                        >
                            {AVAILABLE_VOICES.map(v => <option key={v} value={v} className="bg-gray-800 text-white">{v}</option>)}
                        </select>
                    </div>
                    
                    <button onClick={clearHistory} className="p-2 rounded-full hover:bg-red-500/20 transition-all text-gray-400 hover:text-red-400"><TrashIcon /></button>
                    <button onClick={() => setIsPricingModalOpen(true)} className="p-2 rounded-full hover:bg-gray-800 transition-all text-gray-400 hover:text-white"><InfoIcon /></button>
                </div>
            </header>

            <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 max-w-4xl mx-auto w-full scroll-smooth">
                {voicePersona && (
                    <div className="bg-purple-900/20 border border-purple-500/30 rounded-2xl p-4 flex items-start gap-4 animate-in fade-in zoom-in duration-500">
                        <div className="p-2 bg-purple-500/20 rounded-lg text-purple-400"><DnaIcon /></div>
                        <div>
                            <p className="text-[10px] font-bold text-purple-400 uppercase tracking-widest mb-1">Active Verbal Identity</p>
                            <p className="text-xs text-purple-200/70 italic leading-relaxed">"{voicePersona.description}"</p>
                        </div>
                    </div>
                )}

                <section className="bg-gray-800/30 rounded-2xl p-6 border border-gray-700/50 backdrop-blur-sm">
                    <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
                        <SettingsIcon /> Feasibility Explorer
                    </h2>
                    <p className="text-gray-400 text-sm leading-relaxed">
                        Gemini allows "cloning" of a verbal personality. By analyzing your speech DNA, the model adapts its cadence to match yours, even when using prebuilt timbres.
                    </p>
                </section>

                <div className="flex flex-col gap-6 pb-24">
                    {transcripts.length === 0 && (
                        <div className="text-center py-20 text-gray-500 italic flex flex-col items-center gap-4">
                            <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center opacity-30"><MicrophoneIcon /></div>
                            <p>Laboratory idle. Initiate session below.</p>
                        </div>
                    )}
                    {transcripts.map((entry, index) => (
                        <div key={index} className={`flex flex-col ${entry.speaker === 'user' ? 'items-end' : 'items-start'} group`}>
                            <div className="flex items-center gap-2 mb-1 px-1">
                                <span className="text-[10px] font-bold uppercase tracking-widest opacity-40">{entry.speaker === 'user' ? 'Input' : 'AI Output'} • {entry.mode}</span>
                                <span className="text-[10px] opacity-0 group-hover:opacity-30 transition-opacity">
                                    {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                            </div>
                            <div className={`max-w-[85%] p-4 rounded-2xl shadow-lg transition-all ${
                                entry.speaker === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-gray-800 text-gray-200 border border-gray-700 rounded-tl-none'
                            }`}>
                                <p className="text-sm md:text-base leading-relaxed whitespace-pre-wrap">{entry.text}</p>
                                {entry.speaker === 'model' && entry.pcmData && <AudioPlayer pcmData={entry.pcmData} sampleRate={24000} />}
                            </div>
                        </div>
                    ))}
                    <div ref={transcriptEndRef} />
                </div>
            </main>

            <footer className="p-6 bg-gray-900 border-t border-gray-800 flex flex-col items-center gap-6 z-10 shadow-[0_-10px_30px_rgba(0,0,0,0.5)]">
                <div className="flex items-center bg-gray-800 p-1 rounded-full border border-gray-700 w-full max-w-xs shadow-inner">
                    <button onClick={() => { stopAll(); setInputMode('streaming'); }} className={`flex-1 py-1.5 px-3 rounded-full text-xs font-bold transition-all ${inputMode === 'streaming' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}>Streaming</button>
                    <button onClick={() => { stopAll(); setInputMode('batch'); }} className={`flex-1 py-1.5 px-3 rounded-full text-xs font-bold transition-all ${inputMode === 'batch' ? 'bg-purple-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}>Batch</button>
                </div>

                <div className="flex flex-col items-center gap-3 w-full">
                    <p className={`text-xs font-medium transition-all ${isSessionActive || isRecording ? 'text-blue-400' : 'text-gray-500'}`}>{status}</p>
                    <button
                        onClick={handleAction}
                        disabled={isProcessing}
                        className={`group relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 transform hover:scale-105 active:scale-95 focus:outline-none focus:ring-4 ${
                            isSessionActive || isRecording ? 'bg-red-500/10 border-4 border-red-500 shadow-[0_0_30px_rgba(239,68,68,0.3)]' :
                            inputMode === 'streaming' ? 'bg-blue-600 hover:bg-blue-500 shadow-[0_0_20px_rgba(37,99,235,0.4)]' :
                            'bg-purple-600 hover:bg-purple-500 shadow-[0_0_20px_rgba(147,51,234,0.4)]'
                        } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                        {isProcessing ? <LoadingIcon /> : (isSessionActive || isRecording ? <StopIcon /> : <MicrophoneIcon />)}
                        {(isSessionActive || isRecording) && <span className="absolute inset-0 rounded-full border-4 border-red-500 animate-ping opacity-40" />}
                    </button>
                    <p className="text-[10px] text-gray-600 uppercase tracking-widest font-bold">
                        {inputMode === 'streaming' ? `Live DNA: ${selectedVoice}` : `Push-to-Talk (${selectedVoice})`}
                    </p>
                </div>
            </footer>

            <PricingModal isOpen={isPricingModalOpen} onClose={() => setIsPricingModalOpen(false)} />
            <PersonaModal 
                isOpen={isPersonaModalOpen} 
                onClose={() => setIsPersonaModalOpen(false)} 
                onPersonaGenerated={handlePersonaGenerated} 
            />
        </div>
    );
};

export default App;
