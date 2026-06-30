export interface TextSegment {
  id: string;
  text: string;
  /** 朗读文本，用于多音字修正，如果为空则用 text */
  speechText?: string;
  kind: 'title' | 'heading' | 'paragraph' | 'sentence' | 'list-item' | 'blockquote';
}

export interface PageModel {
  url: string;
  title: string;
  byline?: string;
  lang?: string;
  excerpt?: string;
  contentHtml: string;
  textSegments: TextSegment[];
  nextUrl?: string;
}

export interface ReaderSettings {
  autoReadNext: boolean;
  fontScale: number;
  theme: 'light' | 'sepia' | 'dark';
  rate: number;
  pitch: number;
  volume: number;
  voiceURI?: string;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  autoReadNext: true,
  fontScale: 1,
  theme: 'sepia',
  rate: 1,
  pitch: 1,
  volume: 1
};
