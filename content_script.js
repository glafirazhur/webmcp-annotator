/**
 * @fileoverview WebMCP page runtime for wrapper selection, AI-assisted field mapping, validation, and attribute application.
 * @description Injects and manages the in-page annotator widget, captures wrapper screenshots, resolves AI matches to DOM selectors, and persists annotation configs per hostname.
 */

function getUniqueSelector(el) {
  if (!(el instanceof Element)) return '';

  if (el.id) {
    const idSelector = `#${CSS.escape(el.id)}`;
    try {
      if (document.querySelectorAll(idSelector).length === 1) {
        return idSelector;
      }
    } catch (e) { }
  }

  const tagName = el.tagName.toLowerCase();
  if (el.getAttribute('name')) {
    const nameSelector = `${tagName}[name="${CSS.escape(el.getAttribute('name'))}"]`;
    try {
      if (document.querySelectorAll(nameSelector).length === 1) {
        return nameSelector;
      }
    } catch (e) {  }
  }

  
  const path = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let seg = current.tagName.toLowerCase();

    if (current.id) {
      seg += `#${CSS.escape(current.id)}`;
      path.unshift(seg);
      break;
    } else {
      const className = current.className;
      if (className && typeof className === 'string') {
        const classes = className.trim().split(/\s+/).filter(c => c.length > 0);
        if (classes.length > 0) {
          seg += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }

      let sibling = current.previousElementSibling;
      let nth = 1;
      while (sibling) {
        if (sibling.tagName === current.tagName) nth++;
        sibling = sibling.previousElementSibling;
      }
      seg += `:nth-of-type(${nth})`;
    }
    path.unshift(seg);
    current = current.parentElement;
  }

  return path.join(' > ');
}



function getXPath(el) {
  if (!(el instanceof Element)) return null;
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) idx++;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentElement;
  }
  return '/' + parts.join('/');
}



function collapseWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  if (!text) return '';
  const collapsed = collapseWhitespace(text);
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

function classTokens(el) {
  const cn = el.className;
  if (!cn || typeof cn !== 'string') return [];
  return cn.trim().split(/\s+/).filter(Boolean).slice(0, 8);
}



let pickerOverlay = null;
let pickerLabel = null;
let lastPickerTarget = null;
let pickerTemplateId = null;
let pickerActive = false;


let selectedWrapperElement = null;
let selectedWrapper = null;
const IS_TOP_WINDOW = window === window.top;
let widgetRoot = null;
let widgetStatusEl = null;
let widgetSelectionEl = null;
let widgetResultEl = null;
let widgetScreenshotWrapEl = null;
let widgetScreenshotMetaEl = null;
let widgetScreenshotCanvasEl = null;
let widgetTemplateSelectEl = null;
let widgetReviewWrapEl = null;
let widgetReviewListEl = null;
let widgetApplyBtn = null;
let widgetHeaderEl = null;
let widgetPickBtn = null;
let widgetAnalyzeBtn = null;
let aiRunning = false;
let lastCapturedScreenshot = null;
let lastCapturedScreenshotWrapperSelector = null;
let pendingAnnotation = null;
let dragState = null;
let reviewHighlightOverlay = null;
const reviewFieldControls = new Map();
const PICKER_DEBUG = false;

function logPicker(event, payload = {}) {
  if (!PICKER_DEBUG) return;
  try {
    console.log(`[WebMCP Picker] ${event}`, payload);
  } catch (e) {
    
  }
}


const localIdMap = new Map();

const TEMPLATE_FIELD_DEFS = {
  add_to_cart: {
    product_name: { label: 'Product Name', role: 'metadata', required: false },
    id: { label: 'Product / Variant ID', role: 'param', required: false },
    quantity: { label: 'Quantity', role: 'param', required: false },
    add_to_cart_button: { label: 'Add to Cart Button', role: 'cta', required: true },
    description: { label: 'Product Description', role: 'metadata', required: false }
  },
  search_products: {
    search_query: { label: 'Search Query', role: 'param', required: true },
    search_button: { label: 'Search Button', role: 'cta', required: true }
  }
};

function createWidgetPanel(...classNames) {
  const el = document.createElement('div');
  el.className = ['webmcp-panel', ...classNames].filter(Boolean).join(' ');
  return el;
}

function createWidgetButton(label, ...classNames) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = ['webmcp-btn', ...classNames].filter(Boolean).join(' ');
  return btn;
}

function buildSelectedWrapperRecord(target) {
  const rect = target.getBoundingClientRect();

  return {
    id: selectedWrapper?.id || 'wrapper_' + Date.now(),
    templateId: pickerTemplateId || selectedWrapper?.templateId || '',
    tabId: 0,
    url: window.location.href,
    hostname: window.location.hostname,
    selector: getUniqueSelector(target),
    xpath: getXPath(target),
    tagName: target.tagName,
    rect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1
    },
    preview: {
      textSample: truncate(target.innerText, 200),
      className: target.className || '',
      childCount: target.children.length
    },
    createdAt: selectedWrapper?.createdAt || new Date().toISOString()
  };
}

function refreshSelectedWrapper(target) {
  selectedWrapperElement = target;
  selectedWrapper = buildSelectedWrapperRecord(target);
  return selectedWrapper;
}

function getSelectedWrapperElement() {
  if (selectedWrapperElement instanceof Element && document.contains(selectedWrapperElement)) {
    return selectedWrapperElement;
  }

  if (!selectedWrapper?.selector) {
    return null;
  }

  try {
    const resolved = document.querySelector(selectedWrapper.selector);
    if (resolved instanceof Element) {
      selectedWrapperElement = resolved;
      selectedWrapper = buildSelectedWrapperRecord(resolved);
      return resolved;
    }
  } catch (e) {
    return null;
  }

  return null;
}

function getFieldDefinition(fieldId) {
  const templateId = selectedWrapper?.templateId || pickerTemplateId || '';
  return TEMPLATE_FIELD_DEFS[templateId]?.[fieldId] || null;
}

function getTemplateDisplayName(templateId) {
  if (templateId === 'search_products') return 'Product Search';
  if (templateId === 'add_to_cart') return 'Add to Cart';
  return templateId;
}

function normalizeTemplateId(templateId) {
  if (!templateId || !TEMPLATE_FIELD_DEFS[templateId]) return 'add_to_cart';
  return templateId;
}

function setActiveTemplate(templateId) {
  const normalized = normalizeTemplateId(templateId);
  pickerTemplateId = normalized;

  if (selectedWrapper) {
    selectedWrapper.templateId = normalized;
  }

  if (widgetTemplateSelectEl && widgetTemplateSelectEl.value !== normalized) {
    widgetTemplateSelectEl.value = normalized;
  }
}

function getCurrentTemplateId() {
  return widgetTemplateSelectEl?.value || selectedWrapper?.templateId || pickerTemplateId || 'add_to_cart';
}

