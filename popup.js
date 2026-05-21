/**
 * @fileoverview Extension popup controller.
 * @description Manages local settings for model and API key, validates model selection, and renders status feedback for save and initialization actions.
 */

const apiKeyInput = document.getElementById('settings-api-key');
const modelSelect = document.getElementById('settings-model');
const toggleKeyBtn = document.getElementById('toggle-key');
const btnSaveSettings = document.getElementById('btn-save-settings');

const statusBox = document.getElementById('status');
const statusText = statusBox?.querySelector('.status-text');
const statusCloseBtn = document.getElementById('status-close');
let statusTimer = null;

const SUPPORTED_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-light', 'gemma-4-31b-it'];

const safeStorage = {
  get: async (keys) => {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  },
  set: async (data) => {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }
};

function setStatus(message, type = 'info', timeoutMs = 4000) {
  if (!statusBox || !statusText) return;
  if (statusTimer) {
    window.clearTimeout(statusTimer);
    statusTimer = null;
  }

  statusText.textContent = message;
  statusBox.className = `status-box ${type}`;

  if (timeoutMs > 0) {
    statusTimer = window.setTimeout(() => {
      statusBox.className = 'status-box';
      statusTimer = null;
    }, timeoutMs);
  }
}

async function loadSettings() {
  const result = await safeStorage.get(['settings_api_key', 'settings_model']);
  if (apiKeyInput) apiKeyInput.value = result.settings_api_key || '';

  const savedModel = result.settings_model;
  if (modelSelect) {
    modelSelect.value = SUPPORTED_MODELS.includes(savedModel) ? savedModel : SUPPORTED_MODELS[0];
  }
}

async function saveSettings() {
  const apiKey = (apiKeyInput?.value || '').trim();
  const model = modelSelect?.value || SUPPORTED_MODELS[0];

  if (!SUPPORTED_MODELS.includes(model)) {
    setStatus('Unsupported model selected.', 'error');
    return;
  }

  await safeStorage.set({
    settings_api_key: apiKey,
    settings_model: model
  });

  setStatus('Settings saved.', 'success');
}

function attachEventListeners() {
  statusCloseBtn?.addEventListener('click', () => {
    if (!statusBox) return;
    if (statusTimer) {
      window.clearTimeout(statusTimer);
      statusTimer = null;
    }
    statusBox.className = 'status-box';
  });

  toggleKeyBtn?.addEventListener('click', () => {
    if (!apiKeyInput) return;
    const hidden = apiKeyInput.type === 'password';
    apiKeyInput.type = hidden ? 'text' : 'password';
    toggleKeyBtn.textContent = hidden ? 'Hide' : 'Show';
  });

  btnSaveSettings?.addEventListener('click', saveSettings);
}

async function init() {
  attachEventListeners();
  await loadSettings();
}

init().catch(() => {
  setStatus('Failed to initialize popup.', 'error', 7000);
});
