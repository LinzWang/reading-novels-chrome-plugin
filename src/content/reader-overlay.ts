import type { PageModel, ReaderSettings, TextSegment } from '../shared/page-model';
import { DEFAULT_READER_SETTINGS } from '../shared/page-model';
import { READER_CSS } from '../styles/reader-styles';
import { SpeechController, type SpeechState } from './speech-controller';

export interface ReaderOverlayCallbacks {
  onClose: (currentUrl: string) => void;
  onPreloadNext: (url: string) => Promise<PageModel>;
  onSettingsChange: (settings: ReaderSettings) => void;
}

type PreloadState =
  | { status: 'idle' }
  | { status: 'loading'; url: string; promise: Promise<PageModel> }
  | { status: 'ready'; page: PageModel }
  | { status: 'error'; url: string; error: string };

export class ReaderOverlay {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private page: PageModel;
  private settings: ReaderSettings;
  private preloadState: PreloadState = { status: 'idle' };
  private visitedUrls = new Set<string>();
  private speech: SpeechController;
  private statusElement?: HTMLElement;
  private contentElement?: HTMLElement;
  private voiceSelect?: HTMLSelectElement;
  private languageSelect?: HTMLSelectElement;
  private rateInput?: HTMLInputElement;
  private fontInput?: HTMLInputElement;
  private themeSelect?: HTMLSelectElement;
  private autoNextCheckbox?: HTMLInputElement;
  private settingsPanel?: HTMLElement;
  private pauseButton?: HTMLButtonElement;
  // 当前选中的语言代码
  private currentLang: string;
  private settingsOpen = false;
  // 保存原页面滚动状态，关闭时恢复
  private originalOverflow: string = '';

  constructor(page: PageModel, settings: ReaderSettings, private readonly callbacks: ReaderOverlayCallbacks) {
    this.page = page;
    this.settings = { ...DEFAULT_READER_SETTINGS, ...settings };
    // 初始化语言：浏览器语言 > 页面语言 > 默认中文
    this.currentLang = navigator.language?.toLowerCase().slice(0, 2) || page.lang?.toLowerCase().slice(0, 2) || 'zh';
    this.host = document.createElement('div');
    this.host.id = 'edge-reading-mode-tts-root';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.speech = new SpeechController({
      onSegmentStart: (segment) => this.highlightSegment(segment),
      onStateChange: (state) => this.updateSpeechState(state),
      onPageEnd: () => void this.handlePageEnd(),
      onError: (error) => this.setStatus(error, true)
    });
    this.speech.setSettings(this.settings);
    this.speech.setSegments(page.textSegments);
    this.visitedUrls.add(page.url);
  }

  mount(): void {
    // 保存原页面滚动条状态，隐藏原滚动条
    this.originalOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    document.documentElement.append(this.host);
    this.render();
    void this.populateLanguages();
    void this.populateVoices();
    this.preloadNextIfNeeded();
    document.addEventListener('keydown', this.handleKeyDown.bind(this));

    // 监听语音列表变化：当浏览器重新加载语音（如屏保恢复、后台挂起后）刷新下拉框
    // Windows Edge 在系统屏保后会重置 speechSynthesis 语音列表，需要重新填充
    if ('speechSynthesis' in globalThis) {
      speechSynthesis.addEventListener('voiceschanged', () => {
        void this.populateLanguages();
        void this.populateVoices();
      });
    }
  }

  destroy(): void {
    this.speech.stop();
    this.host.remove();
    // 恢复原页面滚动条
    document.documentElement.style.overflow = this.originalOverflow;
    document.body.style.overflow = this.originalOverflow;
  }