function resetPendingReviewState({ resetScreenshot = false } = {}) {
  pendingAnnotation = null;
  hideReviewHighlight();
  if (widgetReviewWrapEl) {
    widgetReviewWrapEl.classList.add('webmcp-hidden');
  }

  if (resetScreenshot) {
    lastCapturedScreenshot = null;
    lastCapturedScreenshotWrapperSelector = null;
  }
}

function clampWidgetToViewport(left, top) {
  if (!widgetRoot) return { left, top };
  const margin = 8;
  const width = widgetRoot.offsetWidth || 340;
  const height = widgetRoot.offsetHeight || 260;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  return {
    left: Math.min(maxLeft, Math.max(margin, left)),
    top: Math.min(maxTop, Math.max(margin, top))
  };
}

function applyWidgetPosition(left, top) {
  if (!widgetRoot) return;
  const clamped = clampWidgetToViewport(left, top);
  widgetRoot.style.left = `${clamped.left}px`;
  widgetRoot.style.top = `${clamped.top}px`;
  widgetRoot.style.right = 'auto';
  widgetRoot.style.bottom = 'auto';
}

function ensureReviewHighlightOverlay() {
  if (reviewHighlightOverlay && document.contains(reviewHighlightOverlay)) {
    return reviewHighlightOverlay;
  }

  reviewHighlightOverlay = document.createElement('div');
  reviewHighlightOverlay.id = 'webmcp-review-highlight';
  reviewHighlightOverlay.className = 'webmcp-hidden';
  document.body.appendChild(reviewHighlightOverlay);
  return reviewHighlightOverlay;
}

function hideReviewHighlight() {
  if (!reviewHighlightOverlay) return;
  reviewHighlightOverlay.classList.add('webmcp-hidden');
}

function showReviewHighlightBySelector(selector) {
  if (!selector) {
    hideReviewHighlight();
    return;
  }

  let el;
  try {
    el = document.querySelector(selector);
  } catch (e) {
    hideReviewHighlight();
    return;
  }

  if (!(el instanceof Element)) {
    hideReviewHighlight();
    return;
  }

  const overlay = ensureReviewHighlightOverlay();
  const rect = el.getBoundingClientRect();
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  overlay.style.top = `${rect.top + window.scrollY}px`;
  overlay.style.left = `${rect.left + window.scrollX}px`;
  overlay.classList.remove('webmcp-hidden');
}

function ensureWidget() {
  if (!IS_TOP_WINDOW) return;
  if (widgetRoot && document.contains(widgetRoot)) return;

  widgetRoot = document.createElement('section');
  widgetRoot.id = 'webmcp-floating-widget';
  widgetRoot.setAttribute('data-webmcp-widget', 'true');
  widgetRoot.setAttribute('aria-label', 'WebMCP annotator widget');

  widgetHeaderEl = document.createElement('div');
  widgetHeaderEl.setAttribute('aria-label', 'Drag widget');
  widgetHeaderEl.className = 'webmcp-widget-header';

  const title = document.createElement('div');
  title.textContent = 'WebMCP Annotator';
  title.className = 'webmcp-widget-title';

  const dragHint = document.createElement('div');
  dragHint.textContent = 'Drag';
  dragHint.className = 'webmcp-drag-hint';

  widgetHeaderEl.appendChild(title);
  widgetHeaderEl.appendChild(dragHint);

  const templateWrap = document.createElement('div');
  templateWrap.className = 'webmcp-template-wrap';

  const templateLabel = document.createElement('div');
  templateLabel.textContent = 'Tool Template';
  templateLabel.className = 'webmcp-label';

  widgetTemplateSelectEl = document.createElement('select');
  widgetTemplateSelectEl.className = 'webmcp-select';

  Object.keys(TEMPLATE_FIELD_DEFS).forEach((templateId) => {
    const option = document.createElement('option');
    option.value = templateId;
    option.textContent = getTemplateDisplayName(templateId);
    widgetTemplateSelectEl.appendChild(option);
  });

  templateWrap.appendChild(templateLabel);
  templateWrap.appendChild(widgetTemplateSelectEl);

  const actions = document.createElement('div');
  actions.className = 'webmcp-actions';

  widgetPickBtn = createWidgetButton('Pick Target', 'webmcp-btn-primary');
  widgetAnalyzeBtn = createWidgetButton('Run AI On Selection', 'webmcp-btn-analyze');

  actions.appendChild(widgetPickBtn);
  actions.appendChild(widgetAnalyzeBtn);

  widgetStatusEl = document.createElement('div');
  widgetStatusEl.className = 'webmcp-status';

  widgetSelectionEl = document.createElement('pre');
  widgetSelectionEl.className = 'webmcp-selection';

  widgetResultEl = document.createElement('pre');
  widgetResultEl.className = 'webmcp-result';

  widgetScreenshotWrapEl = createWidgetPanel('webmcp-screenshot-panel', 'webmcp-hidden');

  const screenshotTitleEl = document.createElement('div');
  screenshotTitleEl.textContent = 'Screenshot Sent To AI';
  screenshotTitleEl.className = 'webmcp-screenshot-title';

  widgetScreenshotMetaEl = document.createElement('div');
  widgetScreenshotMetaEl.className = 'webmcp-screenshot-meta';

  widgetScreenshotCanvasEl = document.createElement('canvas');
  widgetScreenshotCanvasEl.setAttribute('role', 'img');
  widgetScreenshotCanvasEl.setAttribute('aria-label', 'Wrapper screenshot sent to AI');
  widgetScreenshotCanvasEl.className = 'webmcp-screenshot-canvas';

  widgetScreenshotWrapEl.appendChild(screenshotTitleEl);
  widgetScreenshotWrapEl.appendChild(widgetScreenshotMetaEl);
  widgetScreenshotWrapEl.appendChild(widgetScreenshotCanvasEl);

  widgetRoot.appendChild(widgetHeaderEl);
  widgetRoot.appendChild(templateWrap);
  widgetRoot.appendChild(actions);
  widgetRoot.appendChild(widgetStatusEl);
  widgetRoot.appendChild(widgetSelectionEl);
  widgetRoot.appendChild(widgetScreenshotWrapEl);

  widgetReviewWrapEl = createWidgetPanel('webmcp-review-panel', 'webmcp-hidden');

  const reviewTitle = document.createElement('div');
  reviewTitle.textContent = 'AI Validation';
  reviewTitle.className = 'webmcp-review-title';

  widgetReviewListEl = document.createElement('div');
  widgetReviewListEl.className = 'webmcp-review-list';

  widgetApplyBtn = createWidgetButton('Apply Validated Markup', 'webmcp-btn-success', 'webmcp-apply-btn');
  widgetApplyBtn.disabled = true;
  widgetApplyBtn.classList.add('is-disabled');

  widgetReviewWrapEl.appendChild(reviewTitle);
  widgetReviewWrapEl.appendChild(widgetReviewListEl);
  widgetReviewWrapEl.appendChild(widgetApplyBtn);
  widgetRoot.appendChild(widgetReviewWrapEl);

  widgetRoot.appendChild(widgetResultEl);

  document.body.appendChild(widgetRoot);

  const beginDrag = (event) => {
    if (!widgetRoot || !(event.target instanceof Element)) return;
    if (event.button !== 0) return;
    if (event.target.closest('button, input, select, textarea, label')) return;

    const rect = widgetRoot.getBoundingClientRect();
    applyWidgetPosition(rect.left, rect.top);

    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top
    };

    widgetHeaderEl.classList.add('is-dragging');
    widgetHeaderEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onDragMove = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;

    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    applyWidgetPosition(dragState.left + dx, dragState.top + dy);
  };

  const endDrag = (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    try {
      widgetHeaderEl.releasePointerCapture(event.pointerId);
    } catch (e) {
      
    }
    dragState = null;
    widgetHeaderEl.classList.remove('is-dragging');
  };

  widgetHeaderEl.addEventListener('pointerdown', beginDrag);
  widgetHeaderEl.addEventListener('pointermove', onDragMove);
  widgetHeaderEl.addEventListener('pointerup', endDrag);
  widgetHeaderEl.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    if (!widgetRoot) return;
    const rect = widgetRoot.getBoundingClientRect();
    applyWidgetPosition(rect.left, rect.top);
  });

  widgetPickBtn.addEventListener('click', () => {
    updateWidgetStatus('Picker active: hover and click any wrapper element.');
    startPicker(getCurrentTemplateId());
  });

  widgetAnalyzeBtn.addEventListener('click', () => {
    runWrapperAiAnalysis().catch((error) => {
      updateWidgetStatus(`AI analysis failed: ${error.message}`);
    });
  });

  widgetTemplateSelectEl.addEventListener('change', () => {
    setActiveTemplate(widgetTemplateSelectEl.value);
    resetPendingReviewState();
    updateWidgetStatus(`Template set to ${getTemplateDisplayName(pickerTemplateId)}.`);
  });

  widgetApplyBtn.addEventListener('click', () => {
    applyPendingAnnotationFromWidget();
  });

  setActiveTemplate(pickerTemplateId || 'add_to_cart');
  updateWidgetStatus('Ready. Pick a target first.');
  updateWidgetSelectionText();
  updateWidgetScreenshot(null);
  updateWidgetResult('');
}

