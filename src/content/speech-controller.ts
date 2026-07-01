import type { ReaderSettings, TextSegment } from '../shared/page-model';
import { DEFAULT_READER_SETTINGS } from '../shared/page-model';

const MAX_RECOVERABLE_ERROR_RETRIES = 3;
const RECOVERABLE_SPEECH_ERRORS = new Set<string>(['synthesis-failed', 'audio-busy', 'audio-hardware', 'network']);

export interface SpeechControllerCallbacks {
  onSegmentStart?: (segment: TextSegment, index: number) => void;
  onStateChange?: (state: SpeechState) => void;
  onPageEnd?: () => void;
  onError?: (error: string) => void;
}

export type SpeechState = 'idle' | 'speaking' | 'paused';

/**
 * 用户意图，只受显式操作影响，不受浏览器后台暂停/恢复影响。
 * - 'play'  : 用户希望播放（speakFrom / resume）。保活机制会让它持续播放，对抗浏览器后台暂停。
 * - 'paused': 用户主动暂停，或被其他标签页接管。保活不再干预，等用户手动点继续。
 * - 'idle'  : 停止 / 未开始。
 */
type UserIntent = 'play' | 'paused' | 'idle';

export class SpeechController {
  private segments: TextSegment[] = [];
  private settings: ReaderSettings = DEFAULT_READER_SETTINGS;
  private index = 0;
  private state: SpeechState = 'idle';
  private userIntent: UserIntent = 'idle';
  private runId = 0;
  private currentUtterance?: SpeechSynthesisUtterance;
  private keepAlive?: number;
  private watchdogTimer?: number;
  private retryTimer?: number;
  private retryCount = 0;
  private readonly handleVisibilityRecovery = () => this.recoverIfSpeechDropped();
  private readonly handleLifecycleResume = () => this.recoverIfSpeechDropped();
  // 循环静音音频：浏览器检测到媒体在播放，就不会节流后台标签页的定时器，
  // 也不会暂停后台 speechSynthesis —— 这是让朗读能在切标签/后台时继续的关键。
  private keepAliveAudioCtx?: AudioContext;
  private keepAliveOsc?: OscillatorNode;

  constructor(private readonly callbacks: SpeechControllerCallbacks = {}) {
    // 保活机制：Chrome/Edge 会自动暂停后台标签页的 speechSynthesis。
    // 只要用户意图是 'play'，就持续对抗浏览器的暂停：
    //   - 被浏览器暂停了 (isPaused) → resume() 继续
    //   - 当前段已结束但全局没声音了 → 重新朗读当前 index（覆盖 onend 丢失、后台断流等情况）
    // 用户意图为 'paused'（手动暂停 / 其他标签页接管）时完全不干预，等用户手动点继续。
    this.keepAlive = window.setInterval(() => this.keepAliveTick(), 800);
    document.addEventListener('visibilitychange', this.handleVisibilityRecovery);
    window.addEventListener('resume', this.handleLifecycleResume);
  }

  private keepAliveTick(): void {
    if (this.userIntent !== 'play') return;

    // 被浏览器后台暂停了 → 恢复，继续在后台朗读
    if ('isPaused' in speechSynthesis && (speechSynthesis as any).isPaused()) {
      speechSynthesis.resume();
      return;
    }

    this.recoverIfSpeechDropped();
  }

  private recoverIfSpeechDropped(): void {
    if (this.userIntent !== 'play' || this.retryTimer) return;
    if (!('speechSynthesis' in globalThis)) return;

    // 没在说话也没在排队（onend 丢失、后台被 cancel 断流等）→ 重新朗读当前位置
    // 仅在页面可见时重启：后台不主动 speakFrom，避免和其他标签页抢全局队列
    // 切回本页或 Page Lifecycle resume 后若已断流，从这里从断点继续。
    if (document.visibilityState === 'visible' && !speechSynthesis.speaking && !speechSynthesis.pending) {
      this.speakFrom(this.index);
    }
  }

