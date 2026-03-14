chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const el = document.getElementById('ds-wa-panel');
        if (el) {
          el.classList.toggle('ds-hidden');
          if (!el.classList.contains('ds-hidden')) {
            document.dispatchEvent(new CustomEvent('ds-wa-boot'));
          }
        } else {
          document.dispatchEvent(new CustomEvent('ds-wa-boot'));
        }
      }
    });
  } catch (e) {}
});
