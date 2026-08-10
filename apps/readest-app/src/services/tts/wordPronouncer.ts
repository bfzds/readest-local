import { AppService } from '@/types/system';
import { genSSMLRaw } from '@/utils/ssml';
import { TTSClient } from './TTSClient';
import { NativeTTSClient } from './NativeTTSClient';
import { WebSpeechClient } from './WebSpeechClient';

// Speaks a single dictionary word as fast as possible using the platform
// speech engine: Web Speech on desktop/web, native TTS on mobile. Unlike
// the reader's TTSController, this never spins up a full speaking session.

export type PronounceStatus = 'playing' | 'ended' | 'error';

export interface PronounceWordOptions {
  appService?: AppService | null;
}

// Bumped on every new request so a slower in-flight synthesis can detect
// it has been superseded and bail before touching the client.
let requestToken = 0;
let fallbackAbort: AbortController | null = null;
let fallbackClient: TTSClient | null = null;

const stopFallback = (): void => {
  fallbackAbort?.abort();
  fallbackAbort = null;
  const client = fallbackClient;
  fallbackClient = null;
  if (client) void client.shutdown().catch(() => {});
};

export const cancelWordPronounce = (): void => {
  requestToken++;
  stopFallback();
};

const speakViaFallback = async (
  word: string,
  lang: string,
  options: PronounceWordOptions,
  token: number,
  emit: (status: PronounceStatus) => void,
): Promise<void> => {
  // Web Speech is the reader's built-in engine on desktop/web; on the mobile
  // app the native TTS plugin is what actually produces audio.
  const client: TTSClient = options.appService?.isMobile
    ? new NativeTTSClient()
    : new WebSpeechClient();
  fallbackClient = client;
  const controller = new AbortController();
  fallbackAbort = controller;
  try {
    const ready = await client.init();
    if (!ready || token !== requestToken) {
      emit('error');
      return;
    }
    client.setPrimaryLang(lang);
    emit('playing');
    for await (const ev of client.speak(genSSMLRaw(word), controller.signal)) {
      if (ev.code === 'error') {
        emit('error');
        return;
      }
    }
    emit('ended');
  } catch {
    emit('error');
  } finally {
    if (fallbackClient === client) fallbackClient = null;
    if (fallbackAbort === controller) fallbackAbort = null;
    void client.shutdown().catch(() => {});
  }
};

export const pronounceWord = async (
  word: string,
  lang: string | undefined,
  options: PronounceWordOptions,
  onStatus?: (status: PronounceStatus) => void,
): Promise<void> => {
  const token = ++requestToken;
  const emit = (status: PronounceStatus) => {
    if (token === requestToken) onStatus?.(status);
  };

  const trimmed = word.trim();
  if (!trimmed) {
    emit('ended');
    return;
  }
  const voiceLang = lang && lang.length ? lang : 'en';

  // Stop whatever is currently playing.
  stopFallback();

  if (token !== requestToken) return;
  await speakViaFallback(trimmed, voiceLang, options, token, emit);
};
