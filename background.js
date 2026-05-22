/**
 * @fileoverview Background service worker — captures and crops a screenshot of the selected wrapper.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureWrapperScreenshot') {
    handleCaptureScreenshot(request, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ action: 'wrapperScreenshotError', error: err.message }));
    return true;
  }
});

async function handleCaptureScreenshot(request, sender) {
  const { rect } = request;
  const tabId = sender?.tab?.id;

  if (!rect || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Wrapper has zero or invalid dimensions.');
  }

  if (!tabId) {
    throw new Error('No tab id available for screenshot capture.');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab) {
    throw new Error('Tab not found.');
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
  } catch (err) {
    if (err.message?.includes('MAX_CAPTURE_VISIBLE_TAB')) {
      throw new Error('Screenshot quota exceeded. Please wait a moment and try again.');
    }
    throw new Error(`Failed to capture tab: ${err.message}`);
  }

  const dpr = rect.devicePixelRatio || 1;
  const cropX = Math.round(rect.x * dpr);
  const cropY = Math.round(rect.y * dpr);
  const cropW = Math.round(rect.width * dpr);
  const cropH = Math.round(rect.height * dpr);

  const blob = await (await fetch(dataUrl)).blob();
  const imageBitmap = await createImageBitmap(blob);

  const safeX = Math.max(0, Math.min(cropX, imageBitmap.width));
  const safeY = Math.max(0, Math.min(cropY, imageBitmap.height));
  const safeW = Math.min(cropW, imageBitmap.width - safeX);
  const safeH = Math.min(cropH, imageBitmap.height - safeY);

  if (safeW <= 0 || safeH <= 0) {
    imageBitmap.close();
    throw new Error('Wrapper is offscreen or has zero visible area after clipping.');
  }

  const scaled = getScaledDimensions(safeW, safeH);
  const canvas = new OffscreenCanvas(scaled.width, scaled.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, safeX, safeY, safeW, safeH, 0, 0, scaled.width, scaled.height);
  imageBitmap.close();

  const encoded = await convertCanvasToOptimizedBlob(canvas);
  const base64 = await blobToBase64(encoded.blob);

  if (safeW < 10 || safeH < 10) {
    throw new Error('Cropped screenshot is unexpectedly tiny. Try selecting a larger wrapper.');
  }

  return {
    action: 'wrapperScreenshotReady',
    screenshot: {
      imageMimeType: encoded.mimeType,
      base64,
      width: scaled.width,
      height: scaled.height
    }
  };
}

function getScaledDimensions(width, height) {
  const MAX_DIM = 1400;
  const MAX_PIXELS = 1400 * 1400;
  const ratio = Math.min(
    MAX_DIM / Math.max(width, height),
    Math.sqrt(MAX_PIXELS / (width * height)),
    1
  );

  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

async function convertCanvasToOptimizedBlob(canvas) {
  for (const option of [
    { type: 'image/webp', quality: 0.84 },
    { type: 'image/jpeg', quality: 0.87 }
  ]) {
    try {
      const blob = await canvas.convertToBlob(option);
      if (blob?.size > 0) {
        return { blob, mimeType: option.type };
      }
    } catch (_) {}
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, mimeType: 'image/png' };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}