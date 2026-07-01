import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeechController } from '../../src/content/speech-controller';
import { DEFAULT_READER_SETTINGS, type TextSegment } from '../../src/shared/page-model';

class FakeSpeechSynthesisUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  volume = 1;
  voice?: SpeechSynthesisVoice;
  lang = '';
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null;
  onend: ((event: SpeechSynthesisEvent) => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

interface FakeSpeechSynthesis extends Partial<SpeechSynthesis> {
  speak: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  getVoices: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  speaking: boolean;
  pending: boolean;
  paused: boolean;
  isPaused: ReturnType<typeof vi.fn>;
  lastUtterance?: FakeSpeechSynthesisUtterance;
  listeners: Map<string, Set<EventListenerOrEventListenerObject>>;
}

const segment: TextSegment = {
  id: 'seg-0',
  text: '这是一段用于测试朗读恢复的文字。',
  kind: 'paragraph'
};

const matchingVoice = {
  voiceURI: 'voice-zh',
  name: 'Chinese Voice',
  lang: 'zh-CN',
  localService: true,
  default: false
} as SpeechSynthesisVoice;

let originalSpeechSynthesis: SpeechSynthesis | undefined;
let originalSpeechSynthesisUtterance: typeof SpeechSynthesisUtterance | undefined;
let originalAudioContext: (typeof AudioContext) | undefined;
let speech: FakeSpeechSynthesis;

beforeEach(() => {
  vi.useFakeTimers();
  originalSpeechSynthesis = globalThis.speechSynthesis;
  originalSpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;
  originalAudioContext = window.AudioContext;

  speech = createSpeechSynthesisMock();
  Object.defineProperty(globalThis, 'speechSynthesis', {
    configurable: true,
    value: speech
  });
  Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
    configurable: true,
    value: FakeSpeechSynthesisUtterance
  });
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    value: FakeAudioContext
  });
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  restoreGlobal('speechSynthesis', originalSpeechSynthesis);
  restoreGlobal('SpeechSynthesisUtterance', originalSpeechSynthesisUtterance);
  restoreWindow('AudioContext', originalAudioContext);
});

