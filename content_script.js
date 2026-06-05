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
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
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
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LABEL', 'LEGEND',
  'LI', 'DT', 'DD', 'SUMMARY', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM', 'A'
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
  ) return true;
  return false;
}

function isNativeInteractiveElement(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function isActuallyInteractiveElement(el) {
  if (!(el instanceof Element)) return false;
  if (isNativeInteractiveElement(el)) return true;
  if (el instanceof HTMLAnchorElement) return isClickableLink(el);
  return isCustomControl(el);
}

function findInteractiveDescendant(root) {
  if (!(root instanceof Element)) return null;

  const selector = [
    'button',
    'input',
    'select',
    'textarea',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="tab"]',
    '[tabindex]'
  ].join(',');

  for (const el of root.querySelectorAll(selector)) {
    if (isActuallyInteractiveElement(el) && !isHidden(el)) return el;
  }
  return null;
}

function resolveInteractiveTarget(el) {
  if (!(el instanceof Element)) return null;
  if (isActuallyInteractiveElement(el)) return el;

  const descendant = findInteractiveDescendant(el);
  if (descendant) return descendant;

  return null;
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

function hasOptionState(el) {
  if (!(el instanceof Element)) return false;
  const cls = `${el.className || ''}`.toLowerCase();
  return (
    el.hasAttribute('aria-current') ||
    el.hasAttribute('aria-selected') ||
    el.hasAttribute('aria-pressed') ||
    el.hasAttribute('data-selected') ||
    el.hasAttribute('data-active') ||
    el.hasAttribute('data-current') ||
    /\b(active|selected|current|checked|chosen)\b/.test(cls)
  );
}

function getOptionGroupContainer(el) {
  if (!(el instanceof Element)) return null;
  return el.closest(
    [
      '[role="listbox"]',
      '[role="radiogroup"]',
      '[role="tablist"]',
      '[role="group"]',
      'fieldset',
      'ul',
      'ol',
      '[class*="option"]',
      '[class*="variant"]',
      '[class*="swatch"]',
      '[class*="selector"]'
    ].join(',')
  );
}

function getSiblingOptionCount(el) {
  const group = getOptionGroupContainer(el);
  if (!group) return 0;

  const options = group.querySelectorAll('a[href], button, [role="option"], [role="radio"], [role="tab"]');
  return options.length;
}

function inferGroupLabel(el) {
  const group = getOptionGroupContainer(el);
  if (!group) return '';

  const ariaLabel = collapseWS(group.getAttribute('aria-label') || '');
  if (ariaLabel) return truncate(ariaLabel, 80);

  const labelledBy = group.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelNode = document.getElementById(labelledBy);
    const text = collapseWS(labelNode?.textContent || '');
    if (text) return truncate(text, 80);
  }

  const legend = group.querySelector('legend');
  if (legend) {
    const text = collapseWS(legend.textContent || '');
    if (text) return truncate(text, 80);
  }

  const heading = group.querySelector('h1,h2,h3,h4,h5,h6,label,.label,[class*="label"],[class*="title"],[class*="name"]');
  if (heading) {
    const text = collapseWS(heading.textContent || '');
    if (text) return truncate(text, 80);
  }

  return '';
}

function isShortOptionText(text) {
  const s = collapseWS(text);
  if (!s) return false;
  if (s.length > 60) return false;
  return true;
}

