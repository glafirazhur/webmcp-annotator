/**
 * @fileoverview WebMCP content script — picker, DOM summary builder, AI call, result display.
 */


// ─── XPath ───────────────────────────────────────────────────────────────────


function getXPath(el) {
  if (!(el instanceof Element)) return null;

  const parts = [];
  let cur = el;

  while (cur && cur.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sib = cur.previousElementSibling;

    while (sib) {
      if (sib.tagName === cur.tagName) idx++;
      sib = sib.previousElementSibling;
    }

    parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
    cur = cur.parentElement;
  }

  return '/' + parts.join('/');
}


// ─── DOM summary ─────────────────────────────────────────────────────────────


const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'LINK', 'META', 'BR', 'HR', 'IMG']);
const TEXT_TAGS = new Set([
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'SPAN', 'LABEL', 'LEGEND', 'LI', 'DT', 'DD',
  'SUMMARY', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM', 'A'
]);


function collapseWS(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}


function truncate(text, max) {
  const s = collapseWS(text);
  return s.length > max ? s.slice(0, max) + '…' : s;
}


function isHidden(el) {
  if (el.hidden) return true;
  const s = window.getComputedStyle(el);
  return s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0';
}


function isClickableLink(el) {
  return el.tagName === 'A' && (Boolean(el.getAttribute('href')) || el.getAttribute('role') === 'button');
}


function isCustomControl(el) {
  const role = (el.getAttribute('role') || '').toLowerCase();
  const tabindex = el.getAttribute('tabindex');
  const interactive = new Set(['button', 'link', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option']);

  if (interactive.has(role)) return true;

  if (
    tabindex !== null &&
    Number(tabindex) >= 0 &&
    (el.hasAttribute('onclick') || el.hasAttribute('aria-pressed') || el.hasAttribute('aria-expanded'))
  ) {
    return true;
  }

  return false;
}


function getLabels(control) {
  const out = [];

  if (control.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (lbl) out.push(truncate(lbl.textContent, 80));
  }

  const parent = control.closest('label');
  if (parent) {
    const t = truncate(parent.textContent, 80);
    if (t && !out.includes(t)) out.push(t);
  }

  const aria = control.getAttribute('aria-label');
  if (aria) out.push(truncate(aria, 80));

  return out;
}


function buildCandidate(el, kind) {
  const node = {
    xpath: getXPath(el),
    tagName: el.tagName.toLowerCase(),
    kind
  };

  if (el.getAttribute('type')) {
    node.type = el.getAttribute('type');
  }

  const labels = kind === 'control' ? getLabels(el) : [];
  const rawText = kind === 'control'
    ? truncate(el.innerText || el.value || '', 120)
    : truncate(el.innerText || el.textContent, 200);

  const labelText = labels[0] || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  const merged = collapseWS(
    rawText && labelText && rawText.toLowerCase() !== labelText.toLowerCase()
      ? `${rawText} | ${labelText}`
      : rawText || labelText
  );

  if (merged) {
    node.content = merged.length > 140 ? `${merged.slice(0, 140)}…` : merged;
  }

  return node;
}


function buildDomSummary(wrapperEl) {
  const controls = [];
  const textBlocks = [];

  function walk(el) {
    if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return;
    if (isHidden(el)) return;

    if (CONTROL_TAGS.has(el.tagName) || isClickableLink(el) || isCustomControl(el)) {
      controls.push(buildCandidate(el, 'control'));
      return;
    }

    if (TEXT_TAGS.has(el.tagName)) {
      const text = truncate(el.innerText || el.textContent, 200);
      if (text && text.length > 2) {
        textBlocks.push(buildCandidate(el, 'text'));
        return;
      }
    }

    for (const child of el.children) {
      walk(child);
    }
  }

  for (const child of wrapperEl.children) {
    walk(child);
  }

  return {
    containerXPath: getXPath(wrapperEl),
    candidates: [...controls, ...textBlocks]
  };
}


// ─── AI ──────────────────────────────────────────────────────────────────────


function getAiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      container: {
        type: 'OBJECT',
        properties: {
          xpath: {
            type: 'STRING',
            description: 'The exact XPath of the selected wrapper container.'
          },
          contentType: {
            type: 'STRING',
            description: 'The suggested type of the presented content based on the list of elements and a screenshot, e.g., "product card", "article", "profile", "listing item", "gallery", etc. This is a hint for WebMCP toolname generation and can be used in the future for auto-categorization of tools.'
          },
          toolname: {
            type: 'STRING',
            description: 'The semantic name of the WebMCP tool (e.g., "add-to-cart"). MUST be written in the exact same language as the webpage text.'
          },
          tooldescription: {
            type: 'STRING',
            description: 'Detailed explanation of what the tool does. MUST be written in the exact same language as the webpage text.'
          }
        },
        required: ['xpath', 'contentType', 'toolname', 'tooldescription']
      },
      elements: {
        type: 'ARRAY',
        description: 'List of all relevant interactive elements found inside the container (inputs, dropdowns, radio groups, buttons).',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The main XPath of the element or its group container from the input candidate list.'
            },
            toolparamtitle: {
              type: 'STRING',
              description: 'The visible label or title of the parameter. MUST be in the exact same language as the webpage.'
            },
            toolparamdescription: {
              type: 'STRING',
              description: 'Explanation of what this parameter controls. MUST be in the exact same language as the webpage.'
            },
            /*options: {
              type: 'ARRAY',
              description: 'If the element is a select dropdown, radio group, or variant picker, list ALL available options here. Leave empty for text/number inputs.',
              items: {
                type: 'OBJECT',
                properties: {
                  value: {
                    type: 'STRING',
                    description: 'The text or label of the option as seen on the screen (e.g., "XL", "Красный", "Envío a domicilio"). MUST be in the exact same language as the webpage.'
                  },
                  xpath: {
                    type: 'STRING',
                    description: 'The specific candidate XPath for this option element if present, or the parent element XPath.'
                  }
                },
                required: ['value']
              }
            }*/
          },
          required: ['xpath', 'toolparamtitle', 'toolparamdescription']
        }
      }
    },
    required: ['container', 'elements']
  };
}


function parseAiResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('AI response was empty.');
  }

  const parsed = JSON.parse(text);

  if (!parsed?.container || !Array.isArray(parsed.elements)) {
    throw new Error('AI response is missing required fields.');
  }

  return parsed;
}


async function getAiSettings() {
  const defaults = { settings_model: 'gemini-3.5-flash', settings_api_key: '' };

  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return defaults;
  }

  return new Promise((resolve) => {
    chrome.storage.local.get(['settings_model', 'settings_api_key'], (result) => {
      resolve({
        settings_model: result.settings_model || defaults.settings_model,
        settings_api_key: result.settings_api_key || defaults.settings_api_key
      });
    });
  });
}


function sanitizeBase64Image(data) {
  return String(data || '').replace(/^data:[^,]+,/, '').trim();
}


async function readGeminiError(response) {
  try {
    const text = await response.text();

    try {
      const data = JSON.parse(text);
      const message = data?.error?.message || data?.message;

      if (message) {
        return `AI API ${response.status}: ${message}`;
      }

      return `AI API ${response.status}: ${JSON.stringify(data).slice(0, 400)}`;
    } catch (_) {
      return `AI API ${response.status}: ${text.slice(0, 400)}`;
    }
  } catch (_) {
    return `AI API ${response.status}: request failed`;
  }
}


