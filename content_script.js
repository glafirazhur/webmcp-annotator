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
  if (!(el instanceof Element)) return false;
  if (el.hidden) return true;
  if (el instanceof HTMLInputElement && el.type === 'hidden') return true;
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
  return (
    el.tagName === 'LABEL' &&
    Boolean(el.hasAttribute('for') || el.closest('fieldset, [class*="option"], [class*="variant"], [class*="swatch"], [class*="selector"]'))
  );
}

function isNativeInteractiveElement(el) {
  return el instanceof Element && CONTROL_TAGS.has(el.tagName);
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

function getAccessibleName(el) {
  if (!(el instanceof Element)) return '';

  if (typeof el.computedName === 'string' && el.computedName.trim()) {
    return truncate(el.computedName, 80);
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .map(collapseWS)
      .filter(Boolean);
    if (parts.length) return truncate(parts.join(' '), 80);
  }

  const ariaLabel = collapseWS(el.getAttribute('aria-label') || '');
  if (ariaLabel) return truncate(ariaLabel, 80);

  if (el.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = collapseWS(lbl?.textContent || '');
    if (text) return truncate(text, 80);
  }

  const parentLabel = el.closest('label');
  if (parentLabel) {
    const text = collapseWS(parentLabel.textContent || '');
    if (text) return truncate(text, 80);
  }

  const placeholder = collapseWS(el.getAttribute('placeholder') || '');
  if (placeholder) return truncate(placeholder, 80);

  const title = collapseWS(el.getAttribute('title') || '');
  if (title) return truncate(title, 80);

  if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'LABEL' || el.hasAttribute('role')) {
    const text = collapseWS(el.innerText || el.textContent || '');
    if (text) return truncate(text, 80);
  }

  return '';
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

  const options = group.querySelectorAll('a[href], button, input, label, [role="option"], [role="radio"], [role="tab"]');
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
  return Boolean(s) && s.length <= 60;
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

  return optionRole || (withinOptionishContainer && (stateful || (siblingCount >= 2 && looksLikeVariantValue)));
}