  private render(): void {
    this.shadow.innerHTML = `
      <style>${READER_CSS}</style>
      <div class="reader-shell" data-theme="${this.settings.theme}" style="--reader-font-scale:${this.settings.fontScale}">
        <div class="reader-toolbar">
          <div class="toolbar-left">
            <button class="primary" data-action="start">开始朗读</button>
            <button data-action="pause">暂停</button>
            <button data-action="stop">停止</button>
            <button data-action="close">关闭</button>
          </div>
          <div class="toolbar-right">
            <button data-action="settings">⚙ 设置</button>
          </div>
        </div>
        <div class="reader-settings-panel ${this.settingsOpen ? 'open' : ''}" data-role="settings-panel">
          <div class="settings-content">
            <div class="settings-header">
              <span>设置</span>
              <button data-action="close-settings" class="close-btn">✕</button>
            </div>
            <div class="settings-body">
              <label>语言
                <select data-role="language"></select>
              </label>
              <label>语音
                <select data-role="voice"></select>
              </label>
              <label>语速 ${this.settings.rate.toFixed(1)}
                <input data-role="rate" type="range" min="0.5" max="2" step="0.1" value="${this.settings.rate}">
              </label>
              <label>字号 ${this.settings.fontScale.toFixed(1)}x
                <input data-role="font" type="range" min="0.8" max="1.6" step="0.1" value="${this.settings.fontScale}">
              </label>
              <label>主题
                <select data-role="theme">
                  <option value="light">浅色</option>
                  <option value="sepia">护眼</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <label class="checkbox-label">
                <input data-role="auto-next" type="checkbox" ${this.settings.autoReadNext ? 'checked' : ''}>
                <span>自动下一页</span>
              </label>
            </div>
          </div>
        </div>
        <main class="reader-container">
          <h1 class="reader-title"></h1>
          <p class="reader-meta"></p>
          <p class="reader-status"></p>
          <article class="reader-content"></article>
        </main>
      </div>
    `;

    this.statusElement = this.shadow.querySelector('.reader-status') ?? undefined;
    this.contentElement = this.shadow.querySelector('.reader-content') ?? undefined;
    this.settingsPanel = this.shadow.querySelector<HTMLElement>('[data-role="settings-panel"]') ?? undefined;
    this.languageSelect = this.shadow.querySelector<HTMLSelectElement>('[data-role="language"]') ?? undefined;
    this.voiceSelect = this.shadow.querySelector<HTMLSelectElement>('[data-role="voice"]') ?? undefined;
    this.rateInput = this.shadow.querySelector<HTMLInputElement>('[data-role="rate"]') ?? undefined;
    this.fontInput = this.shadow.querySelector<HTMLInputElement>('[data-role="font"]') ?? undefined;
    this.themeSelect = this.shadow.querySelector<HTMLSelectElement>('[data-role="theme"]') ?? undefined;
    this.autoNextCheckbox = this.shadow.querySelector<HTMLInputElement>('[data-role="auto-next"]') ?? undefined;
    this.pauseButton = this.shadow.querySelector<HTMLButtonElement>('[data-action="pause"]') ?? undefined;
    const title = this.shadow.querySelector<HTMLElement>('.reader-title');
    const meta = this.shadow.querySelector<HTMLElement>('.reader-meta');

    if (title) title.textContent = this.page.title;
    if (meta) meta.textContent = `${this.page.byline ? `${this.page.byline} · ` : ''}${this.page.url}`;
    if (this.themeSelect) this.themeSelect.value = this.settings.theme;
    if (this.contentElement) this.contentElement.innerHTML = this.page.contentHtml;

    this.bindEvents();
    this.updateNextStatus();
  }

  private bindEvents(): void {
    this.shadow.querySelector('[data-action="start"]')?.addEventListener('click', () => this.speech.speakFrom(0));
    this.shadow.querySelector('[data-action="pause"]')?.addEventListener('click', () => {
      if (this.speech.getState() === 'paused') this.speech.resume();
      else this.speech.pause();
    });
    this.shadow.querySelector('[data-action="stop"]')?.addEventListener('click', () => this.speech.stop());
    this.shadow.querySelector('[data-action="settings"]')?.addEventListener('click', () => this.toggleSettingsPanel());
    this.shadow.querySelector('[data-action="close-settings"]')?.addEventListener('click', () => this.toggleSettingsPanel());
    this.shadow.querySelector('[data-action="close"]')?.addEventListener('click', () => this.callbacks.onClose(this.page.url));
    this.settingsPanel?.addEventListener('click', (e) => {
      if (e.target === this.settingsPanel) {
        this.toggleSettingsPanel();
      }
    });
    this.contentElement?.addEventListener('click', (event) => {
      // 检查是否有用户选中的文本，如果有只朗读选中的文本
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim();
      if (selectedText && selectedText.length > 10) {
        // 有较长选中文本，只朗读选中内容
        const utterance = new SpeechSynthesisUtterance(selectedText);
        utterance.rate = this.settings.rate;
        utterance.pitch = this.settings.pitch;
        utterance.volume = this.settings.volume;
        const voice = speechSynthesis.getVoices().find((item) => item.voiceURI === this.settings.voiceURI);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        }
        this.speech.stop();
        speechSynthesis.speak(utterance);
        // 清除选择，方便下次操作
        selection?.removeAllRanges();
        return;
      }

      // 没有选中文本，点击段落从该段开始朗读
      const segmentId = this.resolveClickToSegment(event);
      if (!segmentId) return;
      const index = this.page.textSegments.findIndex((segment) => segment.id === segmentId);
      if (index >= 0) this.speech.speakFrom(index);
    });