async function callAi({ screenshot, payload }) {
  const { settings_api_key: apiKey, settings_model: rawModel } = await getAiSettings();

  if (!apiKey.trim()) {
    throw new Error('Missing API key in Settings.');
  }

  const modelName = String(rawModel || '').replace(/^models\//, '').trim();
  if (!modelName) {
    throw new Error('Missing model name in Settings.');
  }

  const imageBase64 = sanitizeBase64Image(screenshot.base64);
  if (!imageBase64) {
    throw new Error('Prepared screenshot is empty.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: [
              'You annotate a selected webpage wrapper for a WebMCP tool.',
              'Use only candidate xpaths from the input payload. Do not invent xpaths.',
              'container.xpath must exactly match input.containerXPath.',
              'Return only confident fields. At most one element per fieldId.',
              '',
              '# CRITICAL RULES FOR OPTIONS AND FORM FIELDS:',
              'Include ALL interactive form options, product variants, and calculation inputs inside the container.',
              '',
              '# VISUAL GROUNDING FOR UNLABELED INPUTS (UNIVERSAL):',
              '1. Some critical input fields may lack explicit text labels in the JSON candidates list (they might only have a default numeric value or placeholder like "1" or "0").',
              '2. You MUST cross-reference the XPath candidates with the provided screenshot by analyzing their visual positions relative to surrounding elements.',
              '3. Look for text units, labels, badges, or symbols printed directly next to, above, or inside the input field ON THE SCREENSHOT (e.g., measurement units, currencies, pack sizes, or fractional text like "pcs", "kg", "m²", "ml", "box", "€", "$").',
              '4. If an input field dynamically changes or calculates quantities, volumes, or pricing context visually, you MUST include it as a separate parameter.',
              '5. Infer the "toolparamtitle" and "toolparamdescription" based on these visual unit indicators and the overall form context.',
              '',
              '# CRITICAL LANGUAGE RULE:',
              '1. STRICTLY matches the natural language of the analyzed webpage.',
              '2. "toolname", "tooldescription", "toolparamtitle", and "toolparamdescription" MUST be written in the EXACT SAME LANGUAGE as the labels and text found on the screenshot and DOM for this host page.',
              '3. NEVER translate labels to English. If the website is in French, use French; if it is in German, use German, etc. Match the host locale dynamically.'
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
                '<input_payload>',
                JSON.stringify(payload, null, 2),
                '</input_payload>'
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

  if (!response.ok) {
    throw new Error(await readGeminiError(response));
  }

  return parseAiResponse(await response.json());
}


// ─── State ───────────────────────────────────────────────────────────────────


const IS_TOP_WINDOW = window === window.top;

let pickerActive = false;
let pickerOverlay = null;
let pickerLabel = null;
let lastPickerTarget = null;

let selectedWrapperEl = null;
let selectedWrapperXPath = null;
let selectedWrapperRect = null;

let lastScreenshot = null;
let lastDomPayload = null;
let aiRunning = false;
let captureRunning = false;


// ─── Widget ──────────────────────────────────────────────────────────────────


let widgetRoot = null;
let widgetStatusLine = null;
let widgetSelection = null;

let widgetScreenshotSection = null;
let widgetScreenshotImg = null;

let widgetPayloadSection = null;
let widgetPreparedPayload = null;

let widgetResultSection = null;
let widgetResult = null;

let widgetPickBtn = null;
let widgetRunBtn = null;
let widgetClearBtn = null;

let dragState = null;


function ensureWidget() {
  if (!IS_TOP_WINDOW) return;
  if (widgetRoot && document.contains(widgetRoot)) return;

  widgetRoot = document.createElement('section');
  widgetRoot.id = 'webmcp-floating-widget';
  widgetRoot.setAttribute('data-webmcp-widget', 'true');
  widgetRoot.setAttribute('aria-label', 'WebMCP annotator widget');

  const header = document.createElement('div');
  header.className = 'webmcp-widget-header';

  const title = document.createElement('div');
  title.textContent = 'WebMCP Annotator';
  title.className = 'webmcp-widget-title';

  const dragHint = document.createElement('div');
  dragHint.textContent = 'Drag';
  dragHint.className = 'webmcp-drag-hint';

  widgetClearBtn = document.createElement('button');
  widgetClearBtn.type = 'button';
  widgetClearBtn.textContent = 'Clear';
  widgetClearBtn.className = 'webmcp-btn webmcp-btn-clear';
  widgetClearBtn.disabled = true;
 

  header.appendChild(title);
  header.appendChild(widgetClearBtn);
  header.appendChild(dragHint);

  const widgetInstructions = document.createElement('div');
  widgetInstructions.className = 'webmcp-widget-instructions';
  widgetInstructions.innerHTML =
    '<p>This widget annotates your content for AI Agents following the WebMCP standard.</p>' +
    '<ol>' +
    '<li>Click "Pick Target" and select a wrapper on the page.</li>' +
    '<li>Review the prepared screenshot and payload.</li>' +
    '<li>Click "Run AI" to get annotation suggestions.</li>' +
    '</ol>';

  const actions = document.createElement('div');
  actions.className = 'webmcp-actions';

  widgetPickBtn = document.createElement('button');
  widgetPickBtn.type = 'button';
  widgetPickBtn.textContent = 'Pick Target';
  widgetPickBtn.className = 'webmcp-btn webmcp-btn-primary';

  widgetRunBtn = document.createElement('button');
  widgetRunBtn.type = 'button';
  widgetRunBtn.textContent = 'Run AI';
  widgetRunBtn.className = 'webmcp-btn webmcp-btn-analyze';
  widgetRunBtn.disabled = true;

  actions.appendChild(widgetPickBtn);
  actions.appendChild(widgetRunBtn);

  widgetStatusLine = document.createElement('div');
  widgetStatusLine.className = 'webmcp-status-line visually-hidden';
  widgetStatusLine.setAttribute('role', 'status');
  widgetStatusLine.setAttribute('aria-live', 'polite');

  widgetSelection = document.createElement('pre');
  widgetSelection.className = 'webmcp-selection';

  widgetScreenshotSection = document.createElement('section');
  widgetScreenshotSection.className = 'webmcp-data-section webmcp-hidden';

  const screenshotTitle = document.createElement('div');
  screenshotTitle.className = 'webmcp-section-title';
  screenshotTitle.textContent = 'Prepared screenshot';

  widgetScreenshotImg = document.createElement('img');
  widgetScreenshotImg.className = 'webmcp-screenshot';
  widgetScreenshotImg.alt = 'Prepared wrapper screenshot';

  widgetScreenshotSection.append(screenshotTitle, widgetScreenshotImg);

  widgetPayloadSection = document.createElement('section');
  widgetPayloadSection.className = 'webmcp-data-section webmcp-hidden';

  const payloadTitle = document.createElement('div');
  payloadTitle.className = 'webmcp-section-title';
  payloadTitle.textContent = 'Prepared payload';

  widgetPreparedPayload = document.createElement('pre');
  widgetPreparedPayload.className = 'webmcp-selection webmcp-scroll-block';

  widgetPayloadSection.append(payloadTitle, widgetPreparedPayload);

  widgetResultSection = document.createElement('section');
  widgetResultSection.className = 'webmcp-data-section webmcp-hidden';

  const resultTitle = document.createElement('div');
  resultTitle.className = 'webmcp-section-title';
  resultTitle.textContent = 'AI response';

  widgetResult = document.createElement('pre');
  widgetResult.className = 'webmcp-result webmcp-scroll-block';

  widgetResultSection.append(resultTitle, widgetResult);

  widgetRoot.append(
    header,
    widgetInstructions,
    actions,
    widgetStatusLine,
    widgetSelection,
    widgetScreenshotSection,
    widgetPayloadSection,
    widgetResultSection
  );

  document.body.appendChild(widgetRoot);

  const beginDrag = (e) => {
    if (!widgetRoot || e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, label')) return;

    const rect = widgetRoot.getBoundingClientRect();
    setWidgetPos(rect.left, rect.top);

    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top
    };

    header.classList.add('is-dragging');
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onDragMove = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    setWidgetPos(
      dragState.left + e.clientX - dragState.startX,
      dragState.top + e.clientY - dragState.startY
    );
  };

  const endDrag = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    try {
      header.releasePointerCapture(e.pointerId);
    } catch (_) { }

    dragState = null;
    header.classList.remove('is-dragging');
  };

  header.addEventListener('pointerdown', beginDrag);
  header.addEventListener('pointermove', onDragMove);
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (!widgetRoot) return;
    const r = widgetRoot.getBoundingClientRect();
    setWidgetPos(r.left, r.top);
  });

  widgetPickBtn.addEventListener('click', () => {
    clearStatusLine();
    startPicker();
  });

  widgetRunBtn.addEventListener('click', () => {
    clearStatusLine();
    runAiAnalysis().catch((err) => {
      showStatusLine(`AI failed: ${err.message}`);
    });
  });

  widgetClearBtn.addEventListener('click', () => {
    resetWidgetState();
  });

  updateSelectionText();
  setPreparedScreenshot(null);
  setPreparedPayload(null);
  setResultText('');
  updateActionButtons();
}


