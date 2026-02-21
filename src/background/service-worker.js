// Agentic Autofill - Background Service Worker

// Forward messages for legacy fill-form / enable-selection (if content/content.js used)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "enable-selection" && sender.url?.startsWith("chrome-extension://")) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "enable-selection" });
        sendResponse({ sent: true });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true;
  }
  if (message.target === "panel" && message.type === "form-extracted") {
    chrome.storage.session.set({ lastExtractedForm: message.fields });
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ received: true });
    return true;
  }
  if (message.type === "fill-form") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, message);
        sendResponse({ sent: true });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true; // Keep channel open for async sendResponse
  }
});
