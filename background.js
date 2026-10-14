// A click on the toolbar icon brings back the reading tab, or opens it.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('app.html');
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});