function resetWidgetState() {
  if (aiRunning || captureRunning) return;

  stopPicker();

  selectedWrapperEl = null;
  selectedWrapperXPath = null;
  selectedWrapperRect = null;

  lastScreenshot = null;
  lastDomPayload = null;
  widgetClearBtn.disabled = true;

  clearStatusLine();
  setPreparedScreenshot(null);
  setPreparedPayload(null);
  setResultText('');
  updateSelectionText();
  updateActionButtons();
}


function setWidgetPos(left, top) {
  if (!widgetRoot) return;

  const margin = 8;
  const w = widgetRoot.offsetWidth || 360;
  const h = widgetRoot.offsetHeight || 240;

  widgetRoot.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - w - margin)}px`;
  widgetRoot.style.top = `${Math.min(Math.max(top, margin), window.innerHeight - h - margin)}px`;
  widgetRoot.style.right = 'auto';
  widgetRoot.style.bottom = 'auto';
}


function showStatusLine(text) {
  if (!widgetStatusLine) return;
  widgetStatusLine.textContent = text || '';
  widgetStatusLine.classList.toggle('visually-hidden', !text);
}


function clearStatusLine() {
  if (!widgetStatusLine) return;
  widgetStatusLine.textContent = '';
  widgetStatusLine.classList.add('visually-hidden');
}


function setPreparedScreenshot(screenshot) {
  if (!widgetScreenshotSection || !widgetScreenshotImg) return;

  if (!screenshot?.base64 || !screenshot?.imageMimeType) {
    widgetScreenshotImg.removeAttribute('src');
    widgetScreenshotSection.classList.add('webmcp-hidden');
    return;
  }

  widgetScreenshotImg.src = `data:${screenshot.imageMimeType};base64,${screenshot.base64}`;
  widgetScreenshotSection.classList.remove('webmcp-hidden');
}


function setPreparedPayload(payload) {
  if (!widgetPayloadSection || !widgetPreparedPayload) return;

  const text = payload ? JSON.stringify(payload, null, 2) : '';
  widgetPreparedPayload.textContent = text;

  if (text.trim()) {
    widgetPayloadSection.classList.remove('webmcp-hidden');
  } else {
    widgetPayloadSection.classList.add('webmcp-hidden');
  }
}


function setResultText(text) {
  if (!widgetResultSection || !widgetResult) return;

  const nextText = text || '';
  widgetResult.textContent = nextText;

  if (nextText.trim()) {
    widgetResultSection.classList.remove('webmcp-hidden');
  } else {
    widgetResultSection.classList.add('webmcp-hidden');
  }
}


function updateSelectionText() {
  if (!widgetSelection) return;

  widgetSelection.textContent = selectedWrapperXPath
    ? `Selected: ${selectedWrapperXPath}`
    : 'Selection: none';
}



function updateActionButtons() {
  if (!widgetRunBtn || !widgetPickBtn) return;

  const busy = aiRunning || captureRunning;
  const readyToRun = Boolean(selectedWrapperEl && lastScreenshot && lastDomPayload && !busy && !pickerActive);

  widgetPickBtn.disabled = busy || pickerActive;
  widgetPickBtn.classList.toggle('is-disabled', widgetPickBtn.disabled);

  widgetRunBtn.disabled = !readyToRun;
  widgetRunBtn.classList.toggle('is-disabled', widgetRunBtn.disabled);
}


// ─── Picker ──────────────────────────────────────────────────────────────────


function createPickerOverlay() {
  if (pickerOverlay) return;

  pickerOverlay = document.createElement('div');
  pickerOverlay.id = 'webmcp-picker-overlay';
  pickerOverlay.className = 'webmcp-picker-overlay';

  pickerLabel = document.createElement('div');
  pickerLabel.id = 'webmcp-picker-label';
  pickerLabel.className = 'webmcp-picker-label';

  pickerOverlay.appendChild(pickerLabel);
  document.body.appendChild(pickerOverlay);
}


function positionOverlay(el) {
  if (!pickerOverlay) return;

  const rect = el.getBoundingClientRect();
  pickerOverlay.style.cssText = `
    width:${rect.width}px;
    height:${rect.height}px;
    top:${rect.top + window.scrollY}px;
    left:${rect.left + window.scrollX}px;
  `;

  if (pickerLabel) {
    pickerLabel.textContent = `<${el.tagName.toLowerCase()}> ${Math.round(rect.width)}×${Math.round(rect.height)} · ${el.children.length} children`;
  }
}


function resolvePickerTarget(e) {
  const stack = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(e.clientX, e.clientY)
    : [e.target];

  return stack.find((n) =>
    n instanceof Element &&
    !n.closest('#webmcp-picker-overlay') &&
    !n.closest('[data-webmcp-widget="true"]') &&
    !['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(n.tagName)
  ) || null;
}


function handlePickerHover(e) {
  if (!pickerActive) return;

  e.preventDefault();
  e.stopPropagation();

  const target = resolvePickerTarget(e);
  if (!target || target === lastPickerTarget) return;

  lastPickerTarget = target;
  createPickerOverlay();
  positionOverlay(target);
}


function handlePickerClick(e) {
  if (!pickerActive) return;

  e.preventDefault();
  e.stopPropagation();

  const target = resolvePickerTarget(e);
  if (!target) return;

  const rect = target.getBoundingClientRect();

  selectedWrapperEl = target;
  selectedWrapperXPath = getXPath(target);
  selectedWrapperRect = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    devicePixelRatio: window.devicePixelRatio || 1
  };

  lastScreenshot = null;
  lastDomPayload = null;

  setPreparedScreenshot(null);
  setPreparedPayload(null);
  setResultText('');
  updateSelectionText();

  stopPicker();
  updateActionButtons();
  captureAfterPick();
}


function handlePickerKeydown(e) {
  if (!pickerActive || e.key !== 'Escape') return;

  e.preventDefault();
  e.stopPropagation();
  stopPicker();
  showStatusLine('Picker canceled.');
  updateActionButtons();
}


function startPicker() {
  ensureWidget();

  if (pickerActive || aiRunning || captureRunning) return;

  pickerActive = true;
  document.addEventListener('mousemove', handlePickerHover, true);
  document.addEventListener('click', handlePickerClick, true);
  document.addEventListener('keydown', handlePickerKeydown, true);
  document.body.classList.add('webmcp-picking-cursor');

  updateActionButtons();
}


function stopPicker() {
  pickerActive = false;
  document.removeEventListener('mousemove', handlePickerHover, true);
  document.removeEventListener('click', handlePickerClick, true);
  document.removeEventListener('keydown', handlePickerKeydown, true);
  document.body.classList.remove('webmcp-picking-cursor');

  if (pickerOverlay) {
    pickerOverlay.remove();
    pickerOverlay = null;
    pickerLabel = null;
  }

  lastPickerTarget = null;
}


// ─── Capture after pick ───────────────────────────────────────────────────────


async function captureAfterPick() {
  if (!selectedWrapperEl) return;

  captureRunning = true;
  clearStatusLine();
  updateActionButtons();

  try {
    lastDomPayload = buildDomSummary(selectedWrapperEl);
    setPreparedPayload(lastDomPayload);

    if (widgetRoot) widgetRoot.classList.add('webmcp-hidden');

    await new Promise((r) => setTimeout(r, 90));
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    lastScreenshot = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'captureWrapperScreenshot', rect: selectedWrapperRect },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (response?.action !== 'wrapperScreenshotReady') {
            reject(new Error(response?.error || 'Screenshot failed.'));
            return;
          }

          resolve(response.screenshot);
        }
      );
    });

    setPreparedScreenshot(lastScreenshot);
    showStatusLine('Prepared payload and screenshot are ready.');
  } catch (err) {
    lastScreenshot = null;
    lastDomPayload = selectedWrapperEl ? buildDomSummary(selectedWrapperEl) : null;
    setPreparedScreenshot(null);
    setPreparedPayload(lastDomPayload);
    showStatusLine(`Screenshot capture failed: ${err.message}`);
  } finally {
    captureRunning = false;
    if (widgetRoot) widgetRoot.classList.remove('webmcp-hidden');
    updateActionButtons();
    widgetClearBtn.disabled = false;
  }
}


// ─── AI analysis ─────────────────────────────────────────────────────────────


async function runAiAnalysis() {
  if (aiRunning || captureRunning || !lastScreenshot || !lastDomPayload) return;

  aiRunning = true;
  setResultText('');
  updateActionButtons();
  showStatusLine('Running AI analysis…');

  try {
    const result = await callAi({
      screenshot: lastScreenshot,
      payload: lastDomPayload
    });

    setResultText(JSON.stringify(result, null, 2));
    showStatusLine('AI analysis complete.');
  } catch (err) {
    setResultText('');
    showStatusLine(`AI failed: ${err.message}`);
    throw err;
  } finally {
    aiRunning = false;
    updateActionButtons();
  }
}


// ─── Init ────────────────────────────────────────────────────────────────────


if (IS_TOP_WINDOW) {
  ensureWidget();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.action) {
      case 'startWrapperPicker':
        startPicker();
        sendResponse({ success: true });
        break;

      case 'cancelWrapperPicker':
        stopPicker();
        updateActionButtons();
        sendResponse({ success: true });
        break;

      case 'runWrapperAiAnalysis':
        runAiAnalysis()
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
        return true;

      default:
        sendResponse({ success: false, error: `Unknown action: ${request.action}` });
        break;
    }

    return true;
  });
}