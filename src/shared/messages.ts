import type { ReaderSettings } from './page-model';

export const MESSAGE_TYPES = {
  OPEN_READER: 'OPEN_READER',
  PRELOAD_NEXT_PAGE: 'PRELOAD_NEXT_PAGE',
  PRELOAD_NEXT_PAGE_RESULT: 'PRELOAD_NEXT_PAGE_RESULT',
  LOAD_SETTINGS: 'LOAD_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  TOGGLE_PLAY_PAUSE: 'TOGGLE_PLAY_PAUSE',
  STOP_SPEAKING: 'STOP_SPEAKING'
} as const;

export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export interface OpenReaderMessage {
  type: typeof MESSAGE_TYPES.OPEN_READER;
}

export interface PreloadNextPageMessage {
  type: typeof MESSAGE_TYPES.PRELOAD_NEXT_PAGE;
  url: string;
}

export interface PreloadNextPageResultMessage {
  type: typeof MESSAGE_TYPES.PRELOAD_NEXT_PAGE_RESULT;
  ok: boolean;
  url: string;
  finalUrl?: string;
  html?: string;
  error?: string;
}

export interface LoadSettingsMessage {
  type: typeof MESSAGE_TYPES.LOAD_SETTINGS;
}

export interface SaveSettingsMessage {
  type: typeof MESSAGE_TYPES.SAVE_SETTINGS;
  settings: Partial<ReaderSettings>;
}

export interface TogglePlayPauseMessage {
  type: typeof MESSAGE_TYPES.TOGGLE_PLAY_PAUSE;
}

export interface StopSpeakingMessage {
  type: typeof MESSAGE_TYPES.STOP_SPEAKING;
}

export type ExtensionMessage =
  | OpenReaderMessage
  | PreloadNextPageMessage
  | PreloadNextPageResultMessage
  | LoadSettingsMessage
  | SaveSettingsMessage
  | TogglePlayPauseMessage
  | StopSpeakingMessage;