  setSegments(segments: TextSegment[]): void {
    this.stop();
    this.segments = segments;
    this.index = 0;
  }

  setSettings(settings: ReaderSettings): void {
    this.settings = settings;
  }

  getState(): SpeechState {
    return this.state;
  }

  getCurrentIndex(): number {
    return this.index;
  }

  async getVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!('speechSynthesis' in globalThis)) {
      return [];
    }

    const voices = speechSynthesis.getVoices();
    if (voices.length > 0) {
      return voices;
    }

    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => resolve(speechSynthesis.getVoices()), 800);
      const handler = () => {
        window.clearTimeout(timeout);
        speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(speechSynthesis.getVoices());
      };
      speechSynthesis.addEventListener('voiceschanged', handler);
    });
  }

  speakFrom(index: number): void {
    if (!this.ensureSpeechAvailable()) {
      return;
    }

    if (this.segments.length === 0) {
      this.callbacks.onError?.('没有可朗读的正文内容。');
      return;
    }

    this.clearRetryTimer();
    this.retryCount = 0;
    this.runId += 1;
    this.userIntent = 'play';
    this.startKeepAliveAudio();
    speechSynthesis.cancel();
    this.index = clamp(index, 0, this.segments.length - 1);
    this.speakCurrent(this.runId);
  }

  pause(): void {
    if (this.state !== 'speaking') {
      return;
    }
    this.userIntent = 'paused';
    this.stopKeepAliveAudio();
    speechSynthesis.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') {
      return;
    }
    this.userIntent = 'play';
    this.startKeepAliveAudio();
    // 如果是被其他标签页 cancel 了（全局已不在说话），从保存的位置重新朗读
    if (!speechSynthesis.speaking && !speechSynthesis.pending) {
      this.speakFrom(this.index);
      return;
    }
    speechSynthesis.resume();
    this.setState('speaking');
  }

  stop(): void {
    if ('speechSynthesis' in globalThis) {
      this.runId += 1;
      speechSynthesis.cancel();
      this.clearWatchdog();
    }
    this.clearRetryTimer();
    this.retryCount = 0;
    this.stopKeepAliveAudio();
    this.userIntent = 'idle';
    this.currentUtterance = undefined;
    this.setState('idle');
  }

  dispose(): void {
    this.stop();
    if (this.keepAlive) {
      window.clearInterval(this.keepAlive);
      this.keepAlive = undefined;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityRecovery);
    window.removeEventListener('resume', this.handleLifecycleResume);
  }

  private speakCurrent(runId: number): void {
    if (runId !== this.runId) {
      return;
    }

    const segment = this.segments[this.index];
    if (!segment) {
      this.userIntent = 'idle';
      this.setState('idle');
      this.callbacks.onPageEnd?.();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(segment.speechText ?? segment.text);
    utterance.rate = this.settings.rate;
    utterance.pitch = this.settings.pitch;
    utterance.volume = this.settings.volume;

    // 如果设置了自定义语音但找不到，等待语音列表加载完成后重试
    // Windows Edge 在屏保/后台挂起后会重置语音列表，需要等待重新加载
    let voice = speechSynthesis.getVoices().find((item) => item.voiceURI === this.settings.voiceURI);
    if (!voice && this.settings.voiceURI) {
      // 语音列表可能正在重新加载，等待 voiceschanged 事件
      // 如果 300ms 内没等到事件，直接继续——即使语音不对也比卡住强
      console.debug('[TTS] Voice not found, waiting for voiceschanged...');
      const originalRunId = runId;
      let continued = false;

      const continueWithVoice = () => {
        if (continued) return;
        continued = true;
        voice = speechSynthesis.getVoices().find((item) => item.voiceURI === this.settings.voiceURI);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        if (originalRunId === this.runId) {
          this.speakCurrentContinued(originalRunId, utterance, segment);
        }
      };

      const timeout = window.setTimeout(continueWithVoice, 300);
      const handler = () => {
        window.clearTimeout(timeout);
        speechSynthesis.removeEventListener('voiceschanged', handler);
        continueWithVoice();
      };
      speechSynthesis.addEventListener('voiceschanged', handler);
      return;
    }

    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }

    this.speakCurrentContinued(runId, utterance, segment);
  }

  private speakCurrentContinued(runId: number, utterance: SpeechSynthesisUtterance, segment: TextSegment): void {
    if (runId !== this.runId) {
      return;
    }

    // 估算朗读需要的时间（按每分钟中文约200字计算），加上额外余量作为watchdog超时
    const estimatedMs = Math.max(10000, ((segment.speechText ?? segment.text).length / 200) * 60 * 1000 + 5000);
    this.clearWatchdog();

    // 设置看门狗：如果超过预计时间还没结束，说明可能 onend 事件丢失了，强制跳到下一段
    this.watchdogTimer = window.setTimeout(() => this.watchdogCheck(runId, utterance, segment, estimatedMs), estimatedMs);

    utterance.onstart = () => {
      if (runId !== this.runId) {
        this.clearWatchdog();
        return;
      }
      this.callbacks.onSegmentStart?.(segment, this.index);
      this.setState('speaking');
    };

    utterance.onerror = (event) => {
      if (runId !== this.runId) {
        this.clearWatchdog();
        return;
      }
      this.clearWatchdog();
      this.currentUtterance = undefined;

      // canceled / interrupted：utterance 被取消了。
      // 来源可能是：① 浏览器后台节流 cancel ② 其他标签页开始朗读 cancel ③ 本页重启。
      // 本页重启（speakFrom/stop）会先 runId+1，已在上面 return，不会走到这里。
      // 关键：不转 paused！保持 userIntent='play' 和 state='speaking'，让保活定时器处理：
      //   - 浏览器后台 cancel → 切回本页（visible）时保活 speakFrom(index) 从断点继续
      //   - 其他标签页接管 → 本页 hidden 时保活不 speakFrom，让出全局队列；切回本页再续
      // 这样切标签时按钮保持"暂停"，不会被误判成已暂停。
      if (event.error === 'canceled' || event.error === 'interrupted') {
        return;
      }

      if (this.shouldRetryRecoverableError(event.error)) {
        this.scheduleRecoverableRetry(runId, event.error);
        return;
      }

      // 只有真正的意外错误才报告
      this.callbacks.onError?.(`朗读失败：${event.error}`);
      this.userIntent = 'idle';
      this.setState('idle');
    };

    utterance.onend = () => {
      this.clearWatchdog();
      if (runId !== this.runId) {
        return;
      }
      this.index += 1;
      this.retryCount = 0;
      this.currentUtterance = undefined;
      if (this.index >= this.segments.length) {
        this.userIntent = 'idle';
        this.setState('idle');
        this.callbacks.onPageEnd?.();
        return;
      }
      this.speakCurrent(runId);
    };

    this.currentUtterance = utterance;
    speechSynthesis.speak(utterance);
    // console.log('[TTS] speak called, index', this.index, 'speaking=', speechSynthesis.speaking, 'pending=', speechSynthesis.pending);

    // Chrome 会在页面后台自动暂停，启动后如果发现已被暂停就立即恢复
    if ('isPaused' in speechSynthesis && (speechSynthesis as any).isPaused()) {
      speechSynthesis.resume();
    }
  }

  private watchdogCheck(runId: number, utterance: SpeechSynthesisUtterance, segment: TextSegment, estimatedMs: number): void {
    // 后台页面不强制推进，避免和后台保活打架，等可见时再处理
    if (document.visibilityState !== 'visible') {
      this.watchdogTimer = window.setTimeout(() => this.watchdogCheck(runId, utterance, segment, estimatedMs), estimatedMs);
      return;
    }

    if (this.state !== 'speaking' || runId !== this.runId || this.currentUtterance !== utterance) {
      return;
    }

    if (!speechSynthesis.speaking && !speechSynthesis.pending) {
      // 实际已经完全结束，但是没触发 onend → 手动推进
      console.warn('SpeechSynthesis onend missed - forcing next segment');
      this.clearWatchdog();
      this.index += 1;
      this.retryCount = 0;
      this.currentUtterance = undefined;
      if (this.index >= this.segments.length) {
        this.userIntent = 'idle';
        this.setState('idle');
        this.callbacks.onPageEnd?.();
      } else {
        this.speakCurrent(runId);
      }
    } else if (speechSynthesis.pending && !speechSynthesis.speaking) {
      // 一直在pending排队但是从来没开始 → 卡住了，跳过当前段避免丢失后面内容
      console.warn('SpeechSynthesis stuck in pending - skipping current segment');
      this.clearWatchdog();
      speechSynthesis.cancel();
      this.index += 1;
      this.retryCount = 0;
      this.currentUtterance = undefined;
      if (this.index >= this.segments.length) {
        this.userIntent = 'idle';
        this.setState('idle');
        this.callbacks.onPageEnd?.();
      } else {
        this.speakCurrent(runId);
      }
    } else if (speechSynthesis.speaking) {
      // 还在正常朗读，再给一次超时等待
      this.watchdogTimer = window.setTimeout(() => this.watchdogCheck(runId, utterance, segment, estimatedMs), estimatedMs);
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private shouldRetryRecoverableError(error: string): boolean {
    return RECOVERABLE_SPEECH_ERRORS.has(error) && this.retryCount < MAX_RECOVERABLE_ERROR_RETRIES;
  }

  private scheduleRecoverableRetry(runId: number, error: string): void {
    this.retryCount += 1;
    const retryDelayMs = this.retryCount * 300;
    console.warn(`[TTS] Recoverable speech error "${error}", retrying ${this.retryCount}/${MAX_RECOVERABLE_ERROR_RETRIES}`);
    this.clearRetryTimer();
    if ('speechSynthesis' in globalThis) {
      speechSynthesis.cancel();
    }
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (runId !== this.runId || this.userIntent !== 'play') {
        return;
      }
      this.speakCurrent(runId);
    }, retryDelayMs);
  }

  /**
   * 启动一个静音的 Web Audio 振荡器。浏览器一旦检测到有音频在播放，就不会节流该标签页的
   * 定时器，也不会暂停后台 speechSynthesis —— 从而让保活 resume() 在后台也能及时执行，
   * 朗读得以在切换标签/最小化时继续。振荡器振幅设为 0，完全静音。
   * 必须在用户手势上下文中创建 AudioContext（speakFrom/resume 均由用户点击触发）。
   */
  private startKeepAliveAudio(): void {
    try {
      if (!this.keepAliveAudioCtx) {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        const gain = ctx.createGain();
        gain.gain.value = 0; // 完全静音
        const osc = ctx.createOscillator();
        osc.frequency.value = 1; // 极低频，配合 gain=0 无声
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        this.keepAliveAudioCtx = ctx;
        this.keepAliveOsc = osc;
      }
      const ctx = this.keepAliveAudioCtx;
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch((e) => console.warn('[TTS] audio ctx resume failed:', e));
      }
    } catch (e) {
      console.warn('[TTS] keep-alive audio error:', e);
    }
  }

  private stopKeepAliveAudio(): void {
    try {
      if (this.keepAliveOsc) {
        this.keepAliveOsc.stop();
        this.keepAliveOsc = undefined;
      }
      if (this.keepAliveAudioCtx) {
        this.keepAliveAudioCtx.close();
        this.keepAliveAudioCtx = undefined;
      }
    } catch (e) {
      console.warn('[TTS] keep-alive audio stop error:', e);
    }
  }

  private ensureSpeechAvailable(): boolean {
    if (!('speechSynthesis' in globalThis) || !('SpeechSynthesisUtterance' in globalThis)) {
      this.callbacks.onError?.('当前浏览器不支持 Web Speech API，无法朗读。');
      return false;
    }
    return true;
  }

  private setState(state: SpeechState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
