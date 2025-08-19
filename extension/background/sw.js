console.log('[TwinMind SW] Service worker started');

// Open the side panel when the toolbar icon is clicked
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel/index.html',
      enabled: true,
    });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.error('Failed to open side panel:', e);
  }
});

// Basic message bridge used by the sidepanel "PING"
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PING') {
    sendResponse({ ok: true, ts: Date.now() });
    return;
  }
  if (msg?.type === 'START_REQUEST') console.log('[TwinMind SW] START requested');
  if (msg?.type === 'PAUSE_REQUEST') console.log('[TwinMind SW] PAUSE requested');
  if (msg?.type === 'RESUME_REQUEST') console.log('[TwinMind SW] RESUME requested');
  if (msg?.type === 'STOP_REQUEST') console.log('[TwinMind SW] STOP requested');
});
