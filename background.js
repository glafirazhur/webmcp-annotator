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
              'You generate a strict WebMCP Tool JSON for one interaction container. Map only actionable interactive controls.',
              '',
              'Rules:',
              '- container.xpath: exactly copy input.containerXPath.',
              '- container.contentType: short type like product_form, checkout_form, configurator.',
              '- container.toolname: lowercase snake_case, action-based, in the webpage language.',
              '- container.tooldescription: short action summary, in the webpage language.',
              '',
              '- elements[] must contain only interactive controls the agent can act on: input, button, select, textarea, actionable a, or explicitly interactive custom controls.',
              '- Make sure to compare the candidate element with the screenshot to confirm they are correspond to interactive controls.',
              '- Never output Informational buttons, links, or toggles that do not directly change the product configuration or execute a purchase-related action.',
              '- Never use li, ul, ol, div, span, label, p, section, article as element xpath unless that exact node is itself  via role, tabindex, onclick, aria-pressed, aria-selected, or equivalent semantics.',
              '- CRITICAL EXCEPTION: Product variants (size/color chips) and fulfillment selectors (delivery vs pickup options) are often built using generic tags (div, span, label, li) or anchor links with distinct URLs. If a node visually acts as an option-select control, YOU MUST map its closest clickable element (like the `a` tag or toggle container), even if it triggers navigation or lacks standard ARIA attributes.',
              '- If text is inside a li or wrapper but the real clickable target is a descendant a/button/input/custom control, output the descendant interactive xpath, not the wrapper xpath.',
              '- NEVER annotate submit buttons (e.g., tags with type="submit", input[type="submit"], or primary CTA buttons that execute the form) with toolparamtitle or toolparamdescription. Action execution triggers are NOT parameters. The execution action is defined by the containers toolname.',
              '',
              '- Product Form Strategy: Systematically scan for and map: 1. All product variants (Size/Medidas, Color chips), 2. Main fulfillment toggles (Delivery vs Click & Collect choices), 3. Quantity input, 4. Primary execution control (Add to cart).',
              '- CRITICAL FOR VARIANTS: Product variants are frequently structured as individual `a` tags with distinct URLs or product IDs in the `href`. You MUST treat them as state-changing interactive controls, NOT generic navigation. Look closely for class names containing \'variant\' (e.g., \'variant-selection__btn\') or HTML attributes like `data-product-variant-name`. Extract EVERY individual option choice.',
              '- When mapping delivery or fulfillment options, prioritize the element that activates the option itself (the radio input or the clickable option container) over secondary informational buttons inside that section.',
              '- Ignore informational text, carousels, wishlist, share, and generic external navigation that does not change the current product configuration or purchase flow.',
              '- Collapse plus/minus steppers into the single numeric input they modify.',
              '',
              'For each element object:',
              '- xpath: exact xpath of the final actionable interactive node.',
              '- toolparamtitle: short human-readable parameter title in the webpage language. For variant chips/links, extract ONLY the specific option value text (e.g., "200 x 104 x 1,8 cm"), ignoring any hidden text, error messages, or tooltips inside the container.',
              '- toolparamdescription: short description of what state it changes or what action it executes, in the webpage language.',
              '- If multiple controls belong to one option group, output each actionable control separately with consistent naming.',
              '',
              'Output valid JSON only.'
            ].join('\\n')
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
          temperature: 0.2
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
          xpath: { type: 'STRING', description: 'The exact XPath of the selected wrapper container.' },
          contentType: { type: 'STRING', description: 'The suggested type of the presented content based on the list of elements and a screenshot, e.g., "product card", "article", "profile", "listing item", "gallery", etc. This is a hint for WebMCP toolname generation and can be used in the future for auto-categorization of tools.' },
          toolname: { type: 'STRING', description: 'The semantic name of the WebMCP tool (e.g., "add-to-cart"). MUST be written in the exact same language as the webpage text.' },
          tooldescription: { type: 'STRING', description: 'Detailed explanation of what the tool does. MUST be written in the exact same language as the webpage text.' }
        },
        required: ['xpath', 'contentType', 'toolname', 'tooldescription']
      },
      elements: {
        type: 'ARRAY',
        description: 'List of all relevant interactive elements found inside the container (inputs, dropdowns, radio groups, buttons).',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: { type: 'STRING', description: 'The main XPath of the element or its group container from the input candidate list.' },
            toolparamtitle: { type: 'STRING', description: 'The visible label or title of the parameter. MUST be in the exact same language as the webpage.' },
            toolparamdescription: { type: 'STRING', description: 'Explanation of what this parameter controls. MUST be in the exact same language as the webpage.' }
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