    this.languageSelect?.addEventListener('change', () => {
      this.currentLang = this.languageSelect?.value || 'all';
      void this.populateVoices();
    });

    this.voiceSelect?.addEventListener('change', () => {
      this.updateSettings({ voiceURI: this.voiceSelect?.value || undefined });
    });

    this.rateInput?.addEventListener('input', (event) => {
      const value = Number((event.target as HTMLInputElement).value);
      this.updateSettings({ rate: value });
      // 更新显示的数值
      if (this.rateInput && this.rateInput.parentElement && this.rateInput.parentElement.firstChild) {
        (this.rateInput.parentElement.firstChild as Text).textContent = `语速 ${value.toFixed(1)} `;
      }
    });

    this.fontInput?.addEventListener('input', (event) => {
      const fontScale = Number((event.target as HTMLInputElement).value);
      this.updateSettings({ fontScale });
      // 更新显示的数值
      if (this.fontInput && this.fontInput.parentElement && this.fontInput.parentElement.firstChild) {
        (this.fontInput.parentElement.firstChild as Text).textContent = `字号 ${fontScale.toFixed(1)}x `;
      }
      this.shadow.querySelector<HTMLElement>('.reader-shell')?.style.setProperty('--reader-font-scale', String(fontScale));
    });

    this.themeSelect?.addEventListener('change', (event) => {
      const theme = (event.target as HTMLSelectElement).value as ReaderSettings['theme'];
      this.updateSettings({ theme });
      this.shadow.querySelector<HTMLElement>('.reader-shell')?.setAttribute('data-theme', theme);
    });

