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
              'ANALYSIS & CATEGORIZATION LOGIC:',
              '',
              '1. VISUAL INSPECTION & OPTION GROUP EXTRACTION (CRITICAL):',
              '   - Look at the UI screenshot first to identify ALL functional parameters (e.g. Size pickers S/M/L/XL/XXL, Color swatches, Quantity selectors -/+/1, Search inputs, Filter options).',
              '   - Form option groups (such as Size pickers S/M/L/XL/XXL, Color selectors, Variant pickers, Quantity adjusters) represent PRIMARY TOOL PARAMETERS and MUST NEVER BE OMITTED.',
              '',
              '2. CATEGORIZATION RULES FOR THE TWO ARRAYS:',
              '   a) "elements" (Direct Declarative Candidates):',
              '      - Any candidate in the DOM candidate list that is a native or semantic HTML tag: <input> (including radio, checkbox, text, number, hidden), <select>, <button>, <label>, or <a> link MUST be categorized under "elements".',
              '      - Native HTML tags (input, button, select, label, a) CAN receive declarative WebMCP attributes (toolparamtitle, toolparamdescription) directly in HTML, so they belong in "elements". DO NOT put native HTML tags into possibleCandidates if they are present in the DOM candidate list.',
              '      - Option groups (e.g. Size pickers S/M/L/XL/XXL, radio buttons, dropdowns, variant buttons) whose nodes appear as input/label/button/a tags in the DOM candidate list MUST be included in "elements" with their parameter title (e.g., toolparamtitle: "Size" or "Tamaño").',
              '',
              '   b) "possibleCandidates" (Non-Declarative / Custom Candidates):',
              '      - Use "possibleCandidates" ONLY for custom, non-semantic UI nodes (e.g. custom <div>, <span>, SVG, pseudo-CSS controls) that act as inputs/controls visually or functionally but LACK standard HTML element tags (<input>, <button>, <select>, <label>, <a>) in the DOM candidate list to receive HTML attributes directly.',
              '      - For every item in possibleCandidates, provide a short 1-sentence "reason" explaining why it is a custom/non-declarative component.',
              '',
              '3. SUBMIT / EXECUTION BUTTON RULE:',
              '   - The primary execution button (e.g. "ADD TO CART", "Submit", "Search") is NOT a parameter and MUST NOT be in elements or possibleCandidates. Use it only to derive container.toolname.',
              '',
              '4. PARAMETER DETAILS:',
              '   - Provide toolparamtitle and toolparamdescription for every item in both arrays.',
              '   - Unpack option choices (e.g. size pickers S/M/L/XL/XXL, color swatches), mapping the corresponding option nodes into elements.'
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
          temperature: 0.1
        }
      })
    }
  );

  if (!response.ok) throw new Error(await readGeminiError(response));

  const resJson = await response.json();
  const resText = resJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resText) throw new Error('AI response was empty.');

  const parsed = JSON.parse(resText);
  if (!parsed?.container || !Array.isArray(parsed.elements) || !Array.isArray(parsed.possibleCandidates)) {
    throw new Error('AI response is missing required fields (container, elements, possibleCandidates).');
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
        description: 'List of direct declarative interactive parameters found inside the container with proper HTML semantics to accept WebMCP DOM attributes. Do not include submit/execution elements.',
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
      },
      possibleCandidates: {
        type: 'ARRAY',
        description: 'List of components or pseudo-controls that look/act like inputs/parameters but CANNOT accept declarative WebMCP attributes due to lacking proper HTML semantics. Suggest WebMCP parameter title, description, and a short reason for each.',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The precise XPath of the node.'
            },
            toolparamtitle: {
              type: 'STRING',
              description: 'Suggested parameter title.'
            },
            toolparamdescription: {
              type: 'STRING',
              description: 'Suggested parameter description.'
            },
            reason: {
              type: 'STRING',
              description: 'A very short explanation (1 concise sentence in English) explaining why this item is a possible candidate rather than a direct declarative element.'
            }
          },
          required: ['xpath', 'toolparamtitle', 'toolparamdescription', 'reason']
        }
      }
    },
    required: ['container', 'elements', 'possibleCandidates']
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