function isOptionLikeLink(el) {
  if (!(el instanceof HTMLAnchorElement)) return false;
  if (!isClickableLink(el)) return false;

  const text = collapseWS(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
  const parentLi = el.closest('li');
  const group = getOptionGroupContainer(el);
  const siblingCount = getSiblingOptionCount(el);
  const stateful = hasOptionState(el) || hasOptionState(parentLi || el) || hasOptionState(group || el);

  const role = (el.getAttribute('role') || '').toLowerCase();
  const optionRole = ['option', 'radio', 'tab', 'menuitemradio'].includes(role);

  const withinOptionishContainer = Boolean(parentLi || group);
  const looksLikeVariantValue = isShortOptionText(text);

  if (optionRole) return true;
  if (stateful && withinOptionishContainer) return true;
  if (withinOptionishContainer && siblingCount >= 2 && looksLikeVariantValue) return true;

  return false;
}

function getOptionLikeMeta(el) {
  const target = resolveInteractiveTarget(el);
  if (!(target instanceof Element)) return { optionLike: false };

  const parentLi = target.closest('li');
  const group = getOptionGroupContainer(target);

  const ownText = collapseWS(
    target.innerText ||
    target.textContent ||
    target.getAttribute('aria-label') ||
    ''
  );

  const liText = collapseWS(parentLi?.innerText || parentLi?.textContent || '');
  const groupLabel = inferGroupLabel(target);

  const selected =
    hasOptionState(target) ||
    hasOptionState(parentLi || target) ||
    target.getAttribute('aria-current') === 'page' ||
    target.getAttribute('aria-selected') === 'true' ||
    target.getAttribute('aria-pressed') === 'true';

  return {
    optionLike: true,
    controlType: target instanceof HTMLAnchorElement ? 'link-option' : 'control-option',
    navigationMode: target instanceof HTMLAnchorElement ? 'page-navigation' : 'in-place',
    groupLabel: groupLabel || undefined,
    groupContainerXPath: group ? getXPath(group) : undefined,
    optionContainerXPath: parentLi ? getXPath(parentLi) : undefined,
    siblingOptionCount: getSiblingOptionCount(target),
    selected: Boolean(selected),
    optionText: truncate(ownText, 120) || undefined,
    optionContext: liText && liText !== ownText ? truncate(liText, 160) : undefined,
    interactiveXPath: getXPath(target)
  };
}

function buildCandidate(el, kind) {
  const sourceEl = el;
  const targetEl = kind === 'control' ? resolveInteractiveTarget(el) : el;
  if (!(targetEl instanceof Element)) return null;

  const node = {
    xpath: getXPath(targetEl),
    tagName: targetEl.tagName.toLowerCase(),
    kind
  };

  if (targetEl.getAttribute('type')) node.type = targetEl.getAttribute('type');

  const labels = kind === 'control' ? getLabels(targetEl) : [];
  const rawText = kind === 'control'
    ? truncate(targetEl.innerText || targetEl.value || '', 120)
    : truncate(targetEl.innerText || targetEl.textContent || '', 200);

  const labelText =
    labels[0] ||
    targetEl.getAttribute('aria-label') ||
    targetEl.getAttribute('placeholder');

  const merged = collapseWS(
    rawText && labelText && rawText.toLowerCase() !== labelText.toLowerCase()
      ? `${rawText} — ${labelText}`
      : (rawText || labelText || '')
  );

  if (merged) node.content = merged.length > 140 ? merged.slice(0, 140) : merged;

  if (kind === 'control' && targetEl instanceof HTMLAnchorElement) {
    node.href = targetEl.getAttribute('href');
    if (isOptionLikeLink(targetEl)) {
      Object.assign(node, getOptionLikeMeta(targetEl));
      if (node.groupLabel && node.optionText && !String(node.content || '').includes(node.groupLabel)) {
        node.content = collapseWS(`${node.optionText} — ${node.groupLabel}`);
      }
    } else {
      node.controlType = 'link-action';
    }
  }

  if (kind === 'control' && !(targetEl instanceof HTMLAnchorElement)) {
    const optionMeta = getOptionLikeMeta(targetEl);
    if (optionMeta.optionLike) {
      Object.assign(node, optionMeta);
    } else {
      node.controlType = 'control';
    }
  }

  if (sourceEl !== targetEl) {
    node.sourceXPath = getXPath(sourceEl);
  }

  return node;
}

function buildDomSummary(wrapperEl) {
  const controls = [];
  const textBlocks = [];
  const seen = new Set();

  function pushUnique(list, candidate) {
    if (!candidate?.xpath) return;
    if (seen.has(candidate.xpath)) return;
    seen.add(candidate.xpath);
    list.push(candidate);
  }

  function containsOptionLikeLink(el) {
    if (!(el instanceof Element)) return false;
    const links = el.querySelectorAll('a[href], a[role="button"], a[role="option"], a[role="tab"], a[role="radio"]');
    for (const link of links) {
      if (isOptionLikeLink(link)) return true;
    }
    return false;
  }

  function shouldKeepTextBlock(el) {
    if (!(el instanceof Element)) return false;
    if (el.tagName === 'LI' && containsOptionLikeLink(el)) return false;
    if ((el.tagName === 'UL' || el.tagName === 'OL') && containsOptionLikeLink(el)) return false;
    return true;
  }

  function walk(el) {
    if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return;
    if (isHidden(el)) return;

    if (CONTROL_TAGS.has(el.tagName) || isClickableLink(el) || isCustomControl(el)) {
      pushUnique(controls, buildCandidate(el, 'control'));
      return;
    }

    if (TEXT_TAGS.has(el.tagName) && shouldKeepTextBlock(el)) {
      const text = truncate(el.innerText || el.textContent, 200);
      if (text && text.length > 2) {
        pushUnique(textBlocks, buildCandidate(el, 'text'));
        return;
      }
    }

    for (const child of el.children) walk(child);
  }

  for (const child of wrapperEl.children) walk(child);

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
            description:
              'The suggested type of the presented content based on the list of elements and a screenshot, e.g., "product card", "article", "profile", "listing item", "gallery", etc. This is a hint for WebMCP toolname generation and can be used in the future for auto-categorization of tools.'
          },
          toolname: {
            type: 'STRING',
            description:
              'The semantic name of the WebMCP tool (e.g., "add-to-cart"). MUST be written in the exact same language as the webpage text.'
          },
          tooldescription: {
            type: 'STRING',
            description:
              'Detailed explanation of what the tool does. MUST be written in the exact same language as the webpage text.'
          }
        },
        required: ['xpath', 'contentType', 'toolname', 'tooldescription']
      },
      elements: {
        type: 'ARRAY',
        description:
          'List of all relevant interactive elements found inside the container (inputs, dropdowns, radio groups, buttons).',
        items: {
          type: 'OBJECT',
          properties: {
            xpath: {
              type: 'STRING',
              description: 'The main XPath of the element or its group container from the input candidate list.'
            },
            toolparamtitle: {
              type: 'STRING',
              description:
                'The visible label or title of the parameter. MUST be in the exact same language as the webpage.'
            },
            toolparamdescription: {
              type: 'STRING',
              description:
                'Explanation of what this parameter controls. MUST be in the exact same language as the webpage.'
            }
          },
          required: ['xpath', 'toolparamtitle', 'toolparamdescription']
        }
      }
    },
    required: ['container', 'elements']
  };
}