function updateWidgetStatus(text) {
  if (!widgetStatusEl) return;
  widgetStatusEl.textContent = text;
}

function updateWidgetSelectionText() {
  if (!widgetSelectionEl) return;

  if (!selectedWrapper) {
    widgetSelectionEl.textContent = 'Selection: none';
    return;
  }

  widgetSelectionEl.textContent = [
    `Selection: <${(selectedWrapper.tagName || '').toLowerCase()}>`,
    `Selector: ${selectedWrapper.selector || 'n/a'}`,
    `Text: ${selectedWrapper.preview?.textSample || 'n/a'}`
  ].join('\n');
}

function updateWidgetResult(text) {
  if (!widgetResultEl) return;
  widgetResultEl.textContent = text || 'AI results will appear here.';
}

function getSelectedTemplateFieldDefs() {
  const templateId = normalizeTemplateId(pickerTemplateId || selectedWrapper?.templateId || 'add_to_cart');
  return TEMPLATE_FIELD_DEFS[templateId] || TEMPLATE_FIELD_DEFS.add_to_cart;
}

function updateApplyButtonState() {
  if (!widgetApplyBtn) return;

  if (!pendingAnnotation) {
    widgetApplyBtn.disabled = true;
    widgetApplyBtn.classList.add('is-disabled');
    return;
  }

  const defs = getSelectedTemplateFieldDefs();
  const blockers = [];

  for (const [fieldId, controls] of reviewFieldControls.entries()) {
    const required = Boolean(defs[fieldId]?.required);
    const accepted = controls.acceptEl.checked;
    const selectedSelector = controls.selectEl.value;

    if (required && (!accepted || !selectedSelector)) {
      blockers.push(fieldId);
    }
  }

  const canApply = blockers.length === 0;
  widgetApplyBtn.disabled = !canApply;
  widgetApplyBtn.classList.toggle('is-disabled', !canApply);

  if (!canApply) {
    updateWidgetStatus(`Validation required: missing required field(s): ${blockers.join(', ')}`);
  }
}

function renderValidationPanel(annotation) {
  if (!widgetReviewWrapEl || !widgetReviewListEl) return;

  reviewFieldControls.clear();
  widgetReviewListEl.innerHTML = '';

  const defs = getSelectedTemplateFieldDefs();

  (annotation.fields || []).forEach((field) => {
    const row = document.createElement('div');
    row.className = 'webmcp-review-row';

    const head = document.createElement('div');
    head.className = 'webmcp-review-head';

    const label = document.createElement('div');
    const required = Boolean(defs[field.fieldId]?.required);
    label.textContent = `${field.title || field.fieldId}${required ? ' *' : ''}`;
    label.className = 'webmcp-review-label';

    const confidence = document.createElement('div');
    const conf = Number(field.confidence || 0);
    confidence.textContent = `conf ${Math.round(conf * 100)}%`;
    confidence.className = `webmcp-review-confidence ${conf >= 0.75 ? 'high' : 'low'}`;

    head.appendChild(label);
    head.appendChild(confidence);

    const controlsWrap = document.createElement('div');
    controlsWrap.className = 'webmcp-review-controls';

    const acceptLabel = document.createElement('label');
    acceptLabel.textContent = 'Accept';
    acceptLabel.className = 'webmcp-review-small-label';

    const acceptEl = document.createElement('input');
    acceptEl.type = 'checkbox';
    acceptEl.checked = (field.selectors || []).length > 0;
    acceptEl.className = 'webmcp-review-check';

    const selectLabel = document.createElement('label');
    selectLabel.textContent = 'Selector';
    selectLabel.className = 'webmcp-review-small-label';

    const selectEl = document.createElement('select');
    selectEl.className = 'webmcp-select webmcp-review-select';

    const noneOption = document.createElement('option');
    noneOption.value = '';
    noneOption.textContent = '-- no selector --';
    selectEl.appendChild(noneOption);

    (field.selectors || []).forEach((selector, idx) => {
      const option = document.createElement('option');
      option.value = selector;
      option.textContent = `${idx + 1}. ${selector}`;
      selectEl.appendChild(option);
    });

    selectEl.value = (field.selectors || [])[0] || '';

    acceptEl.addEventListener('change', () => {
      updateApplyButtonState();
    });

    selectEl.addEventListener('change', () => {
      updateApplyButtonState();
      if (selectEl.value) {
        showReviewHighlightBySelector(selectEl.value);
      } else {
        hideReviewHighlight();
      }
    });

    row.addEventListener('mouseenter', () => {
      if (selectEl.value) {
        showReviewHighlightBySelector(selectEl.value);
      }
    });

    row.addEventListener('mouseleave', () => {
      hideReviewHighlight();
    });

    controlsWrap.appendChild(acceptLabel);
    controlsWrap.appendChild(acceptEl);
    controlsWrap.appendChild(selectLabel);
    controlsWrap.appendChild(selectEl);

    row.appendChild(head);
    row.appendChild(controlsWrap);
    widgetReviewListEl.appendChild(row);

    reviewFieldControls.set(field.fieldId, {
      acceptEl,
      selectEl
    });
  });

  widgetReviewWrapEl.classList.remove('webmcp-hidden');
  updateApplyButtonState();
}

