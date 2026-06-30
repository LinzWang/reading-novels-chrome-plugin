import { MESSAGE_TYPES, type ExtensionMessage, type PreloadNextPageResultMessage } from '../shared/messages';
import { DEFAULT_READER_SETTINGS, type PageModel, type ReaderSettings } from '../shared/page-model';
import { extractReadablePage } from './extract-readable-page';
import { ReaderOverlay } from './reader-overlay';

let overlay: ReaderOverlay | undefined;
let currentSettings: ReaderSettings = DEFAULT_READER_SETTINGS;
const visitedUrls = new Set<string>();

// 检查阅读模式已经打开
function isReaderOpen(): boolean {
  return !!overlay && document.getElementById('edge-reading-mode-tts-root');
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.OPEN_READER) {
    // 如果阅读模式已经打开，点击扩展图标就是关闭它
    if (isReaderOpen()) {
      closeReader();
      sendResponse({ ok: true, closed: true });
      return true;
    }
    void openReader().then(
      () => sendResponse({ ok: true }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
    return true;
  }

  if (message?.type === MESSAGE_TYPES.TOGGLE_PLAY_PAUSE && overlay) {
    // 这个命令由overlay处理
    overlay.togglePlayPause();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.STOP_SPEAKING && overlay) {
    overlay.stopSpeaking();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function openReader(): Promise<void> {
  currentSettings = await loadSettings();
  // 每次打开重新开始，清空已访问集合
  visitedUrls.clear();
  // 对于动态渲染的页面，等待一小会让内容渲染完成
  // 如果第一次提取到的内容为空，重试几次
  const currentUrl = location.href;
  let page = extractReadablePage(document, { url: currentUrl, visitedUrls });
  let retries = 3;

  while (page.textSegments.length <= 1 && retries > 0) {
    // 如果只有标题没有正文，等待一下再试
    await new Promise(resolve => setTimeout(resolve, 200));
    page = extractReadablePage(document, { url: currentUrl, visitedUrls });
    retries--;
  }

  visitedUrls.add(page.url);

  overlay?.destroy();
  overlay = new ReaderOverlay(page, currentSettings, {
    onClose: (currentUrl) => {
      // 关闭时更新浏览器地址到当前阅读的页面
      if (currentUrl !== location.href) {
        history.pushState(null, document.title, currentUrl);
      }
      closeReader();
    },
    onPreloadNext: preloadNextPage,
    onSettingsChange: (settings) => {
      currentSettings = settings;
      void saveSettings(settings);
    }
  });
  overlay.mount();
}

function closeReader(): void {
  visitedUrls.clear();
  if (overlay) {
    overlay.destroy();
    overlay = undefined;
  }
}

async function preloadNextPage(url: string): Promise<PageModel> {
  const result = await chrome.runtime.sendMessage<ExtensionMessage, PreloadNextPageResultMessage>({
    type: MESSAGE_TYPES.PRELOAD_NEXT_PAGE,
    url
  });

  if (!result?.ok || !result.html) {
    throw new Error(result?.error || '未知错误');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(result.html, 'text/html');
  const finalUrl = result.finalUrl || url;
  // 预加载时不把 url 加入 visitedUrls，因为预加载只是缓存，还没真正访问
  // 如果提前加入，真正加载页面时检测下一页会过滤掉已访问的，导致失效
  const page = extractReadablePage(doc, { url: finalUrl, visitedUrls });
  return page;
}

async function loadSettings(): Promise<ReaderSettings> {
  const stored = await chrome.storage.local.get('readerSettings');
  return { ...DEFAULT_READER_SETTINGS, ...(stored.readerSettings as Partial<ReaderSettings> | undefined) };
}

async function saveSettings(settings: ReaderSettings): Promise<void> {
  await chrome.storage.local.set({ readerSettings: settings });
}
