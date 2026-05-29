/**
 * @fileoverview WebMCP content script — picker, DOM summary builder, AI call,
 * result display and visual annotation preview.
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

function getElementByXPath(xpath) {
  if (!xpath || typeof xpath !== 'string') return null;
  try {
    const result = document.evaluate(
      xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    );
    return result.singleNodeValue instanceof Element ? result.singleNodeValue : null;
  } catch (_) {
    return null;
  }
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
  return el.tagName === 'A' &&
    (Boolean(el.getAttribute('href')) || el.getAttribute('role') === 'button');
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
  ) return true;

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
  const node = { xpath: getXPath(el), tagName: el.tagName.toLowerCase(), kind };
  if (el.getAttribute('type')) node.type = el.getAttribute('type');

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
  if (merged) node.content = merged.length > 140 ? `${merged.slice(0, 140)}…` : merged;

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
      if (text && text.length > 2) { textBlocks.push(buildCandidate(el, 'text')); return; }
    }
    for (const child of el.children) walk(child);
  }

  for (const child of wrapperEl.children) walk(child);

  return { containerXPath: getXPath(wrapperEl), candidates: [...controls, ...textBlocks] };
}

// ─── AI ──────────────────────────────────────────────────────────────────────

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

function parseAiResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI response was empty.');
  const parsed = JSON.parse(text);
  if (!parsed?.container || !Array.isArray(parsed.elements))
    throw new Error('AI response is missing required fields.');
  return parsed;
}

async function getAiSettings() {
  const defaults = { settings_model: 'gemini-3.5-flash', settings_api_key: '' };
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return defaults;
  return new Promise((resolve) =>
    chrome.storage.local.get(['settings_model', 'settings_api_key'], (result) =>
      resolve({
        settings_model: result.settings_model || defaults.settings_model,
        settings_api_key: result.settings_api_key || defaults.settings_api_key
      })
    )
  );
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

async function callAi({ screenshot, payload }) {
  const { settings_api_key: apiKey, settings_model: rawModel } = await getAiSettings();
  if (!apiKey.trim()) throw new Error('Missing API key in Settings.');

  const modelName = String(rawModel || '').replace(/^models\//, '').trim();
  if (!modelName) throw new Error('Missing model name in Settings.');

  const imageBase64 = sanitizeBase64Image(screenshot.base64);
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
              'You are a strict WebMCP Tool Specification Generator. Your single task is to map HTML candidates into the required JSON schema for a primary user action.',
              '',
              '### 1. Container Mapping Rules',
              '- "container.xpath": Must exactly mirror the provided "input.containerXPath".',
              '- "container.contentType": Classify the visual block based on elements (e.g., "product card", "configurator").',
              '- "container.toolname": Generate a concise action-based ID (e.g., "añadir_al_carrito") using lowercase and snake_case/kebab-case. It MUST be in the webpage\'s natural language.',
              '- "container.tooldescription": Write a clear summary of what the tool accomplishes, in the webpage\'s natural language.',
              '',
              '### 2. Element Extraction Strategy (RUTHLESS INPUT INVENTORY)',
              'You MUST process the candidates using a strict input-first checklist:',
              '- MANDATORY RULE: Every single candidate with `tagName: "input"` or `tagName: "select"` is a core parameter. You are FORBIDDEN from skipping them.',
              '- If an `input` has a raw numeric value (e.g., "6,00"), it represents a critical product variant (length, size, or price specification). It MUST be included in the "elements" array.',
              '- Identify the core execution button (e.g., "Añadir al carrito") to anchor the tool flow, but do not let it overshadow the numeric inputs above it.',
              '',
              '### 3. Parameter Synthesizing (For "elements" Array)',
              'For each identified `input` or configuration control, emit exactly ONE object in the "elements" array:',
              '- "xpath": The exact XPath of the `input` or functional control.',
              '- "toolparamtitle": The visible label. If the `input` contains a raw number like "6,00" and lacks an explicit label, you MUST look at the nearest text candidates to synthesize a logical title in the webpage\'s language.',
              '- "toolparamdescription": A concise instruction of what this parameter sets (in the webpage\'s language).',
              '',
              '### 4. Directives to Save Tokens & Filter Noise',
              '- Combine stepper pairs (plus/minus buttons) into the single numeric input XPath they modify. Do not emit separate parameters for "+" and "-".',
              '- Completely ignore: Image carousels ("Siguiente diapositiva"), reviews, wishlists, share options, and alternative fulfillment links ("Comprobar disponibilidad").',
              '- Write descriptions sharply and without introductory filler words.'
            ].join('\n')
          }]
        },
        contents: [{
          role: 'user', parts: [
            { inlineData: { mimeType: screenshot.imageMimeType, data: imageBase64 } },
            { text: ['# Task', 'Analyze the selected wrapper using the screenshot and DOM candidate list.', '', '# Input payload', JSON.stringify(payload, null, 2)].join('\n') }
          ]
        }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: getAiSchema(), temperature: 0.2 }
      })
    }
  );

  if (!response.ok) throw new Error(await readGeminiError(response));
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
let lastAiResult = null;

let aiRunning = false;
let captureRunning = false;

// ─── Widget refs ─────────────────────────────────────────────────────────────

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
let widgetPreviewBtn = null;
let widgetClearBtn = null;
let dragState = null;

// ─── Annotation state ────────────────────────────────────────────────────────

let annotationVisible = false;
let annotationLayer = null;
let annotationLegend = null;
let annotationLegendList = null;
let annotationLegendFooter = null;
let annotationNodes = [];
let _anchorSeq = 0;


// ─── WEBMCP attribute helpers ────────────────────────────────────────────────

const WEBMCP_ATTRS = {
  toolName: 'toolname',
  toolDescription: 'tooldescription',
  toolAutoSubmit: 'toolautosubmit',
  paramTitle: 'toolparamtitle',
  paramDescription: 'toolparamdescription'
};

function setWebMcpAttribute(el, name, value) {
  if (!(el instanceof Element) || !name) return;
  const normalized = collapseWS(value || '');
  if (!normalized) return;
  el.setAttribute(name, normalized);
}

function clearWebMcpAttributes(root = document) {
  const selector = Object.values(WEBMCP_ATTRS).map(a => `[${a}]`).join(',');
  for (const el of root.querySelectorAll(selector)) {
    Object.values(WEBMCP_ATTRS).forEach(a => el.removeAttribute(a));
  }
}

function getElementMeta(el) {
  if (!(el instanceof Element)) return '';
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type');
  return type ? `${tag}[type="${type}"]` : tag;
}

function normalizeToolName(value) {
  let name = collapseWS(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z_]+/, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);

  if (!name) name = `_webmcp_tool_${Date.now()}`;
  if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;

  return name.slice(0, 128);
}

function makeParamKey(item, el, index) {
  const fromName = collapseWS(el?.getAttribute?.('name') || '');
  if (fromName) return fromName.toLowerCase().replace(/\s+/g, '_').replace(/[^\w.-]/g, '').slice(0, 128);

  const fromTitle = collapseWS(item?.toolparamtitle || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, '_').replace(/[^\w.-]/g, '').slice(0, 128);

  return fromTitle || `param_${index + 1}`;
}

function shouldEnableAutoSubmit(result) {
  return (result?.elements || []).some((item) => {
    const text = collapseWS(`${item.toolparamtitle || ''} ${item.toolparamdescription || ''}`).toLowerCase();
    return ['add to cart', 'añadir al carrito', 'carrito', 'comprar', 'checkout', 'buy']
      .some(kw => text.includes(kw));
  });
}

function resolveWebMcpToolHost(result) {
  const containerEl = getElementByXPath(result?.container?.xpath);
  if (!containerEl) return null;
  if (containerEl.tagName === 'FORM') return containerEl;

  const nestedForm = containerEl.querySelector('form');
  if (nestedForm) return nestedForm;

  for (const item of result?.elements || []) {
    const form = getElementByXPath(item.xpath)?.closest?.('form');
    if (form) return form;
  }
  return null;
}

function resolveToolContext(result) {
  const containerEl = getElementByXPath(result?.container?.xpath);
  const toolHost = resolveWebMcpToolHost(result);
  const normalizedToolName = normalizeToolName(result?.container?.toolname || '');
  return { containerEl, toolHost, normalizedToolName };
}

function applyToolMetadata(host, result, normalizedToolName) {
  if (!(host instanceof HTMLFormElement)) return false;

  setWebMcpAttribute(host, WEBMCP_ATTRS.toolName, normalizedToolName);
  setWebMcpAttribute(host, WEBMCP_ATTRS.toolDescription, result?.container?.tooldescription || '');

  if (shouldEnableAutoSubmit(result)) {
    setWebMcpAttribute(host, WEBMCP_ATTRS.toolAutoSubmit, 'true');
  } else {
    host.removeAttribute(WEBMCP_ATTRS.toolAutoSubmit);
  }

  return true;
}


// ─── Annotation overlay ──────────────────────────────────────────────────────

function ensureAnnotationLayer() {
  if (annotationLayer && document.contains(annotationLayer)) return annotationLayer;
  annotationLayer = document.createElement('div');
  annotationLayer.id = 'webmcp-annotation-layer';
  annotationLayer.setAttribute('data-webmcp-annotation-layer', 'true');
  document.documentElement.appendChild(annotationLayer);
  return annotationLayer;
}

function ensureAnnotationLegend() {
  if (annotationLegend && document.contains(annotationLegend)) return annotationLegend;

  annotationLegend = document.createElement('aside');
  annotationLegend.id = 'webmcp-annotation-legend';
  annotationLegend.setAttribute('data-webmcp-annotation-legend', 'true');
  annotationLegend.setAttribute('aria-label', 'WebMCP annotation legend');

  const titleEl = document.createElement('div');
  titleEl.className = 'webmcp-annotation-legend-title';
  titleEl.textContent = 'Annotation legend';

  annotationLegendList = document.createElement('div');
  annotationLegendList.className = 'webmcp-annotation-legend-list';

  annotationLegend.append(titleEl, annotationLegendList);
  document.body.appendChild(annotationLegend);

  return annotationLegend;
}

function clearAnnotations() {
  annotationNodes.forEach(item => {
    if (item?.targetEl instanceof Element && item._anchorId) {
      item.targetEl.style.anchorName = '';
    }
    item?.box?.remove();
  });
  annotationNodes = [];
  if (annotationLayer) { annotationLayer.remove(); annotationLayer = null; }
  if (annotationLegend) { annotationLegend.remove(); annotationLegend = null; annotationLegendList = null; }
  clearWebMcpAttributes();
  annotationVisible = false;
  updateActionButtons();
}

function makeAnnotationBox({ targetEl, className, index, tone = 'element' } = {}) {
  if (!(targetEl instanceof Element)) return null;

  const anchorId = `--webmcp-a${++_anchorSeq}`;
  targetEl.style.anchorName = anchorId;

  const box = document.createElement('div');
  box.className = className;
  box.style.cssText = `
    position-anchor: ${anchorId};
    top: anchor(top);
    left: anchor(left);
    width: anchor-size(width);
    height: anchor-size(height);
    min-width: 18px;
    min-height: 18px;
  `;

  const badge = document.createElement('div');
  badge.className = `webmcp-annotation-badge webmcp-annotation-badge-${tone}`;
  badge.textContent = String(index);

  box.appendChild(badge);
  ensureAnnotationLayer().appendChild(box);

  const item = { box, badge, targetEl, _anchorId: anchorId };
  annotationNodes.push(item);
  return item;
}

function buildLegendItem(index, tone, title, el, attrLines) {
  return { index, tone, title: collapseWS(title || String(index)), node: getElementMeta(el), lines: attrLines };
}

function renderAnnotationLegend(items) {
  ensureAnnotationLegend();
  if (!annotationLegendList) return;
  annotationLegendList.textContent = '';

  for (const item of items) {
    const row = document.createElement('section');
    row.className = 'webmcp-annotation-legend-item';

    const head = document.createElement('div');
    head.className = 'webmcp-annotation-legend-head';

    const index = document.createElement('span');
    index.className = `webmcp-annotation-legend-index webmcp-annotation-legend-index-${item.tone || 'element'}`;
    index.textContent = String(item.index);

    const title = document.createElement('span');
    title.className = 'webmcp-annotation-legend-item-title';
    title.textContent = item.title || 'Untitled';

    head.append(index, title);
    row.appendChild(head);

    if (item.node) {
      const nodeEl = document.createElement('div');
      nodeEl.className = 'webmcp-annotation-legend-node';
      nodeEl.textContent = item.node;
      row.appendChild(nodeEl);
    }

    for (const line of item.lines || []) {
      const lineEl = document.createElement('div');
      lineEl.className = 'webmcp-annotation-legend-line';
      lineEl.textContent = line;
      row.appendChild(lineEl);
    }

    annotationLegendList.appendChild(row);
  }
}

function renderAnnotations(result) {
  clearAnnotations();
  clearWebMcpAttributes();

  if (!result?.container?.xpath) {
    showStatusLine('No AI result available for preview.');
    return;
  }

  const context = resolveToolContext(result);
  const { containerEl, toolHost, normalizedToolName } = context;
  const legendItems = [];

  const declarativeHost = toolHost instanceof HTMLFormElement ? toolHost : null;
  const metadataApplied = declarativeHost
    ? applyToolMetadata(declarativeHost, result, normalizedToolName)
    : false;

  if (containerEl) {
    const rect = containerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      makeAnnotationBox({ targetEl: containerEl, className: 'webmcp-annotation-box webmcp-annotation-container', index: 'C', tone: 'container' });

      const hostForLegend = declarativeHost || containerEl;
      const containerLines = [
        `${WEBMCP_ATTRS.toolName}="${normalizedToolName}"`,
        `${WEBMCP_ATTRS.toolDescription}="${collapseWS(result.container.tooldescription || '')}"`
      ];
      if (hostForLegend.getAttribute(WEBMCP_ATTRS.toolAutoSubmit)) {
        containerLines.push(`${WEBMCP_ATTRS.toolAutoSubmit}="${hostForLegend.getAttribute(WEBMCP_ATTRS.toolAutoSubmit)}"`);
      }

      legendItems.push(buildLegendItem('C', 'container', result.container.toolname || 'Container', hostForLegend, containerLines));
    }
  }

  let visibleCount = 0;
  for (const item of result.elements || []) {
    const el = getElementByXPath(item.xpath);
    if (!el) continue;

    setWebMcpAttribute(el, WEBMCP_ATTRS.paramTitle, item.toolparamtitle);
    setWebMcpAttribute(el, WEBMCP_ATTRS.paramDescription, item.toolparamdescription);

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    visibleCount += 1;
    makeAnnotationBox({ targetEl: el, className: 'webmcp-annotation-box webmcp-annotation-element', index: String(visibleCount), tone: 'element' });

    legendItems.push(buildLegendItem(
      String(visibleCount), 'element',
      item.toolparamtitle || `Element ${visibleCount}`,
      el,
      [
        `${WEBMCP_ATTRS.paramTitle}="${collapseWS(item.toolparamtitle || '')}"`,
        `${WEBMCP_ATTRS.paramDescription}="${collapseWS(item.toolparamdescription || '')}"`
      ]
    ));
  }

  renderAnnotationLegend(legendItems);
  annotationVisible = true;
  updateActionButtons();

  showStatusLine(
    metadataApplied
      ? `Annotations rendered and declarative WebMCP form attributes injected: ${visibleCount} element(s).`
      : 'Annotations rendered. Parameter annotations were injected, but no FORM host was found, so declarative tool attributes were skipped.'
  );
}

function toggleAnnotations() {
  if (annotationVisible) { clearAnnotations(); showStatusLine('Annotations cleared.'); return; }
  if (!lastAiResult) { showStatusLine('Run AI first to generate markup.'); return; }
  renderAnnotations(lastAiResult);
}

// ─── Widget helpers ──────────────────────────────────────────────────────────

function showStatusLine(text) {
  if (!widgetStatusLine) return;
  widgetStatusLine.textContent = text;
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
  widgetPayloadSection.classList.toggle('webmcp-hidden', !text.trim());
}

function setResultText(text) {
  if (!widgetResultSection || !widgetResult) return;
  widgetResult.textContent = text || '';
  widgetResultSection.classList.toggle('webmcp-hidden', !(text || '').trim());
}

function updateSelectionText() {
  if (!widgetSelection) return;
  widgetSelection.textContent = selectedWrapperXPath
    ? `Selected: ${selectedWrapperXPath}`
    : 'Selection: none';
}

function updateActionButtons() {
  const busy = aiRunning || captureRunning;

  if (widgetPickBtn) {
    widgetPickBtn.disabled = busy || pickerActive;
    widgetPickBtn.classList.toggle('is-disabled', widgetPickBtn.disabled);
  }

  if (widgetRunBtn) {
    const readyToRun = Boolean(selectedWrapperEl && lastScreenshot && lastDomPayload && !busy && !pickerActive);
    widgetRunBtn.disabled = !readyToRun;
    widgetRunBtn.classList.toggle('is-disabled', widgetRunBtn.disabled);
  }

  if (widgetPreviewBtn) {
    const canPreview = Boolean(lastAiResult && !busy && !pickerActive);
    widgetPreviewBtn.disabled = !canPreview;
    widgetPreviewBtn.classList.toggle('is-disabled', widgetPreviewBtn.disabled);
    widgetPreviewBtn.textContent = annotationVisible ? 'Hide Annotations' : 'Inject Markup';
  }

  if (widgetClearBtn) {
    widgetClearBtn.disabled = busy || (!selectedWrapperEl && !lastAiResult && !annotationVisible);
  }
}

function clearPreparedData() {
  lastScreenshot = null;
  lastDomPayload = null;
  setPreparedScreenshot(null);
  setPreparedPayload(null);
}

function clearAiResult() {
  lastAiResult = null;
  setResultText('');
  clearAnnotations();
}

function clearSelectionState() {
  selectedWrapperEl = null;
  selectedWrapperXPath = null;
  selectedWrapperRect = null;
}

function resetWidgetState() {
  if (aiRunning || captureRunning) return;
  stopPicker();
  clearSelectionState();
  clearPreparedData();
  clearAiResult();
  clearStatusLine();
  updateSelectionText();
  updateActionButtons();
  if (widgetClearBtn) widgetClearBtn.disabled = true;
}

// ─── Picker ──────────────────────────────────────────────────────────────────

function createPickerOverlay() {
  if (pickerOverlay) return pickerOverlay;

  pickerOverlay = document.createElement('div');
  pickerOverlay.id = 'webmcp-picker-overlay';
  pickerOverlay.className = 'webmcp-picker-overlay';

  pickerLabel = document.createElement('div');
  pickerLabel.id = 'webmcp-picker-label';
  pickerLabel.className = 'webmcp-picker-label';

  pickerOverlay.appendChild(pickerLabel);
  document.body.appendChild(pickerOverlay);
  return pickerOverlay;
}

function positionOverlay(el) {
  if (!pickerOverlay || !(el instanceof Element)) return;

  const rect = el.getBoundingClientRect();
  pickerOverlay.style.cssText = `
    width:${rect.width}px;
    height:${rect.height}px;
    top:${rect.top + window.scrollY}px;
    left:${rect.left + window.scrollX}px;
  `;

  if (pickerLabel) {
    pickerLabel.textContent =
      `${el.tagName.toLowerCase()} • ${Math.round(rect.width)}×${Math.round(rect.height)} • ${el.children.length} children`;
  }
}

function startPicker() {
  if (pickerActive || aiRunning || captureRunning) return;

  ensureWidget();
  pickerActive = true;
  createPickerOverlay();

  document.addEventListener('mousemove', onPickerMouseOver, true);
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('keydown', onPickerKeyDown, true);

  document.body.classList.add('webmcp-picking-cursor');
  showStatusLine('Click a wrapper element to select it. Press Esc to cancel.');
  updateActionButtons();
}

function stopPicker() {
  pickerActive = false;

  document.removeEventListener('mousemove', onPickerMouseOver, true);
  document.removeEventListener('click', onPickerClick, true);
  document.removeEventListener('keydown', onPickerKeyDown, true);

  document.body.classList.remove('webmcp-picking-cursor');

  if (pickerOverlay) {
    pickerOverlay.remove();
    pickerOverlay = null;
  }

  pickerLabel = null;
  lastPickerTarget = null;
  updateActionButtons();
}

function onPickerMouseOver(e) {
  if (!pickerActive) return;

  e.preventDefault();
  e.stopPropagation();

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest('#webmcp-picker-overlay')) return;
  if (target.closest('[data-webmcp-widget="true"]')) return;
  if (target.closest('[data-webmcp-annotation-layer="true"]')) return;
  if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'].includes(target.tagName)) return;
  if (target === lastPickerTarget) return;

  lastPickerTarget = target;
  createPickerOverlay();
  positionOverlay(target);
}

function onPickerKeyDown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    stopPicker();
    showStatusLine('Picker cancelled.');
  }
}

function onPickerClick(e) {
  if (!pickerActive) return;

  e.preventDefault();
  e.stopPropagation();

  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  if (target.closest('#webmcp-picker-overlay')) return;
  if (target.closest('[data-webmcp-widget="true"]')) return;
  if (target.closest('[data-webmcp-annotation-layer="true"]')) return;

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
  lastAiResult = null;

  clearAnnotations();
  setPreparedScreenshot(null);
  setPreparedPayload(null);
  setResultText('');
  updateSelectionText();

  stopPicker();
  updateActionButtons();
  captureAfterPick(target);
}

// ─── Capture ─────────────────────────────────────────────────────────────────

async function captureAfterPick(el) {
  if (!el || captureRunning) return;

  captureRunning = true;
  clearStatusLine();
  updateActionButtons();

  try {
    const rect = el.getBoundingClientRect();
    selectedWrapperRect = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      devicePixelRatio: window.devicePixelRatio || 1
    };

    lastDomPayload = buildDomSummary(el);
    setPreparedPayload(lastDomPayload);

    if (widgetRoot) widgetRoot.classList.add('webmcp-hidden');
    await new Promise((r) => setTimeout(r, 90));
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);

    lastScreenshot = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { action: 'captureWrapperScreenshot', rect: selectedWrapperRect },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (response?.action !== 'wrapperScreenshotReady') {
            reject(new Error(response?.error || 'Screenshot capture failed.'));
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
    if (widgetClearBtn) widgetClearBtn.disabled = false;
    updateActionButtons();
  }
}

// ─── AI flow ─────────────────────────────────────────────────────────────────

async function runAiAnalysis() {
  if (aiRunning || !lastScreenshot || !lastDomPayload) return;
  aiRunning = true;
  clearAnnotations();
  setResultText('');
  updateActionButtons();
  showStatusLine('Running AI…');

  try {
    const result = await callAi({ screenshot: lastScreenshot, payload: lastDomPayload });
    lastAiResult = result;
    setResultText(JSON.stringify(result, null, 2));
    showStatusLine('AI done. Click "Inject Markup" to inject markup.');
  } catch (err) {
    showStatusLine(`AI failed: ${err.message}`);
  } finally {
    aiRunning = false;
    updateActionButtons();
  }
}

// ─── Widget build ────────────────────────────────────────────────────────────

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

function ensureWidget() {
  if (!IS_TOP_WINDOW) return null;

  if (widgetRoot && document.contains(widgetRoot)) return widgetRoot;

  widgetRoot = document.createElement('section');
  widgetRoot.id = 'webmcp-floating-widget';
  widgetRoot.setAttribute('data-webmcp-widget', 'true');
  widgetRoot.setAttribute('aria-label', 'WebMCP annotator widget');

  const header = document.createElement('div');
  header.className = 'webmcp-widget-header';

  const titleEl = document.createElement('div');
  titleEl.textContent = 'WebMCP Annotator';
  titleEl.className = 'webmcp-widget-title';

  widgetClearBtn = document.createElement('button');
  widgetClearBtn.type = 'button';
  widgetClearBtn.textContent = 'Clear';
  widgetClearBtn.className = 'webmcp-btn webmcp-btn-clear';
  widgetClearBtn.disabled = true;

  const dragHint = document.createElement('div');
  dragHint.textContent = 'Drag';
  dragHint.className = 'webmcp-drag-hint';

  header.append(titleEl, widgetClearBtn, dragHint);

  const widgetInstructions = document.createElement('div');
  widgetInstructions.className = 'webmcp-widget-instructions';
  widgetInstructions.innerHTML = `
    <p>Select a wrapper to collect data, run AI, then inject the suggested WebMCP markup.</p>
  `;

  const controls = document.createElement('div');
  controls.className = 'webmcp-widget-controls';

  widgetPickBtn = document.createElement('button');
  widgetPickBtn.type = 'button';
  widgetPickBtn.className = 'webmcp-btn webmcp-btn-primary';
  widgetPickBtn.textContent = 'Pick wrapper';
  widgetPickBtn.addEventListener('click', startPicker);

  widgetRunBtn = document.createElement('button');
  widgetRunBtn.type = 'button';
  widgetRunBtn.className = 'webmcp-btn webmcp-btn-analyze';
  widgetRunBtn.textContent = 'Run AI';
  widgetRunBtn.disabled = true;
  widgetRunBtn.addEventListener('click', runAiAnalysis);

  widgetPreviewBtn = document.createElement('button');
  widgetPreviewBtn.type = 'button';
  widgetPreviewBtn.className = 'webmcp-btn webmcp-btn-primary';
  widgetPreviewBtn.textContent = 'Inject Markup';
  widgetPreviewBtn.disabled = true;
  widgetPreviewBtn.addEventListener('click', toggleAnnotations);

  widgetClearBtn.addEventListener('click', resetWidgetState);

  controls.append(widgetPickBtn, widgetRunBtn, widgetPreviewBtn);

  widgetSelection = document.createElement('div');
  widgetSelection.className = 'webmcp-widget-selection';

  widgetStatusLine = document.createElement('div');
  widgetStatusLine.className = 'webmcp-widget-status visually-hidden';

  widgetScreenshotSection = document.createElement('section');
  widgetScreenshotSection.className = 'webmcp-widget-section webmcp-hidden';

  const screenshotTitle = document.createElement('div');
  screenshotTitle.className = 'webmcp-widget-section-title';
  screenshotTitle.textContent = 'Screenshot';

  widgetScreenshotImg = document.createElement('img');
  widgetScreenshotImg.alt = 'Selected wrapper screenshot';
  widgetScreenshotImg.className = 'webmcp-widget-screenshot';

  widgetScreenshotSection.append(screenshotTitle, widgetScreenshotImg);

  widgetPayloadSection = document.createElement('section');
  widgetPayloadSection.className = 'webmcp-widget-section webmcp-hidden';

  const payloadTitle = document.createElement('div');
  payloadTitle.className = 'webmcp-widget-section-title';
  payloadTitle.textContent = 'Prepared payload';

  widgetPreparedPayload = document.createElement('pre');
  widgetPreparedPayload.className = 'webmcp-widget-code';

  widgetPayloadSection.append(payloadTitle, widgetPreparedPayload);

  widgetResultSection = document.createElement('section');
  widgetResultSection.className = 'webmcp-widget-section webmcp-hidden';

  const resultTitle = document.createElement('div');
  resultTitle.className = 'webmcp-widget-section-title';
  resultTitle.textContent = 'AI result';

  widgetResult = document.createElement('pre');
  widgetResult.className = 'webmcp-widget-code';

  widgetResultSection.append(resultTitle, widgetResult);

  widgetRoot.append(
    header,
    widgetInstructions,
    controls,
    widgetSelection,
    widgetStatusLine,
    widgetScreenshotSection,
    widgetPayloadSection,
    widgetResultSection
  );

  const mountTarget = document.body || document.documentElement;
  mountTarget.appendChild(widgetRoot);

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

  widgetRoot.classList.remove('webmcp-hidden');
  setWidgetPos(window.innerWidth - 380, 16);

  updateSelectionText();
  updateActionButtons();

  return widgetRoot;
}

function initEmbeddedWidget() {
  if (!IS_TOP_WINDOW) return;

  const mount = () => {
    try {
      ensureWidget();
    } catch (err) {
      console.error('WebMCP widget init failed:', err);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

initEmbeddedWidget();

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

    case 'previewWrapperAnnotations':
      toggleAnnotations();
      sendResponse({ success: true });
      break;

    case 'clearWrapperAnnotations':
      clearAnnotations();
      sendResponse({ success: true });
      break;

    default:
      if (request.type === 'TOGGLE_WIDGET') {
        if (!IS_TOP_WINDOW) {
          sendResponse({ success: false });
          return true;
        }

        const widget = ensureWidget();
        if (!widget) {
          sendResponse({ success: false });
          return true;
        }

        if (document.contains(widget)) {
          widget.remove();
          widgetRoot = null;
        } else {
          document.body.appendChild(widget);
        }

        sendResponse({ success: true });
        return true;
      }

      sendResponse({ success: false, error: `Unknown action: ${request.action}` });
      break;
  }

  return true;
});