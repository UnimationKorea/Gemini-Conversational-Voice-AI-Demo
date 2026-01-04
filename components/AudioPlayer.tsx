
import React, { useState, useRef, useEffect } from 'react';
import { decodeAudioData } from '../utils/audioUtils';

interface AudioPlayerProps {
  pcmData: Uint8Array;
  sampleRate: number;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ pcmData, sampleRate }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackOffset, setPlaybackOffset] = useState(0);
  const [duration, setDuration] = useState(0);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const startTimeRef = useRef<number>(0);

  useEffect(() => {
    return () => {
      sourceNodeRef.current?.stop();
    };
  }, []);

  const initAudio = async () => {
    if (!audioBufferRef.current) {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate });
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
      }
      audioBufferRef.current = await decodeAudioData(pcmData, audioContextRef.current, sampleRate, 1);
      setDuration(audioBufferRef.current.duration);
    }
  };

  const handlePlay = async () => {
    await initAudio();
    if (!audioContextRef.current || !audioBufferRef.current) return;
    if (audioContextRef.current.state === 'suspended') await audioContextRef.current.resume();

    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBufferRef.current;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      if (isPlaying) {
        const elapsed = audioContextRef.current!.currentTime - startTimeRef.current;
        const newOffset = playbackOffset + elapsed;
        if (newOffset >= audioBufferRef.current!.duration - 0.05) {
            setIsPlaying(false);
            setPlaybackOffset(0);
        }
      }
    };

    const startAt = playbackOffset;
    source.start(0, startAt);
    startTimeRef.current = audioContextRef.current.currentTime;
    sourceNodeRef.current = source;
    setIsPlaying(true);
  };

  const handlePause = () => {
    if (sourceNodeRef.current && isPlaying) {
      sourceNodeRef.current.stop();
      const elapsed = audioContextRef.current!.currentTime - startTimeRef.current;
      setPlaybackOffset(prev => Math.min(prev + elapsed, duration));
      setIsPlaying(false);
    }
  };

  const handleReplay = async () => {
    sourceNodeRef.current?.stop();
    setPlaybackOffset(0);
    setIsPlaying(false);
    setTimeout(async () => {
      await handlePlay();
    }, 10);
  };

  return (
    <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-700/50">
      {!isPlaying ? (
        <button 
          onClick={handlePlay}
          className="p-2 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors text-blue-400 shadow-sm"
          title="재생"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
      ) : (
        <button 
          onClick={handlePause}
          className="p-2 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors text-yellow-400 shadow-sm"
          title="일시정지"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
          </svg>
        </button>
      )}
      <button 
        onClick={handleReplay}
        className="p-2 rounded-full bg-gray-700 hover:bg-gray-600 transition-colors text-purple-400 shadow-sm"
        title="다시듣기"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
      <div className="h-1 bg-gray-700 flex-1 rounded-full overflow-hidden">
        <div 
            className="h-full bg-blue-500 transition-all duration-100" 
            style={{ width: `${duration ? (playbackOffset / duration) * 100 : 0}%` }}
        />
      </div>
    </div>
  );
};

export default AudioPlayer;
