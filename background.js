/**
 * @fileoverview Background service worker for screenshot capture.
 * @description Captures the visible tab, crops the selected wrapper region with device-pixel-aware bounds, and returns base64 image data to the content script.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureWrapperScreenshot') {
    handleCaptureScreenshot(request, sender)
      .then(sendResponse)
      .catch(err => sendResponse({ action: 'wrapperScreenshotError', error: err.message }));
    return true; 
  }
});



async function handleCaptureScreenshot(request, sender) {
  const { tabId, rect } = request;
  const resolvedTabId = tabId || sender?.tab?.id;

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Wrapper has zero or invalid dimensions.');
  }

  
  if (!resolvedTabId) {
    throw new Error('No tab id available for screenshot capture.');
  }

  const tab = await chrome.tabs.get(resolvedTabId);
  if (!tab) {
    throw new Error('Tab not found.');
  }

  
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    if (err.message && err.message.includes('MAX_CAPTURE_VISIBLE_TAB')) {
      throw new Error('Screenshot quota exceeded. Please wait a moment and try again.');
    }
    throw new Error(`Failed to capture tab: ${err.message}`);
  }

  
  const dpr = rect.devicePixelRatio || 1;

  
  const cropX = Math.round(rect.x * dpr);
  const cropY = Math.round(rect.y * dpr);
  const cropW = Math.round(rect.width * dpr);
  const cropH = Math.round(rect.height * dpr);

  
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  
  const safeX = Math.max(0, Math.min(cropX, imageBitmap.width));
  const safeY = Math.max(0, Math.min(cropY, imageBitmap.height));
  const safeW = Math.min(cropW, imageBitmap.width - safeX);
  const safeH = Math.min(cropH, imageBitmap.height - safeY);

  if (safeW <= 0 || safeH <= 0) {
    imageBitmap.close();
    throw new Error('Wrapper is offscreen or has zero visible area after clipping.');
  }

  
  const canvas = new OffscreenCanvas(safeW, safeH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, safeX, safeY, safeW, safeH, 0, 0, safeW, safeH);
  imageBitmap.close();

  
  const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
  const base64 = await blobToBase64(croppedBlob);

  
  if (safeW < 10 || safeH < 10) {
    throw new Error('Cropped screenshot is unexpectedly tiny. Try selecting a larger wrapper.');
  }

  return {
    action: 'wrapperScreenshotReady',
    screenshot: {
      imageMimeType: 'image/png',
      base64: base64,
      width: safeW,
      height: safeH,
      sourceRectCssPx: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      }
    }
  };
}



function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = String(reader.result || '');
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