function normalizeAiElementTarget(item) {
  if (!item?.xpath) return null;

  const originalEl = getElementByXPath(item.xpath);
  if (!(originalEl instanceof Element)) return null;

  const interactiveEl = resolveInteractiveTarget(originalEl);
  if (!(interactiveEl instanceof Element)) return null;

  return {
    ...item,
    xpath: getXPath(interactiveEl),
    originalXPath: item.xpath
  };
}

function normalizeAiResultTargets(result) {
  if (!result?.container?.xpath || !Array.isArray(result.elements)) return result;

  const normalizedElements = [];
  const seen = new Set();

  for (const item of result.elements) {
    const normalized = normalizeAiElementTarget(item);
    if (!normalized?.xpath) continue;
    if (seen.has(normalized.xpath)) continue;
    seen.add(normalized.xpath);
    normalizedElements.push(normalized);
  }

  return {
    ...result,
    elements: normalizedElements
  };
}

function parseAiResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI response was empty.');
  const parsed = JSON.parse(text);
  if (!parsed?.container || !Array.isArray(parsed.elements)) {
    throw new Error('AI response is missing required fields.');
  }
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
              'You generate a strict WebMCP Tool JSON for one interaction container. Map only actionable interactive controls.',
              '',
              'Rules:',
              '- container.xpath: exactly copy input.containerXPath.',
              '- container.contentType: short type like product_form, checkout_form, configurator.',
              '- container.toolname: lowercase snake_case, action-based, in the webpage language.',
              '- container.tooldescription: short action summary, in the webpage language.',
              '',
              '- elements[] must contain only interactive controls the agent can act on: input, button, select, textarea, actionable a, or explicitly interactive custom controls.',
              '- Never output static text nodes or non-interactive structural elements as parameters.',
              '- Never use li, ul, ol, div, span, label, p, section, article as element xpath unless that exact node is itself interactive via role, tabindex, onclick, aria-pressed, aria-selected, or equivalent semantics.',
              '- CRITICAL EXCEPTION: Product variants (size/color chips) and fulfillment selectors (delivery vs pickup options) are often built using generic tags (div, span, label, li) or anchor links with distinct URLs. If a node visually acts as an option-select control, YOU MUST map its closest clickable element (like the `a` tag or toggle container), even if it triggers navigation or lacks standard ARIA attributes.',
              '- If text is inside a li or wrapper but the real clickable target is a descendant a/button/input/custom control, output the descendant interactive xpath, not the wrapper xpath.',
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
  const aiResult = parseAiResponse(await response.json());
  return normalizeAiResultTargets(aiResult);
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
let widgetSelectedSection = null;
let widgetPayloadSection = null;
let widgetPreparedPayload = null;
let widgetResultSection = null;
let widgetResult = null;
let widgetPickBtn = null;
let widgetRunBtn = null;
let widgetPreviewBtn = null;
let widgetClearBtn = null;
let dragState = null;
let widgetResizeHandlerInstalled = false;