    this.autoNextCheckbox?.addEventListener('change', (event) => {
      this.updateSettings({ autoReadNext: (event.target as HTMLInputElement).checked });
      this.preloadNextIfNeeded();
      this.updateNextStatus();
    });
  }

  private toggleSettingsPanel(): void {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsPanel) {
      this.settingsPanel.classList.toggle('open', this.settingsOpen);
    }
  }

  private async populateLanguages(): Promise<void> {
    const voices = await this.speech.getVoices();
    if (!this.languageSelect) return;

    // 收集所有可用语言
    const languages = new Map<string, string>(); // lang code -> display name
    voices.forEach(voice => {
      const langCode = voice.lang.toLowerCase().slice(0, 2);
      const fullLang = voice.lang;
      // 使用语言代码映射到显示名称
      const displayNames: Record<string, string> = {
        'zh': '中文',
        'en': 'English',
        'ja': '日本語',
        'ko': '한국어',
        'es': 'Español',
        'fr': 'Français',
        'de': 'Deutsch',
        'it': 'Italiano',
        'pt': 'Português',
        'ru': 'Русский',
        'ar': 'العربية',
        'hi': 'हिन्दी'
      };
      const displayName = displayNames[langCode] || fullLang;
      if (!languages.has(langCode)) {
        languages.set(langCode, displayName);
      }
    });

    // 添加"全部"选项
    this.languageSelect.innerHTML = '';
    this.languageSelect.innerHTML += `<option value="all">全部</option>`;

    // 添加各语言选项，按名称排序
    Array.from(languages.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([code, name]) => {
        const option = document.createElement('option');
        option.value = code;
        option.textContent = name;
        option.selected = code === this.currentLang;
        this.languageSelect?.append(option);
      });

    if (languages.size === 0) {
      this.languageSelect.innerHTML = `<option value="all">全部</option>`;
    }
  }

  private async populateVoices(): Promise<void> {
    const voices = await this.speech.getVoices();
    if (!this.voiceSelect) return;

    const targetLang = this.currentLang;

    // 过滤语音
    let filteredVoices = targetLang === 'all'
      ? voices // 显示全部
      : voices.filter(voice =>
          voice.lang.toLowerCase().startsWith(targetLang)
        );

    // 如果过滤后为空，显示全部
    if (filteredVoices.length === 0) {
      filteredVoices = voices;
    }

    // 按语言相关性排序，匹配的在前
    if (targetLang !== 'all') {
      filteredVoices = filteredVoices.sort((a, b) => {
        const aMatch = a.lang.toLowerCase().startsWith(targetLang) ? 0 : 1;
        const bMatch = b.lang.toLowerCase().startsWith(targetLang) ? 0 : 1;
        return aMatch - bMatch;
      });
    }

    this.voiceSelect.innerHTML = '<option value="">默认语音</option>';
    for (const voice of filteredVoices) {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      option.selected = voice.voiceURI === this.settings.voiceURI;
      this.voiceSelect.append(option);
    }
  }

  private updateSettings(partial: Partial<ReaderSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.speech.setSettings(this.settings);
    this.callbacks.onSettingsChange(this.settings);
  }

  private resolveClickToSegment(event: Event): string | undefined {
    const target = event.target as Element | null;
    return target?.closest<HTMLElement>('[data-segment-id]')?.dataset.segmentId;
  }

  private highlightSegment(segment: TextSegment): void {
    this.shadow.querySelectorAll('.reader-segment.is-active').forEach((element) => element.classList.remove('is-active'));
    const element = this.shadow.querySelector<HTMLElement>(`[data-segment-id="${CSS.escape(segment.id)}"]`);
    if (!element) return;
    element.classList.add('is-active');
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private updateSpeechState(state: SpeechState): void {
    if (this.pauseButton) this.pauseButton.textContent = state === 'paused' ? '继续' : '暂停';
  }

  private preloadNextIfNeeded(): void {
    if (!this.settings.autoReadNext || !this.page.nextUrl || this.preloadState.status === 'loading' || this.preloadState.status === 'ready') {
      return;
    }

    const url = this.page.nextUrl;
    const promise = this.callbacks.onPreloadNext(url);
    this.preloadState = { status: 'loading', url, promise };
    this.updateNextStatus();
    promise
      .then((page) => {
        this.preloadState = { status: 'ready', page };
        this.updateNextStatus();
      })
      .catch((error: unknown) => {
        this.preloadState = { status: 'error', url, error: error instanceof Error ? error.message : String(error) };
        this.updateNextStatus();
      });
  }

  private async handlePageEnd(): Promise<void> {
    if (!this.settings.autoReadNext || !this.page.nextUrl) {
      this.setStatus('本页朗读完成。');
      return;
    }

    if (this.preloadState.status === 'ready') {
      this.loadPage(this.preloadState.page, true);
      return;
    }

    if (this.preloadState.status === 'loading') {
      this.setStatus('本页朗读完成，正在等待下一页加载...', false);
      try {
        const page = await this.preloadState.promise;
        this.loadPage(page, true);
      } catch (error) {
        this.setStatus(`下一页加载失败：${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  }

  private loadPage(page: PageModel, autoSpeak: boolean): void {
    this.page = page;
    // 添加 URL 时保持原样，detectNextPage 会在复制时 normalize
    this.visitedUrls.add(page.url);
    this.preloadState = { status: 'idle' };
    this.speech.setSegments(page.textSegments);
    this.render();
    void this.populateLanguages();
    void this.populateVoices();
    this.preloadNextIfNeeded();
    if (autoSpeak) {
      window.setTimeout(() => this.speech.speakFrom(0), 0);
    }
  }

  private updateNextStatus(): void {
    if (!this.page.nextUrl) {
      this.setStatus('未检测到下一页。');
      return;
    }

    if (!this.settings.autoReadNext) {
      this.setStatus(`已检测到下一页：${this.page.nextUrl}。自动下一页已关闭。`);
      return;
    }

    if (this.preloadState.status === 'loading') {
      this.setStatus(`正在预加载下一页：${this.preloadState.url}`, false, true);
      return;
    }

    if (this.preloadState.status === 'ready') {
      this.setStatus(`下一页已预加载：${this.preloadState.page.title}`);
      return;
    }

    if (this.preloadState.status === 'error') {
      this.setStatus(`下一页预加载失败：${this.preloadState.error}`, true);
      return;
    }

    this.setStatus(`已检测到下一页：${this.page.nextUrl}`);
  }

  private setStatus(message: string, isError = false, isLoading = false): void {
    if (!this.statusElement) return;
    this.statusElement.textContent = message;
    this.statusElement.classList.toggle('reader-error', isError);
    this.statusElement.classList.toggle('reader-loading', isLoading);
  }

  /** 公共方法：快捷键切换播放/暂停 */
  togglePlayPause(): void {
    if (this.speech.getState() === 'speaking') {
      this.speech.pause();
    } else if (this.speech.getState() === 'paused') {
      this.speech.resume();
    } else {
      this.speech.speakFrom(0);
    }
  }

  /** 公共方法：快捷键停止朗读 */
  stopSpeaking(): void {
    this.speech.stop();
  }

  /** 处理键盘快捷键 */
  private handleKeyDown(event: KeyboardEvent): void {
    // Escape 关闭阅读器
    if (event.key === 'Escape') {
      this.callbacks.onClose(this.page.url);
      return;
    }
    // Space 切换播放/暂停
    if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // 如果焦点在滑块/下拉框，不拦截空格
      const target = event.target as HTMLElement;
      if (target.tagName !== 'SELECT' && target.tagName !== 'INPUT') {
        event.preventDefault();
        this.togglePlayPause();
      }
      return;
    }
  }
}