function buildValidatedAnnotation() {
  if (!pendingAnnotation) return null;

  const cloned = JSON.parse(JSON.stringify(pendingAnnotation));
  cloned.fields = (cloned.fields || []).map((field) => {
    const controls = reviewFieldControls.get(field.fieldId);
    if (!controls) return field;

    const accepted = controls.acceptEl.checked;
    const selectedSelector = controls.selectEl.value;

    return {
      ...field,
      selectors: accepted && selectedSelector ? [selectedSelector] : []
    };
  });

  return cloned;
}

async function persistSelectorConfig(selectorConfig) {
  return new Promise((resolve) => {
    chrome.storage.local.get(['webmcp_persisted_annotations'], (result) => {
      const all = result.webmcp_persisted_annotations || {};
      const hostname = window.location.hostname;
      const siteList = all[hostname] || [];

      const filtered = siteList.filter((cfg) => cfg.wrapperSelector !== selectorConfig.wrapperSelector);
      filtered.push(selectorConfig);
      all[hostname] = filtered;

      chrome.storage.local.set({ webmcp_persisted_annotations: all }, () => resolve());
    });
  });
}

async function applyPendingAnnotationFromWidget() {
  if (!pendingAnnotation) {
    updateWidgetStatus('Run AI first, then validate fields.');
    return;
  }

  const validated = buildValidatedAnnotation();
  if (!validated) {
    updateWidgetStatus('Validation state is unavailable.');
    return;
  }

  const applyResult = applyAnnotation(validated);
  if (!applyResult.success) {
    updateWidgetStatus(`Apply failed: ${applyResult.error || 'unknown error'}`);
    return;
  }

  await persistSelectorConfig(applyResult.selectorConfig);
  updateWidgetResult(renderSimpleResultText(validated));
  updateWidgetStatus('Markup applied and persisted for this site.');
  pendingAnnotation = validated;
  hideReviewHighlight();
}

async function updateWidgetScreenshot(screenshot) {
  if (!widgetScreenshotWrapEl || !widgetScreenshotCanvasEl || !widgetScreenshotMetaEl) return;

  if (!screenshot || !screenshot.base64) {
    widgetScreenshotWrapEl.classList.add('webmcp-hidden');
    const clearCtx = widgetScreenshotCanvasEl.getContext('2d');
    if (clearCtx) {
      clearCtx.clearRect(0, 0, widgetScreenshotCanvasEl.width || 1, widgetScreenshotCanvasEl.height || 1);
    }
    widgetScreenshotMetaEl.textContent = '';
    return;
  }

  const mime = screenshot.imageMimeType || 'image/png';
  if (!/^image\/(png|jpeg|jpg|webp)$/i.test(mime)) {
    logPicker('screenshot-preview-unsupported-mime', { mime });
    widgetScreenshotWrapEl.classList.add('webmcp-hidden');
    return;
  }

  try {
    const binary = atob(screenshot.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: mime });
    const bitmap = await createImageBitmap(blob);

    widgetScreenshotCanvasEl.width = bitmap.width;
    widgetScreenshotCanvasEl.height = bitmap.height;

    const ctx = widgetScreenshotCanvasEl.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new Error('Canvas context unavailable.');
    }

    ctx.clearRect(0, 0, widgetScreenshotCanvasEl.width, widgetScreenshotCanvasEl.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    widgetScreenshotMetaEl.textContent = `${bitmap.width}x${bitmap.height} ${mime}`;
    widgetScreenshotWrapEl.classList.remove('webmcp-hidden');
  } catch (error) {
    logPicker('screenshot-preview-render-error', {
      error: error?.message || String(error)
    });
    widgetScreenshotMetaEl.textContent = 'Preview render failed (screenshot still sent to AI).';
    widgetScreenshotWrapEl.classList.remove('webmcp-hidden');
  }
}

function setAiRunningState(running) {
  aiRunning = running;
  if (widgetAnalyzeBtn) {
    widgetAnalyzeBtn.disabled = running;
    widgetAnalyzeBtn.classList.toggle('is-disabled', running);
  }
}

function summarizeForAi(domSummary) {
  const controls = (domSummary.controls || []).slice(0, 18).map((c) => ({
    localId: c.localId,
    tagName: c.tagName,
    type: c.type,
    role: c.role,
    name: c.name,
    id: c.id,
    ariaLabel: c.ariaLabel,
    placeholder: c.placeholder,
    text: truncate(c.text, 90),
    labels: (c.labels || []).slice(0, 3),
    isHidden: c.isHidden,
    isDisabled: c.isDisabled
  }));

  const textBlocks = (domSummary.textBlocks || []).slice(0, 14).map((t) => ({
    localId: t.localId,
    tagName: t.tagName,
    text: truncate(t.text, 140)
  }));

  return {
    container: domSummary.container,
    controls,
    textBlocks,
    stats: {
      controlCount: controls.length,
      textBlockCount: textBlocks.length
    }
  };
}

function buildAiPreviewPayload(wrapper, wrapperEl) {
  const domSummary = buildWrapperDomSummary(wrapperEl);
  return {
    templateId: wrapper.templateId || pickerTemplateId || 'add_to_cart',
    wrapper: {
      selector: wrapper.selector,
      tagName: wrapper.tagName,
      textSample: wrapper.preview?.textSample || ''
    },
    domSummaryForAi: summarizeForAi(domSummary)
  };
}

function getAiSchema() {
  return {
    type: 'OBJECT',
    properties: {
      tool: { type: 'STRING' },
      hasMatch: { type: 'BOOLEAN' },
      wrapperType: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
      reason: { type: 'STRING' },
      matches: {
        type: 'OBJECT',
        additionalProperties: {
          type: 'OBJECT',
          properties: {
            localIds: { type: 'ARRAY', items: { type: 'STRING' } },
            confidence: { type: 'NUMBER' },
            reason: { type: 'STRING' }
          },
          required: ['localIds', 'confidence', 'reason']
        }
      },
      webmcp: {
        type: 'OBJECT',
        properties: {
          toolName: { type: 'STRING' },
          toolDescription: { type: 'STRING' },
          fieldDescriptions: {
            type: 'OBJECT',
            additionalProperties: { type: 'STRING' }
          }
        },
        required: ['toolName', 'toolDescription', 'fieldDescriptions']
      },
      warnings: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['tool', 'hasMatch', 'wrapperType', 'confidence', 'reason', 'matches', 'webmcp', 'warnings']
  };
}

function parseAiJsonResponse(payload) {
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('AI response was empty.');
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('AI returned invalid JSON.');
  }
}

