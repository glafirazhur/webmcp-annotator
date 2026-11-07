/**
 * @fileoverview Background service worker — captures and crops a screenshot of the selected wrapper
 * and proxies AI analysis requests to the Gemini API.
 */

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureWrapperScreenshot') {
    handleCaptureScreenshot(request, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ action: 'wrapperScreenshotError', error: err.message }));
    return true;
  }

  if (request.action === 'runAiAnalysis') {
    handleAiAnalysis(request)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleAiAnalysis(request) {
  const { screenshot, payload } = request;

  const defaults = { settings_model: 'gemini-3.5-flash', settings_api_key: '' };
  const settings = await chrome.storage.local.get(defaults);

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
              'You are an expert DOM and UI analyzer. Your task is to extract interactive parameters from a given UI container into a WebMCP Tool specification.',
              '',
              'CRITICAL RULES:',
              '1. STRICT LANGUAGE:',
              '   - "tooldescription" and "toolparamdescription" MUST strictly match the primary language of the provided screenshot/UI.',
              '   - "toolname" MUST be a valid ASCII lowercase snake_case identifier (e.g. "add_to_cart", "anadir_al_carrito", "search_products"). Transliterate or translate non-Latin scripts into ASCII snake_case.',
              '   - "reason" (in possibleCandidates) MUST always be in concise English.',
              '2. RAW JSON ONLY: Return pure JSON matching the response schema. No markdown fences, comments, or extra text.',
              '',
              'ANALYSIS & CATEGORIZATION LOGIC:',
              '',
              '1. VISUAL INSPECTION & OPTION GROUP EXTRACTION (CRITICAL):',
              '   - Inspect the UI screenshot alongside the DOM candidates to identify ALL functional input parameters that configure or feed into the tool action (e.g. Size pickers S/M/L/XL/XXL, Color swatches, Delivery mode options, Quantity selectors -/+/1, Search inputs, Filter controls).',
              '   - Every individual option choice within a group (e.g. S, M, L, XL, XXL) represents a separate parameter item and MUST be individually unpacked. NEVER merge multiple option choices into a single group wrapper.',
              '',
              '2. CATEGORIZATION RULES FOR THE TWO ARRAYS:',
              '   a) "elements" (Direct Declarative Visible Native Form Controls ONLY):',
              '      - Include ONLY native interactive form controls (<input>, <select>, <textarea>, <button>) that are visibly rendered in the DOM (hiddenInDom is NOT true).',
              '      - If a visible native <input> (such as a visible radio button or checkbox) exists for an option, put that <input> in "elements" and DO NOT also include its associated <label> in "possibleCandidates".',
              '      - DO NOT put <label>, <a>, <div>, <span>, option group containers, or hidden inputs (hiddenInDom: true) into "elements".',
              '',
              '   b) "possibleCandidates" (Visible Custom Controls & Non-Declarative Option Pickers ONLY):',
              '      - Include ONLY visible elements that functionally act as tool parameters or option choices, but do NOT use a visible native form control:',
              '        1. Visible <label> or custom option nodes that control a CSS-hidden native input (where the underlying <input> has hiddenInDom: true). Always select the XPath of the VISIBLE interactive element (e.g. the <label> or button-like wrapper), NEVER the XPath of the hiddenInDom: true input.',
              '        2. Variant/option pickers implemented as links (candidates with optionLike: true or controlType: "link-option", such as color swatches or size links).',
              '        3. Custom interactive pseudo-controls (e.g. custom div/span toggles, custom sliders, pseudo-dropdowns, role="radio"/role="option"/role="switch" nodes).',
              '      - EXCLUSIONS — DO NOT INCLUDE IN EITHER ARRAY:',
              '        - Static field labels or headings that merely describe an already-included visible form control.',
              '        - Standard navigation or informational links (controlType: "link-action") that are not variant option pickers.',
              '        - Auxiliary/informational UI triggers that do not set a tool parameter value (e.g. "Size Guide", "Shipping/Delivery Info" popups, product details/reviews accordions, tooltips, share buttons, or wishlist/favorite buttons).',
              '        - Hidden DOM nodes (hiddenInDom: true) or internal technical state inputs.',
              '      - For every item in possibleCandidates, provide a concise 1-sentence "reason" in English explaining why it is a custom or non-declarative control.',
              '',
              '3. SUBMIT / EXECUTION BUTTON & FORM BOUNDARY RULE:',
              '   - The primary execution button (e.g. "Add to Cart", "Submit", "Search", "Apply") triggers the tool action: it is NOT an input parameter and MUST NOT be included in "elements" or "possibleCandidates". Use its visible text to derive container.toolname.',
              '   - Secondary action buttons that adjust input state before submission (e.g. quantity "-" / "+" stepper buttons, clear/filter toggles) ARE parameters and belong in "elements" if they are native <button>/<input> tags.',
              '   - POST-SUBMIT BOUNDARY: In form or product-purchase layouts where the primary submit button ("Add to Cart", "Buy Now", "Submit") sits at the bottom of the parameter controls, treat that button as the closing boundary of the tool—ignore any auxiliary links, accordions, or actions positioned visually after/below it.',
              '',
              '4. PARAMETER DESCRIPTION RULES:',
              '   - Provide a clear "toolparamdescription" for EVERY item in BOTH arrays ("elements" and "possibleCandidates").',
              '   - FUNCTIONAL SPECIFICATION ONLY: Write toolparamdescription strictly in terms of user intent/function (e.g. "Select size XL for the product", "Increase package quantity by 1").',
              '   - NEVER mention HTML/DOM implementation terms (such as "label", "visual label", "div", "span", "link", "wrapper") inside toolparamdescription. Put implementation details only in "reason".'
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
            description: 'ASCII lowercase snake_case identifier derived from the primary submit/execution button text (e.g., "add_to_cart", "anadir_al_carrito"), or a concise functional snake_case name if no submit button exists.'
          },
          tooldescription: {
            type: 'STRING',
            description: 'Short summary of what the entire tool accomplishes, in the primary UI language.'
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
        description: 'Visible native interactive form controls (<input>, <select>, <textarea>, <button>) that set tool parameters. Exclude hidden inputs (hiddenInDom: true), static labels, links, auxiliary triggers (e.g. size guides, wishlists), and the primary submit button.',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The precise XPath of the visible native form control.'
            },
            toolparamdescription: {
              type: 'STRING',
              description: 'Functional explanation of what parameter or state this control sets, in the primary UI language.'
            }
          },
          required: ['xpath', 'toolparamdescription']
        }
      },
      possibleCandidates: {
        type: 'ARRAY',
        description: 'Visible custom pseudo-controls or non-declarative option pickers (e.g. visible <label> for a hiddenInDom input, optionLike variant links, custom div/span toggles, sliders, or dropdowns). Never include hiddenInDom nodes, static labels for already-included visible inputs, informational/auxiliary triggers (size guides, details, wishlists), or elements after the primary submit button.',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The precise XPath of the visible interactive candidate node (never a hiddenInDom node).'
            },
            toolparamdescription: {
              type: 'STRING',
              description: 'Functional parameter description explaining what option/action this parameter controls in the primary UI language (e.g. "Select size XL for the product"). Do not mention HTML tag or implementation terms.'
            },
            reason: {
              type: 'STRING',
              description: 'One concise sentence in English explaining why this item is a non-declarative candidate rather than a native form control.'
            }
          },
          required: ['xpath', 'toolparamdescription', 'reason']
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

  if (safeW < 10 || safeH < 10) {
    imageBitmap.close();
    throw new Error('Cropped screenshot is unexpectedly tiny. Try selecting a larger wrapper.');
  }

  const scaled = getScaledDimensions(safeW, safeH);
  const canvas = new OffscreenCanvas(scaled.width, scaled.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imageBitmap, safeX, safeY, safeW, safeH, 0, 0, scaled.width, scaled.height);
  imageBitmap.close();

  const encoded = await convertCanvasToOptimizedBlob(canvas);
  const base64 = await blobToBase64(encoded.blob);

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