function getOptionLikeMeta(el) {
  const target = resolveInteractiveTarget(el);
  if (!(target instanceof Element)) return { optionLike: false };

  const parentLi = target.closest('li');
  const group = getOptionGroupContainer(target);

  const accessibleName = getAccessibleName(target);
  const ownText = collapseWS(
    accessibleName ||
    (target instanceof HTMLInputElement ? target.value : '') ||
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

function isCandidateControl(el) {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  if (CONTROL_TAGS.has(tag)) return true;
  if (tag === 'A') return Boolean(el.getAttribute('href')) || el.hasAttribute('role') || isOptionLikeLink(el);
  if (tag === 'LABEL') return true;
  return isCustomControl(el);
}

function buildCandidate(el, kind) {
  const sourceEl = el;
  const targetEl = kind === 'control' ? (resolveInteractiveTarget(el) || el) : el;
  if (!(targetEl instanceof Element)) return null;

  const node = {
    xpath: getXPath(targetEl),
    tagName: targetEl.tagName.toLowerCase(),
    kind
  };

  if (targetEl.getAttribute('type')) node.type = targetEl.getAttribute('type');
  if (isHidden(targetEl)) node.hiddenInDom = true;

  const accessibleName = kind === 'control' ? getAccessibleName(targetEl) : '';
  if (kind === 'control') {
    const nameAttr = collapseWS(targetEl.getAttribute('name') || '');
    if (nameAttr) node.name = nameAttr;
    if (accessibleName) node.accessibleName = accessibleName;
  }

  const rawText = kind === 'control'
    ? truncate(targetEl.innerText || targetEl.value || '', 120)
    : truncate(targetEl.innerText || targetEl.textContent || '', 200);

  const merged = collapseWS(
    rawText && accessibleName && rawText.toLowerCase() !== accessibleName.toLowerCase()
      ? `${rawText} — ${accessibleName}`
      : (rawText || accessibleName || '')
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
    return !((el.tagName === 'LI' || el.tagName === 'UL' || el.tagName === 'OL') && containsOptionLikeLink(el));
  }

  function walk(el) {
    if (!(el instanceof Element) || SKIP_TAGS.has(el.tagName)) return;

    if (isCandidateControl(el)) {
      const cand = buildCandidate(el, 'control');
      if (cand) pushUnique(controls, cand);
      if (el.children.length > 0 && el.tagName !== 'SELECT') {
        for (const child of el.children) walk(child);
      }
      return;
    }

    if (isHidden(el)) return;

    if (TEXT_TAGS.has(el.tagName) && shouldKeepTextBlock(el)) {
      const text = truncate(el.innerText || el.textContent, 200);
      if (text && collapseWS(text).length > 0) {
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
  if (!result?.container?.xpath) return result;

  const normalizedElements = [];
  const normalizedPossible = [];
  const seen = new Set();

  if (Array.isArray(result.elements)) {
    for (const item of result.elements) {
      const normalized = normalizeAiElementTarget(item);
      if (!normalized?.xpath) continue;
      if (seen.has(normalized.xpath)) continue;
      seen.add(normalized.xpath);
      normalizedElements.push(normalized);
    }
  }

  if (Array.isArray(result.possibleCandidates)) {
    for (const item of result.possibleCandidates) {
      const normalized = normalizeAiElementTarget(item);
      if (!normalized?.xpath) continue;
      if (seen.has(normalized.xpath)) continue;
      seen.add(normalized.xpath);
      normalizedPossible.push(normalized);
    }
  }

  const draftResult = {
    ...result,
    elements: normalizedElements,
    possibleCandidates: normalizedPossible
  };

  const toolHost = resolveWebMcpToolHost(draftResult);
  const resolvedContainerXPath = toolHost instanceof Element ? getXPath(toolHost) : result.container.xpath;

  const isInsideHost = (item) => {
    if (!(toolHost instanceof Element)) return true;
    const el = getElementByXPath(item?.xpath);
    return Boolean(el instanceof Element && toolHost.contains(el));
  };

  return {
    ...draftResult,
    container: {
      ...result.container,
      xpath: resolvedContainerXPath
    },
    elements: normalizedElements.filter(isInsideHost),
    possibleCandidates: normalizedPossible.filter(isInsideHost)
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
          // Normalize AI result targets against the live DOM
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
let webmcpHost = null;
let webmcpShadow = null;
let widgetMount = null;
let overlayMount = null;
let legendMount = null;
let widgetLauncher = null;
let widgetLauncherLabel = null;
const WIDGET_TOP_OFFSET = 16;
const WIDGET_RIGHT_OFFSET = 36;

// ─── Annotation state ────────────────────────────────────────────────────────

let annotationVisible = false;
let annotationLayer = null;
let annotationLegend = null;
let annotationLegendList = null;
let annotationLegendDragState = null;
let annotationNodes = [];
let annotationLegendResizeHandlerInstalled = false;
let annotationSyncRaf = 0;
let annotationViewportSyncInstalled = false;

// ─── Persistent inject state ─────────────────────────────────────────────────

let markupInjected = false;
let activeSession = null;
let reapplyTimer = null;
let lastKnownUrl = location.href;
let navigationWatchersInstalled = false;

// ─── WEBMCP attribute helpers ────────────────────────────────────────────────

const WEBMCP_ATTRS = {
  toolName: 'toolname',
  toolDescription: 'tooldescription',
  toolAutoSubmit: 'toolautosubmit',
  paramDescription: 'toolparamdescription'
};

const LEGACY_WEBMCP_ATTRS = ['toolparamtitle'];

function setWebMcpAttribute(el, name, value) {
  if (!(el instanceof Element) || !name) return;
  const normalized = collapseWS(value || '');
  if (!normalized) return;
  el.setAttribute(name, normalized);
}

function clearWebMcpAttributes(root = document) {
  const allAttrs = [...Object.values(WEBMCP_ATTRS), ...LEGACY_WEBMCP_ATTRS];
  const selector = allAttrs.map((a) => `[${a}]`).join(',');
  for (const el of root.querySelectorAll(selector)) {
    allAttrs.forEach((a) => el.removeAttribute(a));
  }
}

function getElementMeta(el, includeParamIdentity = false) {
  if (!(el instanceof Element)) return '';
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type');
  const baseTag = type ? `${tag}[type="${type}"]` : tag;

  if (!includeParamIdentity) return baseTag;

  const nameAttr = collapseWS(el.getAttribute('name') || '');
  const accessibleName = getAccessibleName(el);

  const namePart = nameAttr ? `name="${nameAttr}"` : 'name: none';
  const accPart = accessibleName
    ? `accessibleName="${truncate(accessibleName, 40)}"`
    : 'accessibleName: none (inferred from UI)';

  return `${baseTag} • ${namePart} • ${accPart}`;
}

function getDisplayLabelForElement(el, fallback) {
  if (el instanceof Element) {
    const accessibleName = getAccessibleName(el);
    if (accessibleName) return truncate(accessibleName, 50);
    const nameAttr = collapseWS(el.getAttribute('name') || '');
    if (nameAttr) return truncate(nameAttr, 50);
    const ownText = collapseWS(
      (el instanceof HTMLInputElement ? el.value : '') ||
      el.innerText ||
      el.textContent ||
      ''
    );
    if (ownText) return truncate(ownText, 50);
  }
  return fallback;
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

function resolveWebMcpToolHost(result) {
  const originalWrapper =
    selectedWrapperEl instanceof Element
      ? selectedWrapperEl
      : getElementByXPath(selectedWrapperXPath || result?.container?.xpath);

  if (!(originalWrapper instanceof Element)) return null;

  const domElements = [
    ...(result?.elements || []),
    ...(result?.possibleCandidates || [])
  ]
    .map((item) => getElementByXPath(item?.xpath))
    .map((el) => resolveInteractiveTarget(el) || el)
    .filter((el) => el instanceof Element && originalWrapper.contains(el));

  if (domElements.length === 0) {
    return originalWrapper;
  }

  if (originalWrapper.tagName === 'FORM') {
    return originalWrapper;
  }

  const forms = Array.from(originalWrapper.querySelectorAll('form'));
  for (const form of forms) {
    if (domElements.every((el) => form.contains(el))) {
      return form;
    }
  }

  let lca = domElements[0];
  for (let i = 1; i < domElements.length; i++) {
    while (lca && !lca.contains(domElements[i])) {
      lca = lca.parentElement;
    }
  }

  if (!(lca instanceof Element) || !originalWrapper.contains(lca)) {
    return originalWrapper;
  }

  const closestForm = lca.closest('form');
  if (closestForm && originalWrapper.contains(closestForm)) {
    return closestForm;
  }

  let best = lca;
  while (best && best !== originalWrapper) {
    if (best.tagName === 'FORM' || best.tagName === 'DIV') {
      return best;
    }
    best = best.parentElement;
  }

  return originalWrapper;
}

function resolveToolContext(result) {
  const containerEl = getElementByXPath(result?.container?.xpath);
  const toolHost = resolveWebMcpToolHost(result);
  const normalizedToolName = normalizeToolName(result?.container?.toolname);

  return { containerEl, toolHost, normalizedToolName };
}

function applyToolMetadata(host, result, normalizedToolName) {
  if (!(host instanceof Element)) return false;

  setWebMcpAttribute(host, WEBMCP_ATTRS.toolName, normalizedToolName);
  setWebMcpAttribute(host, WEBMCP_ATTRS.toolDescription, result?.container?.tooldescription || '');
  if (result?.container?.toolautosubmit) {
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

function ensureShadowRoot() {
  if (webmcpShadow && webmcpHost && webmcpHost.isConnected) return webmcpShadow;

  webmcpHost = document.createElement('div');
  webmcpHost.id = 'webmcp-shadow-host';
  webmcpHost.style.position = 'fixed';
  webmcpHost.style.inset = '0';
  webmcpHost.style.pointerEvents = 'none';
  webmcpHost.style.zIndex = '2147483647';
  webmcpHost.style.background = 'transparent';

  (document.documentElement || document.body || document).appendChild(webmcpHost);

  webmcpShadow = webmcpHost.attachShadow({ mode: 'open' });

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('widget.css');

  const root = document.createElement('div');
  root.id = 'webmcp-shadow-root';
  root.innerHTML = `
    <div id="webmcp-overlay-mount"></div>
    <div id="webmcp-legend-mount"></div>
    <div id="webmcp-widget-mount"></div>
  `;

  webmcpShadow.append(link, root);

  widgetMount = root.querySelector('#webmcp-widget-mount');
  overlayMount = root.querySelector('#webmcp-overlay-mount');
  legendMount = root.querySelector('#webmcp-legend-mount');

  overlayMount.style.pointerEvents = 'none';
  widgetMount.style.pointerEvents = 'none';
  legendMount.style.pointerEvents = 'none';

  return webmcpShadow;
}

function isInShadowUi(node) {
  if (!(node instanceof Node)) return false;
  const root = node.getRootNode?.();
  return Boolean(root && webmcpShadow && root === webmcpShadow);
}


function ensureAnnotationLayer() {
  if (annotationLayer && document.contains(annotationLayer)) return annotationLayer;
  annotationLayer = document.createElement('div');
  annotationLayer.id = 'webmcp-annotation-layer';
  annotationLayer.setAttribute('data-webmcp-annotation-layer', 'true');
  overlayMount.appendChild(annotationLayer);
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
  if (!annotationLegend || !annotationLegend.isConnected) return;
  const r = annotationLegend.getBoundingClientRect();
  setAnnotationLegendPos(r.left, r.top);
}

function ensureAnnotationLegend() {
  ensureShadowRoot();
  if (annotationLegend && annotationLegend.isConnected) return annotationLegend;

  annotationLegend = document.createElement('aside');
  annotationLegend.id = 'webmcp-annotation-legend';
  annotationLegend.setAttribute('data-webmcp-annotation-legend', 'true');
  annotationLegend.setAttribute('aria-label', 'WebMCP annotation legend');
  annotationLayer.style.pointerEvents = 'none';

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
  legendMount.appendChild(annotationLegend);

  annotationLegend.style.pointerEvents = 'auto';

  let annotationLegendDragRaf = 0;

  function flushAnnotationLegendDrag() {
    annotationLegendDragRaf = 0;
    if (!annotationLegendDragState || !annotationLegend) return;

    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - annotationLegendDragState.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - annotationLegendDragState.height - margin);

    const clampedLeft = Math.min(Math.max(annotationLegendDragState.nextLeft, margin), maxLeft);
    const clampedTop = Math.min(Math.max(annotationLegendDragState.nextTop, margin), maxTop);

    annotationLegend.style.left = `${clampedLeft}px`;
    annotationLegend.style.top = `${clampedTop}px`;
    annotationLegend.style.right = "auto";
    annotationLegend.style.bottom = "auto";
  }

  const beginDrag = (e) => {
    if (!annotationLegend || e.button !== 0) return;
    if (e.target.closest("button, input, select, textarea, label, a")) return;

    const rect = annotationLegend.getBoundingClientRect();

    annotationLegendDragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      nextLeft: rect.left,
      nextTop: rect.top
    };

    header.classList.add("is-dragging");
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onDragMove = (e) => {
    if (!annotationLegendDragState || e.pointerId !== annotationLegendDragState.pointerId) return;

    annotationLegendDragState.nextLeft = annotationLegendDragState.left + (e.clientX - annotationLegendDragState.startX);
    annotationLegendDragState.nextTop = annotationLegendDragState.top + (e.clientY - annotationLegendDragState.startY);

    if (!annotationLegendDragRaf) {
      annotationLegendDragRaf = requestAnimationFrame(flushAnnotationLegendDrag);
    }
  };

  const endDrag = (e) => {
    if (!annotationLegendDragState || e.pointerId !== annotationLegendDragState.pointerId) return;

    try {
      header.releasePointerCapture(e.pointerId);
    } catch { }

    if (annotationLegendDragRaf) {
      cancelAnimationFrame(annotationLegendDragRaf);
      annotationLegendDragRaf = 0;
    }

    flushAnnotationLegendDrag();
    annotationLegendDragState = null;
    header.classList.remove("is-dragging");
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
  if (annotationSyncRaf) {
    cancelAnimationFrame(annotationSyncRaf);
    annotationSyncRaf = 0;
  }

  annotationLegendDragState = null;

  annotationNodes.forEach((item) => {
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

function makeAnnotationBox({
  targetEl,
  className,
  index,
  tone = 'element',
  expand = 0
} = {}) {
  if (!(targetEl instanceof Element)) return null;

  const rect = targetEl.getBoundingClientRect();
  const box = document.createElement('div');
  box.className = className;

  const top = rect.top - expand;
  const left = rect.left - expand;
  const width = Math.max(rect.width + expand * 2, 18);
  const height = Math.max(rect.height + expand * 2, 18);

  box.style.top = `${top}px`;
  box.style.left = `${left}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;

  const badge = document.createElement('div');
  badge.className = `webmcp-annotation-badge webmcp-annotation-badge-${tone}`;
  badge.textContent = String(index);
  box.appendChild(badge);

  ensureAnnotationLayer().appendChild(box);
  annotationLayer.style.pointerEvents = 'none';

  const item = { box, badge, targetEl, expand };
  annotationNodes.push(item);
  return item;
}

function repositionAnnotationBoxes() {
  if (!annotationVisible || !annotationNodes.length) return;

  for (const item of annotationNodes) {
    if (!(item?.targetEl instanceof Element) || !(item?.box instanceof HTMLElement)) continue;

    const rect = item.targetEl.getBoundingClientRect();
    const expand = Number.isFinite(item.expand) ? item.expand : 5;

    if (rect.width <= 0 || rect.height <= 0) {
      item.box.style.display = "none";
      continue;
    }

    item.box.style.display = "";
    item.box.style.top = `${rect.top - expand}px`;
    item.box.style.left = `${rect.left - expand}px`;
    item.box.style.width = `${Math.max(rect.width + expand * 2, 18)}px`;
    item.box.style.height = `${Math.max(rect.height + expand * 2, 18)}px`;
  }
}
function scheduleAnnotationReposition() {
  if (!annotationVisible) return;
  if (annotationSyncRaf) return;

  annotationSyncRaf = requestAnimationFrame(() => {
    annotationSyncRaf = 0;
    repositionAnnotationBoxes();
  });
}

function installAnnotationViewportSync() {
  if (annotationViewportSyncInstalled) return;
  annotationViewportSyncInstalled = true;

  window.addEventListener("scroll", scheduleAnnotationReposition, true);
  window.addEventListener("resize", scheduleAnnotationReposition, true);
}

function buildLegendItem(index, tone, title, el, attrLines) {
  return {
    index,
    tone,
    title: collapseWS(title || String(index)),
    node: getElementMeta(el, tone !== 'container'),
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
  const declarativeHost = toolHost instanceof Element ? toolHost : null;
  const metadataApplied = declarativeHost
    ? applyToolMetadata(declarativeHost, result, normalizedToolName)
    : false;

  let visibleCount = 0;

  for (const item of result.elements) {
    const rawEl = getElementByXPath(item.xpath);
    const el = resolveInteractiveTarget(rawEl);
    if (!(el instanceof Element)) continue;
    if (!isActuallyInteractiveElement(el)) continue;

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
      : 'Parameter markup injected, but no eligible host element was found inside the original wrapper.'
  };
}

function buildLegendItemsFromResult(result) {
  const context = resolveToolContext(result);
  const { containerEl, toolHost, normalizedToolName } = context;
  const legendItems = [];
  const declarativeHost = toolHost instanceof Element ? toolHost : null;
  const hostForLegend = declarativeHost || containerEl || null;

  if (hostForLegend instanceof Element) {
    const rect = hostForLegend.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      makeAnnotationBox({
        targetEl: hostForLegend,
        className: 'webmcp-annotation-box webmcp-annotation-container',
        index: 'C',
        tone: 'container',
        expand: 15
      });

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
    const el = resolveInteractiveTarget(rawEl) || rawEl;
    if (!(el instanceof Element)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    visibleCount += 1;

    makeAnnotationBox({
      targetEl: el,
      className: 'webmcp-annotation-box webmcp-annotation-element',
      index: String(visibleCount),
      tone: 'element',
      expand: 0
    });

    legendItems.push(
      buildLegendItem(
        String(visibleCount),
        'element',
        getDisplayLabelForElement(el, `Element ${visibleCount}`),
        el,
        [
          `${WEBMCP_ATTRS.paramDescription}="${collapseWS(item.toolparamdescription || '')}"`
        ]
      )
    );
  }

  let possibleCount = 0;
  for (const item of result.possibleCandidates || []) {
    const rawEl = getElementByXPath(item.xpath);
    const el = resolveInteractiveTarget(rawEl) || rawEl;
    if (!(el instanceof Element)) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    possibleCount += 1;
    const badgeLabel = `P${possibleCount}`;

    makeAnnotationBox({
      targetEl: el,
      className: 'webmcp-annotation-box webmcp-annotation-possible',
      index: badgeLabel,
      tone: 'possible',
      expand: 0
    });

    legendItems.push(
      buildLegendItem(
        badgeLabel,
        'possible',
        `${getDisplayLabelForElement(el, `Candidate ${possibleCount}`)} (Suggested)`,
        el,
        [
          collapseWS(item.reason || 'Possible candidate — Non-declarative control'),
          `${WEBMCP_ATTRS.paramDescription}="${collapseWS(item.toolparamdescription || '')}"`
        ]
      )
    );
  }

  return { legendItems, visibleCount: visibleCount + possibleCount };
}

function showAnnotationsFromResult(result) {
  destroyAnnotationUI();

  if (!result?.container?.xpath) {
    showStatusLine("No AI result available for preview.");
    return false;
  }

  const { legendItems, visibleCount } = buildLegendItemsFromResult(result);
  renderAnnotationLegend(legendItems);
  annotationVisible = true;
  repositionAnnotationBoxes();
  updateActionButtons();

  return visibleCount > 0;
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

async function tryRestoreInjectedSession() {
  const result = activeSession?.result;
  if (!result?.container?.xpath) return false;
  if (pickerActive || aiRunning || captureRunning) return false;

  if (reapplyTimer) {
    clearTimeout(reapplyTimer);
    reapplyTimer = null;
  }

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

function scheduleSessionReapply(delay = 120) {
  if (!activeSession?.result) return;
  if (reapplyTimer) clearTimeout(reapplyTimer);

  reapplyTimer = setTimeout(async () => {
    reapplyTimer = null;
    await tryRestoreInjectedSession();
  }, delay);
}

function isInsideWebMcpUi(node) {
  if (!(node instanceof Element)) return false;
  if (isInShadowUi(node)) return true;
  return Boolean(
    node.closest('[data-webmcp-widget]') ||
    node.closest('[data-webmcp-launcher]') ||
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

  for (const item of result.possibleCandidates || []) {
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
    scheduleSessionReapply(180);
  };

  window.addEventListener('popstate', notifyUrlChange, true);
  window.addEventListener('hashchange', notifyUrlChange, true);

  const rawPushState = history.pushState;
  const rawReplaceState = history.replaceState;

  history.pushState = function (...args) {
    rawPushState.apply(this, args);
    notifyUrlChange();
  };

  history.replaceState = function (...args) {
    rawReplaceState.apply(this, args);
    notifyUrlChange();
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

    scheduleSessionReapply(220);
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
      widgetPreviewBtn.textContent = annotationVisible ? 'Hide Elements' : 'Show Elements';
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
  ensureShadowRoot();
  overlayMount.appendChild(pickerOverlay);
  return pickerOverlay;
}

function positionOverlay(el) {
  if (!pickerOverlay || !(el instanceof Element)) return;

  const rect = el.getBoundingClientRect();

  pickerOverlay.style.width = `${rect.width}px`;
  pickerOverlay.style.height = `${rect.height}px`;
  pickerOverlay.style.top = `${rect.top}px`;
  pickerOverlay.style.left = `${rect.left}px`;

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

  const stored = await chrome.storage.local.get({ settings_model: 'gemini-3.5-flash' });
  const modelLabel = String(stored.settings_model || 'gemini-3.5-flash').replace(/^models\//, '').trim();
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

function pinWidgetTopRight() {
  if (!widgetRoot || !widgetRoot.isConnected) return;

  setWidgetPos(
    window.innerWidth - widgetRoot.offsetWidth - WIDGET_RIGHT_OFFSET,
    WIDGET_TOP_OFFSET
  );
}

function pinLauncherTopRight() {
  if (!widgetLauncher || !widgetLauncher.isConnected) return;

  widgetLauncher.style.top = `${WIDGET_TOP_OFFSET}px`;
  widgetLauncher.style.right = `${WIDGET_RIGHT_OFFSET}px`;
  widgetLauncher.style.left = 'auto';
  widgetLauncher.style.bottom = 'auto';
}

function handleWidgetResize() {
  requestAnimationFrame(() => {
    if (widgetRoot && widgetRoot.isConnected && !widgetCollapsed) {
      pinWidgetTopRight();
    }

    if (widgetLauncher && widgetLauncher.isConnected && widgetCollapsed) {
      pinLauncherTopRight();
    }
  });
}

function ensureWidget() {
  if (!IS_TOP_WINDOW) return null;
  if (widgetRoot && widgetRoot.isConnected) return widgetRoot;

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

  widgetLauncher = document.createElement('button');
  widgetLauncher.type = 'button';
  widgetLauncher.id = 'webmcp-widget-launcher';
  widgetLauncher.className = 'webmcp-collapsed-badge';
  widgetLauncher.setAttribute('data-webmcp-launcher', 'true');
  widgetLauncher.setAttribute('aria-label', 'Open WebMCP Annotator');
  widgetLauncher.setAttribute('title', 'Open WebMCP Annotator');

  const badgeIcon = document.createElement('div');
  badgeIcon.role = 'img';
  badgeIcon.ariaLabel = 'WebMCP Annotator icon';
  badgeIcon.className = 'webmcp-badge-icon';
  badgeIcon.innerHTML = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="20" height="20">
    <defs>
      <linearGradient id="webMCPGlow" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#00F2FE" />
        <stop offset="100%" stop-color="#4FACFE" />
      </linearGradient>
    </defs>
    <path d="M 38 22 L 20 22 L 20 106 L 38 106" fill="none" stroke="url(#webMCPGlow)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 90 22 L 108 22 L 108 106 L 90 106" fill="none" stroke="url(#webMCPGlow)" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 64 28 Q 64 64 28 64 Q 64 64 64 100 Q 64 64 100 64 Q 64 64 64 28 Z" fill="#00F2FE"/>
    <circle cx="64" cy="64" r="6" fill="#FFFFFF"/>
  </svg>
`;

  widgetLauncherLabel = document.createElement('span');
  widgetLauncherLabel.className = 'webmcp-badge-label';
  widgetLauncherLabel.textContent = 'Open WebMCP Annotator';

  widgetLauncher.append(badgeIcon, widgetLauncherLabel);

  ensureShadowRoot();
  widgetMount.appendChild(widgetRoot);
  widgetMount.appendChild(widgetLauncher);

  widgetRoot.style.pointerEvents = 'auto';
  widgetLauncher.style.pointerEvents = 'auto';

  // ── Collapse / expand logic ──────────────────────────────────────────────────

  function applyCollapseState() {
    if (!widgetRoot || !widgetLauncher) return;

    if (widgetCollapsed) {
      widgetRoot.classList.add('webmcp-hidden');
      widgetLauncher.classList.remove('webmcp-hidden');
      widgetLauncher.setAttribute('aria-expanded', 'false');
      widgetCollapseBtn?.setAttribute('aria-expanded', 'false');
    } else {
      widgetRoot.classList.remove('webmcp-hidden');
      widgetLauncher.classList.add('webmcp-hidden');
      widgetLauncher.setAttribute('aria-expanded', 'true');
      widgetCollapseBtn?.setAttribute('aria-expanded', 'true');
    }
  }

  widgetCollapseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    widgetCollapsed = true;
    applyCollapseState();
    pinLauncherTopRight();
  });

  widgetLauncher.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    widgetCollapsed = false;
    applyCollapseState();
    pinWidgetTopRight();
  });

  applyCollapseState();

  requestAnimationFrame(() => {
    pinWidgetTopRight();
    pinLauncherTopRight();
  });


  let widgetDragRaf = 0;

  function flushWidgetDrag() {
    widgetDragRaf = 0;
    if (!dragState || !widgetRoot) return;

    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - dragState.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - dragState.height - margin);

    const clampedLeft = Math.min(Math.max(dragState.nextLeft, margin), maxLeft);
    const clampedTop = Math.min(Math.max(dragState.nextTop, margin), maxTop);

    widgetRoot.style.left = `${clampedLeft}px`;
    widgetRoot.style.top = `${clampedTop}px`;
    widgetRoot.style.right = "auto";
    widgetRoot.style.bottom = "auto";
  }

  const beginDrag = (e) => {
    if (!widgetRoot || e.button !== 0) return;
    if (e.target.closest("button, input, select, textarea, label")) return;

    const rect = widgetRoot.getBoundingClientRect();

    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      nextLeft: rect.left,
      nextTop: rect.top
    };

    header.classList.add("is-dragging");
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onDragMove = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    dragState.nextLeft = dragState.left + (e.clientX - dragState.startX);
    dragState.nextTop = dragState.top + (e.clientY - dragState.startY);

    if (!widgetDragRaf) {
      widgetDragRaf = requestAnimationFrame(flushWidgetDrag);
    }
  };

  const endDrag = (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;

    try {
      header.releasePointerCapture(e.pointerId);
    } catch { }

    if (widgetDragRaf) {
      cancelAnimationFrame(widgetDragRaf);
      widgetDragRaf = 0;
    }

    flushWidgetDrag();
    dragState = null;
    header.classList.remove("is-dragging");
  };

  header.addEventListener('pointerdown', beginDrag);
  header.addEventListener('pointermove', onDragMove);
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  if (!widgetResizeHandlerInstalled) {
    window.addEventListener('resize', handleWidgetResize);
    widgetResizeHandlerInstalled = true;
  }

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
      installAnnotationViewportSync();
    } catch (err) {
      console.error("WebMCP widget init failed", err);
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