// ─── Annotation state ────────────────────────────────────────────────────────

let annotationVisible = false;
let annotationLayer = null;
let annotationLegend = null;
let annotationLegendList = null;
let annotationLegendFooter = null;
let annotationLegendHeader = null;
let annotationLegendDragHint = null;
let annotationLegendDragState = null;
let annotationNodes = [];
let _anchorSeq = 0;
let annotationLegendResizeHandlerInstalled = false;

// ─── Persistent inject state ─────────────────────────────────────────────────

let markupInjected = false;
let activeSession = null;
let reapplyScheduled = false;
let reapplyTimer = null;
let lastKnownUrl = location.href;
let navigationWatchersInstalled = false;

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
  const selector = Object.values(WEBMCP_ATTRS).map((a) => `[${a}]`).join(',');
  for (const el of root.querySelectorAll(selector)) {
    Object.values(WEBMCP_ATTRS).forEach((a) => el.removeAttribute(a));
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
  if (fromName) {
    return fromName.toLowerCase().replace(/\s+/g, '_').replace(/[^\w.-]/g, '').slice(0, 128);
  }
  const fromTitle = collapseWS(item?.toolparamtitle || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w.-]/g, '')
    .slice(0, 128);

  return fromTitle || `param_${index + 1}`;
}

