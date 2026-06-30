import { MESSAGE_TYPES, type ExtensionMessage, type PreloadNextPageMessage, type SaveSettingsMessage } from '../shared/messages';

chrome.action.onClicked.addListener((tab) => {
  void openReaderInTab(tab).catch((error) => {
    console.error('Failed to open reader mode:', error);
  });
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  // Direct async, keep service worker alive until complete
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  switch (command) {
    case '_execute_action':
      // Handled by chrome.action.onClicked, but for global shortcut we need to handle it
      await openReaderInTab(tab);
      break;
    case 'toggle_play_pause':
      // Try send message, retry once with longer wait if fails (service worker wakeup race)
      await sendMessageWithRetry(tab.id, { type: MESSAGE_TYPES.TOGGLE_PLAY_PAUSE });
      break;
    case 'stop_speaking':
      await sendMessageWithRetry(tab.id, { type: MESSAGE_TYPES.STOP_SPEAKING });
      break;
  }
});

/**
 * Send message to tab with retry, for global shortcut when service worker just woke up
 * Note: chrome.tabs.sendMessage will throw if content script doesn't respond, even if msg was received
 * So we catch and ignore, message is probably delivered
 */
async function sendMessageWithRetry(tabId: number, message: any): Promise<void> {
  // First attempt
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // First failed, wait longer for port connection to be ready (service worker just woke up)
    await new Promise(resolve => setTimeout(resolve, 200));
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
      // Even if it fails, the message might still have been delivered
      // Chrome throws error when there's no response from listener, doesn't mean sending failed
      console.debug('Failed to get response from content script, message might still be delivered');
    }
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  if (message.type === MESSAGE_TYPES.PRELOAD_NEXT_PAGE) {
    void preloadNextPage(message).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE_TYPES.SAVE_SETTINGS) {
    void saveSettings(message).then(sendResponse);
    return true;
  }

  if (message.type === MESSAGE_TYPES.LOAD_SETTINGS) {
    void chrome.storage.local.get('readerSettings').then((result) => sendResponse(result.readerSettings ?? {}));
    return true;
  }

  return false;
});

async function openReaderInTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!tab.id) {
    throw new Error('No active tab id.');
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.OPEN_READER });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.OPEN_READER });
  }
}

async function preloadNextPage(message: PreloadNextPageMessage) {
  try {
    const response = await fetch(message.url, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    return {
      type: MESSAGE_TYPES.PRELOAD_NEXT_PAGE_RESULT,
      ok: true,
      url: message.url,
      finalUrl: response.url,
      html
    };
  } catch (error) {
    return {
      type: MESSAGE_TYPES.PRELOAD_NEXT_PAGE_RESULT,
      ok: false,
      url: message.url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function saveSettings(message: SaveSettingsMessage) {
  const existing = await chrome.storage.local.get('readerSettings');
  await chrome.storage.local.set({
    readerSettings: {
      ...(existing.readerSettings ?? {}),
      ...message.settings
    }
  });
  return { ok: true };
}
