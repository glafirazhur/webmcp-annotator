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

function getExplicitLabel(el) {
  if (!(el instanceof Element)) return '';
  return el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    el.getAttribute('placeholder') ||
    '';
}

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

  const attrLabel = getExplicitLabel(control);
  if (attrLabel) out.push(truncate(attrLabel, 80));

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
    getExplicitLabel(target) ||
    target.innerText ||
    target.textContent ||
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

  const labelText = labels[0] || getExplicitLabel(targetEl);

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

async function callAi({ screenshot, payload }) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'runAiAnalysis', screenshot, payload },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || response.success === false) {
          reject(new Error(response?.error || 'Unknown background error during AI analysis.'));
          return;
        }
        try {
          // Возвращаем результат, прогнав его через DOM-зависимый нормализатор
          const normalized = normalizeAiResultTargets(response.result);
          resolve(normalized);
        } catch (err) {
          reject(err);
        }
      }
    );
  });
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
let widgetCollapsed = true;
let widgetCollapseBtn = null;
let widgetBody = null;
const WIDGET_TOP_OFFSET = 16;
const WIDGET_RIGHT_OFFSET = 36;

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

  const modelLabel = await new Promise((resolve) => {
    chrome.storage.local.get(['settings_model'], (result) => {
      const raw = String(result.settings_model || 'gemini-3.5-flash');
      resolve(raw.replace(/^models\//, '').trim());
    });
  });
  showStatusLine(`Running AI with ${modelLabel}…`);

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
  requestAnimationFrame(() => {
    const width = widgetRoot.offsetWidth || 340;
    setWidgetPos(window.innerWidth - width - WIDGET_RIGHT_OFFSET, WIDGET_TOP_OFFSET);
  });
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

  widgetCollapseBtn = document.createElement('button');
  widgetCollapseBtn.type = 'button';
  widgetCollapseBtn.className = 'webmcp-btn-collapse';
  widgetCollapseBtn.setAttribute('aria-label', 'Collapse widget');
  widgetCollapseBtn.setAttribute('title', 'Collapse widget');
  widgetCollapseBtn.textContent = '−';

  header.append(titleEl, widgetClearBtn, dragHint, widgetCollapseBtn);

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

  widgetBody = document.createElement('div');
  widgetBody.className = 'webmcp-widget-body';
  widgetBody.append(
    header,
    widgetInstructions,
    controls,
    widgetSelectedSection,
    widgetStatusLine,
    widgetScreenshotSection,
    widgetPayloadSection,
    widgetResultSection
  );
  widgetRoot.appendChild(widgetBody);

  const collapsedBadge = document.createElement('button');
  collapsedBadge.type = 'button';
  collapsedBadge.className = 'webmcp-collapsed-badge';

  const badgeIcon = document.createElement('div');
  badgeIcon.role = 'image';
  badgeIcon.alt = 'WebMCP Annotator icon';
  badgeIcon.className = 'webmcp-badge-icon';
  badgeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="20" height="20">
  <defs>
    <linearGradient id="webMCPGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00F2FE" />
      <stop offset="100%" stop-color="#4FACFE" />
    </linearGradient>
  </defs>
  <path d="M 38 22 L 20 22 L 20 106 L 38 106" fill="none" stroke="url(#webMCPGlow)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 90 22 L 108 22 L 108 106 L 90 106" fill="none" stroke="url(#webMCPGlow)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M 64 28 Q 64 64 28 64 Q 64 64 64 100 Q 64 64 100 64 Q 64 64 64 28 Z" fill="#00F2FE" />
  <circle cx="64" cy="64" r="6" fill="#FFFFFF" />
</svg>
`;

  const badgeLabel = document.createElement('span');
  badgeLabel.className = 'webmcp-badge-label';
  badgeLabel.textContent = 'Open WebMCP Annotator';

  collapsedBadge.append(badgeIcon, badgeLabel);
  widgetRoot.appendChild(collapsedBadge);

  const mountTarget = document.body || document.documentElement;
  mountTarget.appendChild(widgetRoot);

  // ── Collapse / expand logic ──────────────────────────────────────────────────

  function pinWidgetTopRight() {
    setWidgetPos(
      window.innerWidth - widgetRoot.offsetWidth - WIDGET_RIGHT_OFFSET,
      WIDGET_TOP_OFFSET
    );
  }

  function applyCollapseState() {
    if (widgetCollapsed) {
      widgetBody.classList.add('webmcp-hidden');
      collapsedBadge.classList.remove('webmcp-hidden');
      widgetRoot.classList.add('webmcp-is-collapsed');
    } else {
      widgetBody.classList.remove('webmcp-hidden');
      collapsedBadge.classList.add('webmcp-hidden');
      widgetRoot.classList.remove('webmcp-is-collapsed');
    }
  }

  widgetCollapseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    widgetCollapsed = true;
    applyCollapseState();

    requestAnimationFrame(() => {
      pinWidgetTopRight();
    });
  });

  collapsedBadge.addEventListener('click', () => {
    widgetCollapsed = false;
    applyCollapseState();

    requestAnimationFrame(() => {
      pinWidgetTopRight();
    });
  });

  applyCollapseState();

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
  requestAnimationFrame(() => {
    pinWidgetTopRight();
  });
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