
import React, { useState, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { createBlob } from '../utils/audioUtils';
import { LoadingIcon, MicrophoneIcon, StopIcon } from './icons';

interface PersonaModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPersonaGenerated: (description: string) => void;
}

const PersonaModal: React.FC<PersonaModalProps> = ({ isOpen, onClose, onPersonaGenerated }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [countdown, setCountdown] = useState(5);
  
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<ScriptProcessorNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const timerRef = useRef<number | null>(null);

  if (!isOpen) return null;

  const startRecording = async () => {
    chunksRef.current = [];
    setCountdown(5);
    setIsRecording(true);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      
      processor.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      
      source.connect(processor);
      processor.connect(audioCtx.destination);
      recorderRef.current = processor;

      timerRef.current = window.setInterval(() => {
        setCountdown(prev => {
          if (prev <= 1) {
            stopAndAnalyze();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

    } catch (err) {
      console.error(err);
      setIsRecording(false);
    }
  };

  const stopAndAnalyze = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    setIsAnalyzing(true);

    // Stop recording
    recorderRef.current?.disconnect();
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());

    // Flatten
    const totalLength = chunksRef.current.reduce((acc, c) => acc + c.length, 0);
    const flattened = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      flattened.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = createBlob(flattened);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            parts: [
              { text: "Analyze this user's voice recording. Describe their tone, speaking speed, energy level, and any unique verbal traits in 2 sentences. This will be used to clone their 'verbal personality'." },
              { inlineData: { data: blob.data, mimeType: blob.mimeType } }
            ]
          }
        ]
      });

      onPersonaGenerated(response.text || "Friendly and clear speaker.");
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-[60] p-4">
      <div className="bg-gray-800 border border-gray-700 rounded-3xl w-full max-w-md p-8 shadow-2xl overflow-hidden relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500" />
        
        <h2 className="text-2xl font-bold text-center mb-2">Voice Persona Lab</h2>
        <p className="text-gray-400 text-sm text-center mb-8">
          Record 5 seconds of speech to clone your verbal style into the AI.
        </p>

        <div className="flex flex-col items-center justify-center gap-6">
          <div className={`w-32 h-32 rounded-full border-4 flex items-center justify-center relative transition-all duration-500 ${
            isRecording ? 'border-red-500 scale-110 shadow-[0_0_40px_rgba(239,68,68,0.4)]' : 'border-blue-500/30'
          }`}>
            {isRecording ? (
              <span className="text-4xl font-black text-red-500 animate-pulse">{countdown}s</span>
            ) : isAnalyzing ? (
              <div className="animate-spin text-blue-400"><LoadingIcon /></div>
            ) : (
              <div className="text-blue-500/50"><MicrophoneIcon /></div>
            )}
            
            {isRecording && (
                <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-ping opacity-20" />
            )}
          </div>

          {!isRecording && !isAnalyzing ? (
            <button 
              onClick={startRecording}
              className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 px-8 rounded-full transition-all shadow-lg hover:shadow-blue-500/20"
            >
              Start Recording DNA
            </button>
          ) : (
            <p className="text-blue-400 font-mono tracking-widest text-xs uppercase animate-pulse">
              {isAnalyzing ? "Sequencing Speech Patterns..." : "Capturing Audio DNA..."}
            </p>
          )}

          <button 
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm mt-4 underline underline-offset-4"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default PersonaModal;
