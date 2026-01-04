
export interface TranscriptEntry {
  speaker: 'user' | 'model';
  text: string;
  mode: 'streaming' | 'batch';
  pcmData?: Uint8Array;
  timestamp: number;
}

export interface VoicePersona {
  description: string;
  analyzedAt: number;
}