function shouldEnableAutoSubmit(result) {
  return (result?.elements || []).some((item) => {
    const text = collapseWS(`${item.toolparamtitle || ''} ${item.toolparamdescription || ''}`).toLowerCase();
    return ['add to cart', 'añadir al carrito', 'carrito', 'comprar', 'checkout', 'buy']
      .some((kw) => text.includes(kw));
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

// ─── Session persistence ─────────────────────────────────────────────────────


function clearActiveSessionMemoryOnly() {
  activeSession = null;
  markupInjected = false;
}

function setActiveSessionFromResult(result, { annotationsVisible: visible = false } = {}) {
  if (!result?.container?.xpath) {
    activeSession = null;
    markupInjected = false;
    return;
  }

  activeSession = {
    annotationsVisible: Boolean(visible),
    result
  };
  markupInjected = true;
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

function setAnnotationLegendPos(left, top) {
  if (!annotationLegend) return;

  const margin = 8;
  const w = annotationLegend.offsetWidth || 320;
  const h = annotationLegend.offsetHeight || 240;

  annotationLegend.style.left = `${Math.min(Math.max(left, margin), window.innerWidth - w - margin)}px`;
  annotationLegend.style.top = `${Math.min(Math.max(top, margin), window.innerHeight - h - margin)}px`;
  annotationLegend.style.right = 'auto';
  annotationLegend.style.bottom = 'auto';
}

function handleAnnotationLegendResize() {
  if (!annotationLegend || !document.contains(annotationLegend)) return;
  const r = annotationLegend.getBoundingClientRect();
  setAnnotationLegendPos(r.left, r.top);
}

function ensureAnnotationLegend() {
  if (annotationLegend && document.contains(annotationLegend)) return annotationLegend;

  annotationLegend = document.createElement('aside');
  annotationLegend.id = 'webmcp-annotation-legend';
  annotationLegend.setAttribute('data-webmcp-annotation-legend', 'true');
  annotationLegend.setAttribute('aria-label', 'WebMCP annotation legend');

  const header = document.createElement('div');
  header.className = 'webmcp-annotation-legend-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'webmcp-annotation-legend-title';
  titleEl.textContent = 'Annotation legend';

  const dragHint = document.createElement('div');
  dragHint.className = 'webmcp-annotation-legend-drag-hint';
  dragHint.textContent = 'Drag';

  annotationLegendList = document.createElement('div');
  annotationLegendList.className = 'webmcp-annotation-legend-list';

  header.append(titleEl, dragHint);
  annotationLegend.append(header, annotationLegendList);
  document.body.appendChild(annotationLegend);

  annotationLegendHeader = header;
  annotationLegendDragHint = dragHint;

  const beginDrag = (e) => {
    if (!annotationLegend || e.button !== 0) return;
    if (e.target.closest('button, input, select, textarea, label, a')) return;

    const rect = annotationLegend.getBoundingClientRect();
    setAnnotationLegendPos(rect.left, rect.top);

    annotationLegendDragState = {
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
    if (!annotationLegendDragState || e.pointerId !== annotationLegendDragState.pointerId) return;

    setAnnotationLegendPos(
      annotationLegendDragState.left + e.clientX - annotationLegendDragState.startX,
      annotationLegendDragState.top + e.clientY - annotationLegendDragState.startY
    );
  };

  const endDrag = (e) => {
    if (!annotationLegendDragState || e.pointerId !== annotationLegendDragState.pointerId) return;

    try {
      header.releasePointerCapture(e.pointerId);
    } catch (_) { }

    annotationLegendDragState = null;
    header.classList.remove('is-dragging');
  };

  header.addEventListener('pointerdown', beginDrag);
  header.addEventListener('pointermove', onDragMove);
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  if (!annotationLegendResizeHandlerInstalled) {
    window.addEventListener('resize', handleAnnotationLegendResize);
    annotationLegendResizeHandlerInstalled = true;
  }

  setAnnotationLegendPos(16, 16);
  return annotationLegend;
}

function destroyAnnotationUI() {
  annotationLegendHeader = null;
  annotationLegendDragHint = null;
  annotationLegendDragState = null;

  annotationNodes.forEach((item) => {
    if (item?.targetEl instanceof Element && item._anchorId) {
      item.targetEl.style.anchorName = '';
    }
    item?.box?.remove();
  });
  annotationNodes = [];

  if (annotationLayer) {
    annotationLayer.remove();
    annotationLayer = null;
  }

  if (annotationLegend) {
    annotationLegend.remove();
    annotationLegend = null;
    annotationLegendList = null;
  }

  annotationVisible = false;
  updateActionButtons();
}

function clearInjectedMarkup() {
  clearWebMcpAttributes(document);
  markupInjected = false;
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
  return {
    index,
    tone,
    title: collapseWS(title || String(index)),
    node: getElementMeta(el),
    lines: attrLines
  };
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

// ─── Inject / reapply ────────────────────────────────────────────────────────

function injectMarkupFromResult(result) {
  if (!result?.container?.xpath) {
    return {
      ok: false,
      metadataApplied: false,
      visibleCount: 0,
      containerFound: false,
      message: 'No AI result available for injection.'
    };
  }

  const context = resolveToolContext(result);
  const { containerEl, toolHost, normalizedToolName } = context;
  const declarativeHost = toolHost instanceof HTMLFormElement ? toolHost : null;
  const metadataApplied = declarativeHost
    ? applyToolMetadata(declarativeHost, result, normalizedToolName)
    : false;

  let visibleCount = 0;

  for (const item of result.elements) {
    const rawEl = getElementByXPath(item.xpath);
    const el = resolveInteractiveTarget(rawEl);
    if (!(el instanceof Element)) continue;
    if (!isActuallyInteractiveElement(el)) continue;

    setWebMcpAttribute(el, WEBMCP_ATTRS.paramTitle, item.toolparamtitle);
    setWebMcpAttribute(el, WEBMCP_ATTRS.paramDescription, item.toolparamdescription);

    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) visibleCount += 1;
  }

  markupInjected = true;

  return {
    ok: Boolean(containerEl || visibleCount > 0 || metadataApplied),
    metadataApplied,
    visibleCount,
    containerFound: Boolean(containerEl),
    message: metadataApplied
      ? `Declarative WebMCP markup injected: ${visibleCount} element(s).`
      : 'Parameter markup injected, but no FORM host was found, so declarative tool attributes were skipped.'
  };
}

function buildLegendItemsFromResult(result) {
  const context = resolveToolContext(result);
  const { containerEl, toolHost, normalizedToolName } = context;
  const legendItems = [];
  const declarativeHost = toolHost instanceof HTMLFormElement ? toolHost : null;

  if (containerEl) {
    const rect = containerEl.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      makeAnnotationBox({
        targetEl: containerEl,
        className: 'webmcp-annotation-box webmcp-annotation-container',
        index: 'C',
        tone: 'container'
      });

      const hostForLegend = declarativeHost || containerEl;
      const containerLines = [
        `${WEBMCP_ATTRS.toolName}="${normalizedToolName}"`,
        `${WEBMCP_ATTRS.toolDescription}="${collapseWS(result.container?.tooldescription || '')}"`
      ];

      if (hostForLegend.getAttribute?.(WEBMCP_ATTRS.toolAutoSubmit)) {
        containerLines.push(
          `${WEBMCP_ATTRS.toolAutoSubmit}="${hostForLegend.getAttribute(WEBMCP_ATTRS.toolAutoSubmit)}"`
        );
      }

      legendItems.push(
        buildLegendItem(
          'C',
          'container',
          result.container?.toolname || 'Container',
          hostForLegend,
          containerLines
        )
      );
    }
  }

  let visibleCount = 0;
  for (const item of result.elements || []) {
    const rawEl = getElementByXPath(item.xpath);
    const el = resolveInteractiveTarget(rawEl);
    if (!(el instanceof Element)) continue;
    if (!isActuallyInteractiveElement(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    visibleCount += 1;

    makeAnnotationBox({
      targetEl: el,
      className: 'webmcp-annotation-box webmcp-annotation-element',
      index: String(visibleCount),
      tone: 'element'
    });

    legendItems.push(
      buildLegendItem(
        String(visibleCount),
        'element',
        item.toolparamtitle || `Element ${visibleCount}`,
        el,
        [
          `${WEBMCP_ATTRS.paramTitle}="${collapseWS(item.toolparamtitle || '')}"`,
          `${WEBMCP_ATTRS.paramDescription}="${collapseWS(item.toolparamdescription || '')}"`
        ]
      )
    );
  }

  return { legendItems, visibleCount };
}

function showAnnotationsFromResult(result) {
  destroyAnnotationUI();

  if (!result?.container?.xpath) {
    showStatusLine('No AI result available for preview.');
    return false;
  }

  const { legendItems, visibleCount } = buildLegendItemsFromResult(result);
  renderAnnotationLegend(legendItems);
  annotationVisible = true;
  updateActionButtons();
  return visibleCount >= 0;
}

function hideAnnotations() {
  destroyAnnotationUI();
  if (activeSession) {
    activeSession.annotationsVisible = false;
  }
  showStatusLine('Annotations hidden. Markup remains injected.');
}

function ensureMarkupInjected(result, { persist = true, annotationsVisible: visible = false } = {}) {
  const injectResult = injectMarkupFromResult(result);
  if (!injectResult.ok) return injectResult;

  if (persist) {
    setActiveSessionFromResult(result, { annotationsVisible: visible });
  } else {
    markupInjected = true;
  }

  return injectResult;
}

async function injectAndShowAnnotations(result) {
  const injectResult = ensureMarkupInjected(result, { persist: true, annotationsVisible: true });
  if (!injectResult.ok) {
    showStatusLine(injectResult.message || 'Markup injection failed.');
    return;
  }

  showAnnotationsFromResult(result);
  if (activeSession) {
    activeSession.annotationsVisible = true;
  }
  showStatusLine(injectResult.message);
}

async function toggleAnnotations() {
  if (!lastAiResult && !activeSession?.result) {
    showStatusLine('Run AI first to generate markup.');
    return;
  }

  const result = lastAiResult || activeSession?.result;
  if (!result) {
    showStatusLine('No saved WebMCP session available.');
    return;
  }

  if (!markupInjected) {
    await injectAndShowAnnotations(result);
    return;
  }

  if (annotationVisible) {
    hideAnnotations();
    return;
  }

  showAnnotationsFromResult(result);
  if (activeSession) {
    activeSession.annotationsVisible = true;
  }
  showStatusLine('Annotations shown. Markup remains injected.');
}

async function tryRestoreInjectedSession(reason = 'unknown') {
  const result = activeSession?.result;
  if (!result?.container?.xpath) return false;
  if (pickerActive || aiRunning || captureRunning) return false;

  if (reapplyTimer) {
    clearTimeout(reapplyTimer);
    reapplyTimer = null;
  }
  reapplyScheduled = false;

  const targetsMissing = sessionTargetsMissing(result);

  if (markupInjected && !targetsMissing) {
    if (activeSession?.annotationsVisible) {
      showAnnotationsFromResult(result);
      annotationVisible = true;
    } else {
      destroyAnnotationUI();
      annotationVisible = false;
    }
    updateActionButtons();
    return true;
  }

  destroyAnnotationUI();
  clearInjectedMarkup();

  const injectResult = ensureMarkupInjected(result, {
    persist: false,
    annotationsVisible: Boolean(activeSession?.annotationsVisible),
  });

  if (!injectResult?.ok) {
    annotationVisible = false;
    updateActionButtons();
    return false;
  }

  if (activeSession?.annotationsVisible) {
    showAnnotationsFromResult(result);
    annotationVisible = true;
  } else {
    annotationVisible = false;
  }

  updateActionButtons();
  return true;
}

// ─── Reapply after reload / SPA navigation ───────────────────────────────────

function scheduleSessionReapply(reason = 'unknown', delay = 120) {
  if (!activeSession?.result) return;
  if (reapplyTimer) clearTimeout(reapplyTimer);

  reapplyScheduled = true;
  reapplyTimer = setTimeout(async () => {
    reapplyTimer = null;
    reapplyScheduled = false;
    await tryRestoreInjectedSession(reason);
  }, delay);
}

function isInsideWebMcpUi(node) {
  if (!(node instanceof Element)) return false;

  return Boolean(
    node.closest('[data-webmcp-widget]') ||
    node.closest('[data-webmcp-annotation-layer]') ||
    node.closest('[data-webmcp-annotation-legend]')
  );
}

function getWebMcpAttributeNames() {
  return Object.values(WEBMCP_ATTRS).filter(
    (value) => typeof value === 'string' && value.trim()
  );
}

function isIgnoredMutation(mutation) {
  if (!mutation || typeof mutation !== 'object') return true;

  if (mutation.type === 'attributes') {
    const attrName = typeof mutation.attributeName === 'string' ? mutation.attributeName : '';
    const webMcpAttrs = getWebMcpAttributeNames();

    if (attrName && webMcpAttrs.includes(attrName)) return true;
    return isInsideWebMcpUi(mutation.target);
  }

  const addedNodes = mutation.addedNodes ? Array.from(mutation.addedNodes) : [];
  const removedNodes = mutation.removedNodes ? Array.from(mutation.removedNodes) : [];
  const nodes = [...addedNodes, ...removedNodes];

  if (!nodes.length) {
    return isInsideWebMcpUi(mutation.target);
  }

  return nodes.every((node) => !(node instanceof Element) || isInsideWebMcpUi(node));
}

function sessionTargetsMissing(result) {
  if (!result?.container?.xpath) return false;

  const containerEl = getElementByXPath(result.container.xpath);
  if (!containerEl) return true;

  for (const item of result.elements || []) {
    if (!item?.xpath) continue;
    const el = getElementByXPath(item.xpath);
    if (!el) return true;
  }

  return false;
}

function installNavigationWatchers() {
  if (navigationWatchersInstalled) return;
  navigationWatchersInstalled = true;

  const notifyUrlChange = () => {
    if (location.href === lastKnownUrl) return;
    lastKnownUrl = location.href;
    scheduleSessionReapply('url-change', 180);
  };

  window.addEventListener('popstate', notifyUrlChange, true);
  window.addEventListener('hashchange', notifyUrlChange, true);

  const rawPushState = history.pushState;
  const rawReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const ret = rawPushState.apply(this, args);
    notifyUrlChange();
    return ret;
  };

  history.replaceState = function (...args) {
    const ret = rawReplaceState.apply(this, args);
    notifyUrlChange();
    return ret;
  };

  const observer = new MutationObserver((mutations) => {
    if (!activeSession?.result) return;

    const mutationList = Array.from(mutations || []);
    if (!mutationList.length) return;

    const hasRelevantMutation = mutationList.some((mutation) => {
      try {
        return !isIgnoredMutation(mutation);
      } catch (err) {
        console.warn('WebMCP mutation filter failed:', err, mutation);
        return false;
      }
    });

    if (!hasRelevantMutation) return;
    if (!sessionTargetsMissing(activeSession.result)) return;

    scheduleSessionReapply('dom-mutation', 220);
  });

  observer.observe(document.documentElement || document, {
    childList: true,
    subtree: true,
    attributes: true,
  });
}


// ─── Widget helpers ──────────────────────────────────────────────────────────

function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value.trim()) return Promise.resolve(false);
  return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
}

function flashCopyButton(btn) {
  if (!(btn instanceof HTMLButtonElement)) return;
  const original = btn.textContent || 'Copy';
  btn.textContent = 'Copied';
  btn.classList.add('is-copied');
  window.setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('is-copied');
  }, 1200);
}

function createCopyableBlock(contentEl, getText) {
  const wrap = document.createElement('div');
  wrap.className = 'webmcp-copyable';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'webmcp-btn-copy-mini';
  btn.textContent = 'Copy';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyTextToClipboard(getText());
    if (ok) flashCopyButton(btn);
  });

  wrap.append(contentEl, btn);
  return wrap;
}

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
    ? `${selectedWrapperXPath}`
    : 'Wrapper not selected. Click "Pick wrapper" to select a wrapper element on the page.';
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
    const canPreview = Boolean((lastAiResult || activeSession?.result) && !busy && !pickerActive);
    widgetPreviewBtn.disabled = !canPreview;
    widgetPreviewBtn.classList.toggle('is-disabled', widgetPreviewBtn.disabled);

    if (!markupInjected) {
      widgetPreviewBtn.textContent = 'Inject Markup';
    } else {
      widgetPreviewBtn.textContent = annotationVisible ? 'Hide Annotations' : 'Show Annotations';
    }
  }

  if (widgetClearBtn) {
    widgetClearBtn.disabled = busy || (!selectedWrapperEl && !lastAiResult && !activeSession && !annotationVisible && !markupInjected);
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
}