async function getAiSettings() {
  const defaults = {
    settings_model: 'gemini-3.5-flash',
    settings_api_key: ''
  };

  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      resolve(defaults);
      return;
    }

    chrome.storage.local.get(['settings_model', 'settings_api_key'], (result) => {
      resolve({
        settings_model: result.settings_model || defaults.settings_model,
        settings_api_key: result.settings_api_key || defaults.settings_api_key
      });
    });
  });
}

async function callAnalyzeWrapperAi({ wrapper, screenshot, domSummary }) {
  const settings = await getAiSettings();
  const apiKey = (settings.settings_api_key || '').trim();
  const model = settings.settings_model || 'gemini-3.5-flash';

  if (!apiKey) {
    throw new Error('Missing API key in Settings.');
  }

  const aiSummary = summarizeForAi(domSummary);
  const fieldDefs = TEMPLATE_FIELD_DEFS[wrapper.templateId || 'add_to_cart'] || TEMPLATE_FIELD_DEFS.add_to_cart;

  const promptText = [
    'You are annotating one selected e-commerce wrapper for WebMCP.',
    'Use both image and wrapper-only DOM summary. Return JSON only.',
    `Template: ${wrapper.templateId || 'add_to_cart'}`,
    `Fields: ${Object.keys(fieldDefs).join(', ')}`,
    'The localIds in your output must come from this summary only.',
    JSON.stringify(aiSummary)
  ].join('\n\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: {
                  mimeType: screenshot.imageMimeType,
                  data: screenshot.base64
                }
              },
              { text: promptText }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: getAiSchema(),
          temperature: 0.2
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API ${response.status}: ${errorText.slice(0, 220)}`);
  }

  const payload = await response.json();
  return parseAiJsonResponse(payload);
}

function renderSimpleResultText(annotation) {
  const lines = [];
  lines.push(`Tool: ${annotation.tool.name}`);
  lines.push(`Wrapper: ${annotation.wrapperSelector}`);
  lines.push('Marked elements:');

  for (const field of annotation.fields || []) {
    const first = (field.selectors || [])[0] || 'no-match';
    lines.push(`- ${field.fieldId}: ${first}`);
  }

  if ((annotation.warnings || []).length > 0) {
    lines.push('Warnings:');
    (annotation.warnings || []).slice(0, 6).forEach((w) => lines.push(`- ${w}`));
  }

  return lines.join('\n');
}

async function captureWrapperScreenshot(wrapper) {
  if (widgetRoot) widgetRoot.classList.add('webmcp-hidden');
  if (pickerOverlay) pickerOverlay.classList.add('webmcp-hidden');

  
  await waitForPaintSettlement(90);

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        action: 'captureWrapperScreenshot',
        tabId: 0,
        rect: wrapper.rect
      },
      (response) => {
        if (widgetRoot) widgetRoot.classList.remove('webmcp-hidden');
        if (pickerOverlay) pickerOverlay.classList.remove('webmcp-hidden');

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response || response.action !== 'wrapperScreenshotReady' || !response.screenshot) {
          reject(new Error(response?.error || 'Screenshot capture failed.'));
          return;
        }

        resolve(response.screenshot);
      }
    );
  });
}

function nextAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPaintSettlement(minDelayMs = 0) {
  if (minDelayMs > 0) {
    await wait(minDelayMs);
  }
  await nextAnimationFrame();
  await nextAnimationFrame();
}

async function prepareWrapperForScreenshot(wrapperEl) {
  if (!(wrapperEl instanceof Element)) return null;

  const wrapper = refreshSelectedWrapper(wrapperEl);
  const exceedsViewport = wrapper.rect.width > window.innerWidth || wrapper.rect.height > window.innerHeight;
  if (exceedsViewport) {
    logPicker('wrapper-exceeds-viewport', {
      rect: wrapper.rect,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
  }

  return wrapper;
}

async function runWrapperAiAnalysis() {
  ensureWidget();
  if (aiRunning) return;

  const wrapperEl = getSelectedWrapperElement();
  if (!wrapperEl) {
    updateWidgetStatus('Pick a target before running AI.');
    return { success: false, error: 'No wrapper selected.' };
  }

  setAiRunningState(true);
  updateWidgetStatus('Preparing screenshot for AI...');

  try {
    const wrapper = await prepareWrapperForScreenshot(wrapperEl) || refreshSelectedWrapper(wrapperEl);
    let screenshot = null;

    if (lastCapturedScreenshot && lastCapturedScreenshotWrapperSelector === wrapper.selector) {
      screenshot = lastCapturedScreenshot;
      logPicker('screenshot-reused-from-pick', {
        selector: wrapper.selector,
        width: screenshot.width,
        height: screenshot.height
      });
    } else {
      screenshot = await captureWrapperScreenshot(wrapper);
      lastCapturedScreenshot = screenshot;
      lastCapturedScreenshotWrapperSelector = wrapper.selector;
      await updateWidgetScreenshot(screenshot);
      logPicker('screenshot-preview-ready', {
        width: screenshot.width,
        height: screenshot.height,
        mime: screenshot.imageMimeType
      });
    }

    updateWidgetStatus('Extracting wrapper elements...');
    const domSummary = buildWrapperDomSummary(wrapperEl);

    updateWidgetStatus('Running AI analysis...');
    const aiResponse = await callAnalyzeWrapperAi({ wrapper, screenshot, domSummary });

    updateWidgetStatus('Resolving AI localIds...');
    const resolved = resolveAiMatches(aiResponse);
    if (!resolved.success) {
      throw new Error(resolved.error || 'Failed to resolve AI matches.');
    }

    pendingAnnotation = resolved.annotation;
    renderValidationPanel(resolved.annotation);

    const warningCount = (resolved.annotation.warnings || []).length;
    const warningText = warningCount > 0 ? ` (${warningCount} warning${warningCount === 1 ? '' : 's'})` : '';
    updateWidgetResult(`AI draft ready${warningText}. Validate each field, then click Apply Validated Markup.`);
    updateWidgetStatus('AI complete. Review and validate before applying.');

    return {
      success: true,
      annotation: resolved.annotation,
      requiresValidation: true
    };
  } finally {
    setAiRunningState(false);
  }
}

async function captureAndPreviewAfterPick(wrapper) {
  updateWidgetStatus('Target selected. Capturing screenshot preview...');

  try {
    const wrapperEl = getSelectedWrapperElement();
    const preparedWrapper = await prepareWrapperForScreenshot(wrapperEl) || wrapper;
    const screenshot = await captureWrapperScreenshot(preparedWrapper);
    lastCapturedScreenshot = screenshot;
    lastCapturedScreenshotWrapperSelector = preparedWrapper.selector;
    await updateWidgetScreenshot(screenshot);

    updateWidgetStatus('Target selected. Screenshot preview ready. You can run AI now.');
    logPicker('screenshot-preview-after-pick-ready', {
      selector: preparedWrapper.selector,
      width: screenshot.width,
      height: screenshot.height,
      mime: screenshot.imageMimeType
    });
  } catch (error) {
    lastCapturedScreenshot = null;
    lastCapturedScreenshotWrapperSelector = null;
    updateWidgetStatus(`Target selected, but screenshot preview failed: ${error.message}`);
    logPicker('screenshot-preview-after-pick-error', {
      selector: wrapper.selector,
      error: error?.message || String(error)
    });
  }
}

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
  pickerOverlay.style.width = `${rect.width}px`;
  pickerOverlay.style.height = `${rect.height}px`;
  pickerOverlay.style.top = `${rect.top + window.scrollY}px`;
  pickerOverlay.style.left = `${rect.left + window.scrollX}px`;

  const childCount = el.children.length;
  const tag = el.tagName.toLowerCase();
  if (pickerLabel) {
    pickerLabel.textContent = `<${tag}> ${Math.round(rect.width)}×${Math.round(rect.height)} · ${childCount} children`;
  }
}

function handlePickerHover(e) {
  if (!pickerActive) return;
  e.preventDefault();
  e.stopPropagation();

  const target = resolvePickerTarget(e);
  if (!target) {
    return;
  }

  if (lastPickerTarget === target) return;
  lastPickerTarget = target;

  logPicker('hover', {
    tag: target.tagName,
    selector: getUniqueSelector(target)
  });

  createPickerOverlay();
  positionOverlay(target);
}

function resolvePickerTarget(e) {
  const x = e.clientX;
  const y = e.clientY;

  const stack = typeof document.elementsFromPoint === 'function'
    ? document.elementsFromPoint(x, y)
    : [e.target];

  const target = stack.find((node) => {
    if (!(node instanceof Element)) return false;
    if (node.closest('#webmcp-picker-overlay')) return false;
    if (node.closest('#webmcp-floating-widget')) return false;
    if (node.closest('[data-webmcp-widget="true"]')) return false;

    const skip = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META'];
    return !skip.includes(node.tagName);
  });

  if (!target) {
    logPicker('resolve-target-none', {
      x,
      y,
      stack: stack
        .filter((n) => n instanceof Element)
        .slice(0, 6)
        .map((n) => `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}`)
    });
    return null;
  }

  return target;
}

function handlePickerClick(e) {
  if (!pickerActive) return;
  e.preventDefault();
  e.stopPropagation();

  const target = resolvePickerTarget(e);
  if (!target) {
    updateWidgetStatus('No selectable target at click position. Try again.');
    logPicker('click-no-target', { x: e.clientX, y: e.clientY });
    return;
  }

  logPicker('click', {
    tag: target.tagName,
    selector: getUniqueSelector(target),
    x: e.clientX,
    y: e.clientY
  });

  const wrapper = refreshSelectedWrapper(target);
  setActiveTemplate(pickerTemplateId || selectedWrapper?.templateId || 'add_to_cart');
  updateWidgetSelectionText();
  resetPendingReviewState({ resetScreenshot: true });

  const previewPayload = buildAiPreviewPayload(wrapper, target);
  updateWidgetResult(JSON.stringify(previewPayload, null, 2));
  logPicker('ai-preview', {
    controlCount: previewPayload.domSummaryForAi?.stats?.controlCount || 0,
    textBlockCount: previewPayload.domSummaryForAi?.stats?.textBlockCount || 0
  });

  logPicker('selected', {
    selector: wrapper.selector,
    tagName: wrapper.tagName,
    textSample: wrapper.preview?.textSample || ''
  });

  stopPicker();

  captureAndPreviewAfterPick(wrapper).catch((error) => {
    logPicker('capture-after-pick-unhandled', {
      error: error?.message || String(error)
    });
  });
}

function handlePickerKeydown(e) {
  if (!pickerActive) return;
  if (e.key !== 'Escape') return;

  e.preventDefault();
  e.stopPropagation();

  stopPicker();
  updateWidgetStatus('Picker canceled (Esc).');
  logPicker('cancel-esc', {
    hasSelection: Boolean(selectedWrapper?.selector)
  });
}

function startPicker(templateId) {
  ensureWidget();
  setActiveTemplate(templateId || pickerTemplateId || 'add_to_cart');
  pickerActive = true;
  document.addEventListener('mousemove', handlePickerHover, true);
  document.addEventListener('click', handlePickerClick, true);
  document.addEventListener('keydown', handlePickerKeydown, true);
  document.body.classList.add('webmcp-picking-cursor');
  updateWidgetStatus('Picker active: click one wrapper element.');
  logPicker('start', {
    templateId: pickerTemplateId || 'add_to_cart',
    url: window.location.href
  });
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
  updateWidgetStatus('Picker stopped.');
  logPicker('stop', { hasSelection: Boolean(selectedWrapper?.selector) });
}



const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'LINK', 'META', 'BR', 'HR', 'IMG']);
const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'SPAN', 'LABEL', 'LEGEND', 'LI', 'DT', 'DD', 'SUMMARY', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM', 'A']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'switch', 'checkbox', 'radio', 'option']);

function isClickableLink(el) {
  if (el.tagName !== 'A') return false;
  const role = el.getAttribute('role');
  return Boolean(el.getAttribute('href')) || role === 'button' || el.classList.contains('btn') || el.classList.contains('button');
}

function hasInlineInteractionHandlers(el) {
  return el.hasAttribute('onclick') || el.hasAttribute('onkeydown') || el.hasAttribute('onkeypress') || el.hasAttribute('onkeyup');
}

function isClickableNonNativeControl(el) {
  if (!(el instanceof Element)) return false;
  if (CONTROL_TAGS.has(el.tagName) || el.tagName === 'A') return false;

  const role = (el.getAttribute('role') || '').toLowerCase();
  const tabindexRaw = el.getAttribute('tabindex');
  const tabindex = tabindexRaw === null ? null : Number(tabindexRaw);
  const hasFocusableTabIndex = tabindex !== null && !Number.isNaN(tabindex) && tabindex >= 0;
  const hasAriaInteractiveState = el.hasAttribute('aria-pressed') || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls');
  const hasInteractiveRole = INTERACTIVE_ROLES.has(role);
  const hasHandlers = hasInlineInteractionHandlers(el);
  const computedStyle = window.getComputedStyle(el);
  const cursorPointer = computedStyle.cursor === 'pointer';

  if (hasInteractiveRole) return true;
  if (hasFocusableTabIndex && (hasHandlers || hasAriaInteractiveState)) return true;
  if (hasHandlers && cursorPointer) return true;

  return false;
}

function isMeaningfulTextDiv(el) {
  if (!(el instanceof Element) || el.tagName !== 'DIV') return false;
  if (isHidden(el) || isClickableNonNativeControl(el)) return false;

  const text = collapseWhitespace(el.innerText || el.textContent || '');
  if (!text || text.length < 12 || text.length > 240) return false;
  if (el.children.length > 8) return false;

  if (el.querySelector('button, input, select, textarea, a[href], [role="button"], [role="link"], [tabindex]')) {
    return false;
  }

  return true;
}

function isHidden(el) {
  if (el.hidden) return true;
  const style = window.getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

function getLabelsForControl(control) {
  const labels = [];

  
  if (control.id) {
    const label = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (label) labels.push(truncate(label.textContent, 80));
  }

  
  const parentLabel = control.closest('label');
  if (parentLabel) {
    const text = truncate(parentLabel.textContent, 80);
    if (text && !labels.includes(text)) labels.push(text);
  }

  
  const ariaLabel = control.getAttribute('aria-label');
  if (ariaLabel) labels.push(truncate(ariaLabel, 80));

  return labels;
}



function buildWrapperDomSummary(wrapperEl) {
  localIdMap.clear();

  const controls = [];
  const textBlocks = [];
  let ctlIdx = 0;
  let txtIdx = 0;

  function walkNode(el) {
    if (!(el instanceof Element)) return;
    if (SKIP_TAGS.has(el.tagName)) return;

    
    const isControl = CONTROL_TAGS.has(el.tagName) || isClickableLink(el) || isClickableNonNativeControl(el);

    if (isControl) {
      ctlIdx++;
      const localId = `ctl_${String(ctlIdx).padStart(2, '0')}`;
      localIdMap.set(localId, el);

      controls.push({
        localId,
        tagName: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        role: el.getAttribute('role') || null,
        inputMode: el.getAttribute('inputmode') || null,
        name: el.getAttribute('name') || null,
        id: el.id || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        placeholder: el.getAttribute('placeholder') || null,
        text: truncate(el.innerText || el.value || '', 120),
        labels: getLabelsForControl(el),
        isHidden: isHidden(el),
        isDisabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        selectorHint: getUniqueSelector(el)
      });

      
      return;
    }

    
    const isTextTag = TEXT_TAGS.has(el.tagName) || isMeaningfulTextDiv(el);
    if (isTextTag) {
      const text = truncate(el.innerText || el.textContent, 200);
      
      if (!isHidden(el) && text && text.length > 2) {
        txtIdx++;
        const localId = `txt_${String(txtIdx).padStart(2, '0')}`;
        localIdMap.set(localId, el);

        textBlocks.push({
          localId,
          tagName: el.tagName.toLowerCase(),
          text,
          selectorHint: getUniqueSelector(el)
        });

        
        return;
      }
    }

    
    for (const child of el.children) {
      walkNode(child);
    }
  }

  
  for (const child of wrapperEl.children) {
    walkNode(child);
  }

  return {
    container: {
      tagName: wrapperEl.tagName.toLowerCase(),
      role: wrapperEl.getAttribute('role') || null,
      id: wrapperEl.id || null,
      classTokens: classTokens(wrapperEl),
      textSample: truncate(wrapperEl.innerText, 300),
      childElementCount: wrapperEl.children.length
    },
    controls,
    textBlocks,
    stats: {
      controlCount: controls.length,
      textBlockCount: textBlocks.length
    }
  };
}





const fieldCompatibility = {
  product_name(el) {
    
    const tag = el.tagName;
    const headings = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
    if (headings.includes(tag) || tag === 'SPAN' || tag === 'DIV' || tag === 'P') {
      return { compatible: true, reason: 'Text element suitable for product name.' };
    }
    return { compatible: false, reason: `Expected heading or text wrapper, got <${tag.toLowerCase()}>.` };
  },

  id(el) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'SELECT' || tag === 'INPUT' || tag === 'DIV') {
      if (tag === 'INPUT' && !['hidden', 'radio', 'text', ''].includes(type)) {
        return { compatible: false, reason: `Input type "${type}" is not typical for a product/variant selector.` };
      }
      return { compatible: true, reason: 'Control suitable for variant/product ID.' };
    }
    if (tag === 'BUTTON' || tag === 'A') {
      return { compatible: true, reason: 'Clickable element that may represent a variant option.' };
    }
    return { compatible: false, reason: `Unexpected element <${tag.toLowerCase()}> for product ID.` };
  },

  quantity(el) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['number', 'text', ''].includes(type)) {
      return { compatible: true, reason: 'Numeric input suitable for quantity.' };
    }
    if (tag === 'SELECT') {
      return { compatible: true, reason: 'Select dropdown suitable for quantity.' };
    }
    return { compatible: false, reason: `Expected numeric input or select for quantity, got <${tag.toLowerCase()}> type="${type}".` };
  },

  add_to_cart_button(el) {
    const tag = el.tagName;
    if (['BUTTON', 'INPUT', 'A'].includes(tag)) {
      
      if (isHidden(el)) {
        return { compatible: false, reason: 'CTA button is hidden.' };
      }
      return { compatible: true, reason: 'Clickable element suitable for CTA.' };
    }
    return { compatible: false, reason: `Expected button or link for CTA, got <${tag.toLowerCase()}>.` };
  },

  description(el) {
    const tag = el.tagName;
    if (['DIV', 'SECTION', 'ARTICLE', 'P', 'DETAILS', 'SPAN'].includes(tag)) {
      return { compatible: true, reason: 'Container suitable for product description.' };
    }
    return { compatible: false, reason: `Unexpected element <${tag.toLowerCase()}> for description.` };
  },

  
  _default(el) {
    return { compatible: true, reason: 'No specific compatibility check for this field.' };
  }
};



function resolveAiMatches(aiResponse) {
  const wrapperEl = getSelectedWrapperElement();
  if (!wrapperEl) {
    return { success: false, error: 'No wrapper element stored. Please repick the wrapper.' };
  }

  const warnings = [...(aiResponse.warnings || [])];
  const fields = [];

  for (const [fieldId, match] of Object.entries(aiResponse.matches || {})) {
    const localIds = match.localIds || [];
    const resolvedSelectors = [];
    const fieldWarnings = [];
    const fieldDef = getFieldDefinition(fieldId);

    if (localIds.length === 0) {
      fieldWarnings.push('No candidate localIds were returned by the model.');
    }

    for (const localId of localIds) {
      const el = localIdMap.get(localId);
      if (!el) {
        fieldWarnings.push(`localId "${localId}" could not be resolved to a DOM node.`);
        continue;
      }

      
      if (!wrapperEl.contains(el)) {
        fieldWarnings.push(`Element "${localId}" is no longer inside the wrapper.`);
        continue;
      }

      
      const checker = fieldCompatibility[fieldId] || fieldCompatibility._default;
      const compat = checker(el);
      if (!compat.compatible) {
        fieldWarnings.push(`${localId}: ${compat.reason}`);
        continue;
      }

      const selector = getUniqueSelector(el);
      if (selector && !resolvedSelectors.includes(selector)) {
        resolvedSelectors.push(selector);
      }
    }

    if (resolvedSelectors.length === 0) {
      fieldWarnings.push('No compatible DOM nodes were resolved for this field.');
    }

    if (fieldWarnings.length > 0) {
      warnings.push(`Field "${fieldId}": ${fieldWarnings.join('; ')}`);
    }

    fields.push({
      fieldId,
      role: fieldDef?.role || guessFieldRole(fieldId),
      selectors: resolvedSelectors,
      description: aiResponse.webmcp?.fieldDescriptions?.[fieldId] || `The ${fieldId} field.`,
      title: fieldDef?.label || fieldId,
      confidence: match.confidence || 0
    });
  }

  const annotation = {
    wrapperSelector: selectedWrapper?.selector || getUniqueSelector(wrapperEl),
    wrapperTagName: wrapperEl.tagName.toLowerCase(),
    tool: {
      name: aiResponse.webmcp?.toolName || aiResponse.tool || 'unknown_tool',
      description: aiResponse.webmcp?.toolDescription || '',
      autosubmit: true
    },
    fields,
    warnings
  };

  return { success: true, annotation };
}

function guessFieldRole(fieldId) {
  if (fieldId.includes('button') || fieldId.includes('cta') || fieldId === 'add_to_cart_button' || fieldId === 'search_button') {
    return 'cta';
  }
  if (fieldId === 'product_name' || fieldId === 'description') {
    return 'metadata';
  }
  return 'param';
}





function applyAnnotation(annotation) {
  
  let wrapperEl;
  try {
    wrapperEl = document.querySelector(annotation.wrapperSelector);
  } catch (e) {
    return { success: false, error: `Invalid wrapper selector: ${annotation.wrapperSelector}` };
  }

  if (!wrapperEl) {
    return { success: false, error: 'Wrapper element not found in DOM.' };
  }

  
  wrapperEl.setAttribute('toolname', annotation.tool.name);
  wrapperEl.setAttribute('tooldescription', annotation.tool.description);
  if (annotation.tool.autosubmit) {
    wrapperEl.setAttribute('toolautosubmit', '');
  } else {
    wrapperEl.removeAttribute('toolautosubmit');
  }

  const persistedFields = [];

  
  for (const field of annotation.fields) {
    if (!field.selectors || field.selectors.length === 0) continue;

    const matchedSelectors = [];

    for (const selector of field.selectors) {
      let el;
      try {
        el = document.querySelector(selector);
      } catch (e) {
        continue;
      }

      if (!el || !wrapperEl.contains(el)) {
        continue;
      }

      el.setAttribute('toolparamtitle', field.title);
      el.setAttribute('toolparamdescription', field.description);
      matchedSelectors.push(selector);
    }

    if (matchedSelectors.length === 0) {
      continue;
    }

    persistedFields.push({
      fieldId: field.fieldId,
      selectors: matchedSelectors,
      description: field.description,
      title: field.title
    });
  }

  
  return {
    success: true,
    selectorConfig: {
      hostname: window.location.hostname,
      templateId: selectedWrapper?.templateId || pickerTemplateId || '',
      wrapperSelector: annotation.wrapperSelector,
      toolName: annotation.tool.name,
      toolDescription: annotation.tool.description,
      autosubmit: annotation.tool.autosubmit,
      fields: persistedFields,
      updatedAt: new Date().toISOString()
    }
  };
}

function autoApplySavedAnnotations() {
  const hostname = window.location.hostname;
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    return;
  }

  chrome.storage.local.get(['webmcp_persisted_annotations'], (result) => {
    const allAnnotations = result.webmcp_persisted_annotations || {};
    const siteConfigs = allAnnotations[hostname];

    if (!siteConfigs || !Array.isArray(siteConfigs)) return;

    let appliedCount = 0;
    siteConfigs.forEach(config => {
      try {
        const wrapper = document.querySelector(config.wrapperSelector);
        if (!wrapper) return;

        
        wrapper.setAttribute('toolname', config.toolName);
        wrapper.setAttribute('tooldescription', config.toolDescription);
        if (config.autosubmit) {
          wrapper.setAttribute('toolautosubmit', '');
        } else {
          wrapper.removeAttribute('toolautosubmit');
        }

        
        if (Array.isArray(config.fields)) {
          config.fields.forEach(field => {
            const selectors = field.selectors || [];
            for (const sel of selectors) {
              try {
                const el = document.querySelector(sel);
                if (el && wrapper.contains(el)) {
                  el.setAttribute('toolparamtitle', field.title || field.fieldId);
                  el.setAttribute('toolparamdescription', field.description || '');
                  break;
                }
              } catch (e) { }
            }
          });
        }

        appliedCount++;
      } catch (e) {
        console.error('[WebMCP Annotator] Error applying saved annotation:', e);
      }
    });

    if (appliedCount > 0) {
      console.log(`[WebMCP Annotator] Auto-applied ${appliedCount} saved annotations for ${hostname}.`);
    }
  });
}

ensureWidget();

autoApplySavedAnnotations();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!IS_TOP_WINDOW) {
    return false;
  }

  switch (request.action) {
    case 'startWrapperPicker':
    case 'startManualPicker':
      startPicker(request.templateId);
      sendResponse({ success: true });
      break;

    case 'cancelWrapperPicker':
      stopPicker();
      sendResponse({ success: true });
      break;

    case 'runWrapperAiAnalysis':
      runWrapperAiAnalysis()
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;

    case 'getSelectedWrapperSummary':
      const wrapperEl = getSelectedWrapperElement();
      if (!wrapperEl) {
        sendResponse({ success: false, error: 'No wrapper selected.' });
      } else {
        const wrapper = refreshSelectedWrapper(wrapperEl);
        const domSummary = buildWrapperDomSummary(wrapperEl);

        sendResponse({
          success: true,
          action: 'wrapperSummaryReady',
          wrapper,
          domSummary
        });
      }
      break;

    case 'resolveAiMatches':
      const resolution = resolveAiMatches(request.aiResponse);
      sendResponse({
        action: 'resolvedAnnotationReady',
        ...resolution
      });
      break;

    case 'applyProposedAnnotation':
      const result = applyAnnotation(request.annotation);
      sendResponse({
        action: 'applyResult',
        ...result
      });
      break;

    default:
      sendResponse({ success: false, error: `Unknown action: ${request.action}` });
  }

  return true; 
});