describe('SpeechController recoverable errors', () => {
  it('retries synthesis-failed before reporting an error', () => {
    const onError = vi.fn();
    const controller = createController({ onError });

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    expect(speech.speak).toHaveBeenCalledTimes(1);

    fireSpeechError('synthesis-failed');
    expect(onError).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('speaking');

    vi.advanceTimersByTime(300);
    expect(speech.speak).toHaveBeenCalledTimes(2);

    controller.dispose();
  });

  it('reports synthesis-failed after the retry limit is exhausted', () => {
    const onError = vi.fn();
    const controller = createController({ onError });

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);

    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(300);
    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(600);
    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(900);
    fireSpeechError('synthesis-failed');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('朗读失败：synthesis-failed');
    expect(controller.getState()).toBe('idle');
    expect(speech.speak).toHaveBeenCalledTimes(4);

    controller.dispose();
  });

  it('keeps canceled and interrupted as non-fatal cancellation signals', () => {
    const onError = vi.fn();
    const controller = createController({ onError });

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    fireSpeechError('interrupted');
    vi.advanceTimersByTime(1000);

    expect(onError).not.toHaveBeenCalled();
    expect(controller.getState()).toBe('speaking');
    expect(speech.speak).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('reports non-recoverable errors immediately', () => {
    const onError = vi.fn();
    const controller = createController({ onError });

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    fireSpeechError('not-allowed');

    expect(onError).toHaveBeenCalledWith('朗读失败：not-allowed');
    expect(controller.getState()).toBe('idle');
    expect(speech.speak).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('reuses the configured voice when retrying', () => {
    const controller = createController();
    speech.getVoices.mockReturnValue([matchingVoice]);
    controller.setSettings({ ...DEFAULT_READER_SETTINGS, voiceURI: matchingVoice.voiceURI });

    controller.speakFrom(0);
    expect(speech.lastUtterance?.voice).toBe(matchingVoice);
    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(300);

    expect(speech.speak).toHaveBeenCalledTimes(2);
    expect(speech.lastUtterance?.voice).toBe(matchingVoice);
    expect(speech.lastUtterance?.lang).toBe(matchingVoice.lang);

    controller.dispose();
  });

  it('keeps the retry budget during repeated failures on the same segment', () => {
    const onError = vi.fn();
    const controller = createController({ onError });

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(300);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);

    fireSpeechError('synthesis-failed');
    vi.advanceTimersByTime(600);

    expect(onError).not.toHaveBeenCalled();
    expect(speech.speak).toHaveBeenCalledTimes(3);

    controller.dispose();
  });
});

describe('SpeechController lifecycle recovery', () => {
  it('recovers from the current index when a visible page has dropped speech', () => {
    const controller = createController();

    controller.speakFrom(0);
    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    speech.lastUtterance?.onend?.({} as SpeechSynthesisEvent);
    expect(controller.getCurrentIndex()).toBe(1);
    expect(speech.speak).toHaveBeenCalledTimes(2);

    speech.lastUtterance?.onstart?.({} as SpeechSynthesisEvent);
    speech.speaking = false;
    speech.pending = false;
    document.dispatchEvent(new Event('visibilitychange'));

    expect(controller.getCurrentIndex()).toBe(1);
    expect(speech.speak).toHaveBeenCalledTimes(3);
    expect(speech.lastUtterance?.text).toBe('第二段继续朗读。');

    controller.dispose();
  });

  it('cleans up listeners and timers after dispose', () => {
    const controller = createController();

    controller.speakFrom(0);
    controller.dispose();
    const callsAfterDispose = speech.speak.mock.calls.length;

    speech.speaking = false;
    speech.pending = false;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1600);

    expect(speech.speak).toHaveBeenCalledTimes(callsAfterDispose);
  });
});

function createController(callbacks = {}): SpeechController {
  const controller = new SpeechController(callbacks);
  controller.setSegments([segment, { id: 'seg-1', text: '第二段继续朗读。', kind: 'paragraph' }]);
  return controller;
}

function createSpeechSynthesisMock(): FakeSpeechSynthesis {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const mock: FakeSpeechSynthesis = {
    speaking: false,
    pending: false,
    paused: false,
    listeners,
    speak: vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
      mock.lastUtterance = utterance;
      mock.speaking = true;
      mock.pending = false;
    }),
    cancel: vi.fn(() => {
      mock.speaking = false;
      mock.pending = false;
    }),
    pause: vi.fn(() => {
      mock.paused = true;
    }),
    resume: vi.fn(() => {
      mock.paused = false;
    }),
    isPaused: vi.fn(() => mock.paused),
    getVoices: vi.fn(() => []),
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(type)?.delete(listener);
    })
  };
  return mock;
}

class FakeAudioContext {
  state: AudioContextState = 'running';
  destination = {};

  createGain(): GainNode {
    return { gain: { value: 1 }, connect: vi.fn() } as unknown as GainNode;
  }

  createOscillator(): OscillatorNode {
    return {
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn()
    } as unknown as OscillatorNode;
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

function fireSpeechError(error: string): void {
  speech.lastUtterance?.onerror?.({ error } as SpeechSynthesisErrorEvent);
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
}

function restoreGlobal<T extends keyof typeof globalThis>(name: T, value: (typeof globalThis)[T] | undefined): void {
  if (value === undefined) {
    delete (globalThis as Record<string, unknown>)[name];
    return;
  }
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

function restoreWindow(name: string, value: unknown): void {
  if (value === undefined) {
    delete (window as unknown as Record<string, unknown>)[name];
    return;
  }
  Object.defineProperty(window, name, { configurable: true, value });
}