function clearSelectionState() {
  selectedWrapperEl = null;
  selectedWrapperXPath = null;
  selectedWrapperRect = null;
}

async function resetWidgetState() {
  if (aiRunning || captureRunning) return;

  stopPicker();
  destroyAnnotationUI();
  clearInjectedMarkup();
  clearActiveSessionMemoryOnly();

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
    pickerLabel.textContent = `${el.tagName.toLowerCase()} • ${Math.round(rect.width)}×${Math.round(rect.height)} • ${el.children.length} children`;
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

  destroyAnnotationUI();
  clearInjectedMarkup();
  clearActiveSessionMemoryOnly();

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
  destroyAnnotationUI();
  clearInjectedMarkup();
  clearActiveSessionMemoryOnly();
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

function handleWidgetResize() {
  if (!widgetRoot || !document.contains(widgetRoot)) return;
  const r = widgetRoot.getBoundingClientRect();
  setWidgetPos(r.left, r.top);
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
  widgetInstructions.textContent = 'Select a wrapper to collect data, run AI, then inject the suggested WebMCP markup.';

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

  widgetSelectedSection = document.createElement('section');
  widgetSelectedSection.className = 'webmcp-widget-section';

  const selectedTitle = document.createElement('div');
  selectedTitle.className = 'webmcp-widget-section-title';
  selectedTitle.textContent = 'Selected wrapper';

  widgetSelection = document.createElement('pre');
  widgetSelection.className = 'webmcp-widget-selection';

  const widgetSelectionWrap = createCopyableBlock(
    widgetSelection,
    () => widgetSelection?.textContent || ''
  );

  widgetSelectedSection.append(selectedTitle, widgetSelectionWrap);

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

  const widgetPreparedPayloadWrap = createCopyableBlock(
    widgetPreparedPayload,
    () => widgetPreparedPayload?.textContent || ''
  );

  widgetPayloadSection.append(payloadTitle, widgetPreparedPayloadWrap);

  widgetResultSection = document.createElement('section');
  widgetResultSection.className = 'webmcp-widget-section webmcp-hidden';

  const resultTitle = document.createElement('div');
  resultTitle.className = 'webmcp-widget-section-title';
  resultTitle.textContent = 'AI result';

  widgetResult = document.createElement('pre');
  widgetResult.className = 'webmcp-widget-code';

  const widgetResultWrap = createCopyableBlock(
    widgetResult,
    () => widgetResult?.textContent || ''
  );

  widgetResultSection.append(resultTitle, widgetResultWrap);

  widgetRoot.append(
    header,
    widgetInstructions,
    controls,
    widgetSelectedSection,
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

  if (!widgetResizeHandlerInstalled) {
    window.addEventListener('resize', handleWidgetResize);
    widgetResizeHandlerInstalled = true;
  }

  widgetRoot.classList.remove('webmcp-hidden');
  setWidgetPos(window.innerWidth - 380, 16);
  updateSelectionText();

  if (lastAiResult) {
    setResultText(JSON.stringify(lastAiResult, null, 2));
  }

  updateActionButtons();
  return widgetRoot;
}

function initEmbeddedWidget() {
  if (!IS_TOP_WINDOW) return;

  const mount = async () => {
    try {
      ensureWidget();
      installNavigationWatchers();
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
      toggleAnnotations()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

    case 'clearWrapperAnnotations':
      resetWidgetState()
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;

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

        widget.classList.toggle('webmcp-hidden');

        sendResponse({ success: true });
        return true;
      }

      sendResponse({ success: false, error: `Unknown action: ${request.action}` });
      break;
  }

  return true;
});