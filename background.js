/**
 * @fileoverview Background service worker — captures and crops a screenshot of the selected wrapper.
 */

// Добавляем обработчик в существующий chrome.runtime.onMessage.addListener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureWrapperScreenshot') {
    handleCaptureScreenshot(request, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ action: 'wrapperScreenshotError', error: err.message }));
    return true;
  }

  // Наш новый безопасный шлюз для работы с ИИ
  if (request.action === 'runAiAnalysis') {
    handleAiAnalysis(request)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// Новые функции внутри background.js:
async function handleAiAnalysis(request) {
  const { screenshot, payload } = request;

  const defaults = { settings_model: 'gemini-3.5-flash', settings_api_key: '' };
  const settings = await new Promise((resolve) => {
    chrome.storage.local.get(['settings_model', 'settings_api_key'], (result) => {
      resolve({
        settings_model: result.settings_model || defaults.settings_model,
        settings_api_key: result.settings_api_key || defaults.settings_api_key
      });
    });
  });

  const apiKey = settings.settings_api_key;
  if (!apiKey || !apiKey.trim()) throw new Error('Missing API key in Settings.');

  const modelName = String(settings.settings_model || '').replace(/^models\//, '').trim();
  if (!modelName) throw new Error('Missing model name in Settings.');

  const imageBase64 = String(screenshot?.base64 || '').replace(/^data:[^,]+,/, '').trim();
  if (!imageBase64) throw new Error('Prepared screenshot is empty.');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: [
              'You are an expert DOM and UI analyzer. Your task is to extract interactive elements from a given UI container into a WebMCP Tool specification.',
              '',
              'CRITICAL RULES:',
              '1. STRICT LANGUAGE: All generated textual values (titles, descriptions, toolnames) MUST strictly match the primary language of the provided screenshot/UI. No translations.',
              '2. RAW JSON ONLY: Return pure JSON. Do not wrap the output in ```json markdown blocks. No comments, no extra characters.',
              '',
              'ANALYSIS LOGIC:',
            '- Component Agnostic: Analyze the UI to determine the primary intent of the container (e.g., search, config, filter, add-to-cart form).',
            '- Naming Priority: Derive container.toolname from the main execution button (e.g., "submit", "search", "add_to_cart").',
            '- Submit/Execution Button Rule (CRITICAL): The primary submit/execution button is NOT a tool parameter and MUST NOT be included in elements. Use it only to derive container.toolname and to determine container.toolautosubmit.',
            '- Strict Scope: Only include elements that act as DIRECT INPUTS for the primary intent.',
            '- Functional Exclusion (CRITICAL): If an interactive element initiates a NEW action (e.g., opening a new page, navigating to a detail view, selecting a category/genre that leads away from the tool), it is NOT a parameter. EXCLUDE IT.',
            '- Element Selection: Map only controls that modify the container\'s state locally (e.g., inputs, checkboxes, color switches).',
            '- Visual Inference: Infer labels for icons/buttons only if they serve the primary intent.',
            '- Group Unpacking: Unpack local state options (e.g., color variants), but never unpack navigation/content lists.',
            '- Exclusions: Exclude all navigation links, content recommendations, genre/title lists, and static informational text.'
            ].join('\n')
          }]
        },
        contents: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: screenshot.imageMimeType,
                data: imageBase64
              }
            },
            {
              text: [
                '# Task',
                'Analyze the selected wrapper using the screenshot and DOM candidate list.',
                '',
                '# Input payload',
                JSON.stringify(payload, null, 2)
              ].join('\n')
            }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: getAiSchema(),
          temperature: 0.1 // Снизила температуру до 0.1 для большей стабильности и предсказуемости JSON
        }
      })
    }
  );

  if (!response.ok) throw new Error(await readGeminiError(response));

  const resJson = await response.json();
  const resText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resText) throw new Error('AI response was empty.');

  const parsed = JSON.parse(resText);
  if (!parsed?.container || !Array.isArray(parsed.elements)) {
    throw new Error('AI response is missing required fields.');
  }
  return parsed;
}

function getAiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      container: {
        type: 'OBJECT',
        properties: {
          xpath: {
            type: 'STRING',
            description: 'The exact XPath matching the provided input.containerXPath boundary.'
          },
          contentType: {
            type: 'STRING',
            description: 'Short functional classification of the widget (e.g., "product_configurator", "media_player", "filter_sidebar").'
          },
          toolname: {
            type: 'STRING',
            description: 'Lowercase snake_case name. STRICT PRIORITY: Derive this directly from the exact visible text of the primary submit/execution button (e.g., "add_to_cart"). Only invent a name if no primary button exists.'
          },
          tooldescription: {
            type: 'STRING',
            description: 'Short summary of what the entire tool accomplishes.'
          },
          toolautosubmit: {
            type: 'BOOLEAN',
            description: 'True if interacting with parameters immediately applies changes/updates state without needing a separate submit click.'
          }
        },
        required: ['xpath', 'contentType', 'toolname', 'tooldescription', 'toolautosubmit']
      },
      elements: {
        type: 'ARRAY',
        description: 'List of actionable interactive parameters found strictly inside the container. Do not include submit/execution elements',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The precise XPath of the actionable node. If wrapped, target the deepest real clickable element.'
            },
            toolparamtitle: {
              type: 'STRING',
              description: 'The visible label text. If text is missing in the DOM, infer the semantic name visually from the screenshot (e.g., "search", "close").'
            },
            toolparamdescription: {
              type: 'STRING',
              description: 'Explanation of what data or state this specific parameter controls.'
            }
          },
          required: ['xpath', 'toolparamtitle', 'toolparamdescription']
        }
      }
    },
    required: ['container', 'elements']
  };
}

async function readGeminiError(response) {
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      const message = data?.error?.message || data?.message;
      return message
        ? `AI API ${response.status}: ${message}`
        : `AI API ${response.status}: ${JSON.stringify(data).slice(0, 400)}`;
    } catch (_) {
      return `AI API ${response.status}: ${text.slice(0, 400)}`;
    }
  } catch (_) {
    return `AI API ${response.status}: request failed`;
  }
}

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
    } catch (_) { }
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