const annotateButton = document.getElementById('annotate-h1');

annotateButton?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const heading = document.querySelector('h1');
      if (!heading) {
        return;
      }

      heading.style.setProperty('font-size', '150px', 'important');
      heading.style.setProperty('font-weight', '800', 'important');
      heading.style.setProperty('color', 'red', 'important');
      heading.setAttribute('tool', 'page heading');
    }
  });
});
