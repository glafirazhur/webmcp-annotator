/**
 * @fileoverview Popup controller — save/load API key and model.
 */

const apiKeyInput = document.getElementById('settings-api-key');
const modelSelect = document.getElementById('settings-model');
const toggleKeyBtn = document.getElementById('toggle-key');
const saveBtn = document.getElementById('btn-save-settings');
const statusBox = document.getElementById('status');
const statusText = statusBox?.querySelector('.status-text');
const statusCloseBtn = document.getElementById('status-close');

const SUPPORTED_MODELS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemma-4-31b-it'];

function clearStatus() {
  if (!statusBox) return;
  statusBox.className = 'status-box';
}

function setStatus(message, type = 'info') {
  if (!statusBox || !statusText) return;
  statusText.textContent = message;
  statusBox.className = `status-box is-visible ${type}`;
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['settings_api_key', 'settings_model']);

  if (apiKeyInput) {
    apiKeyInput.value = result.settings_api_key || '';
  }

  if (modelSelect) {
    modelSelect.value = SUPPORTED_MODELS.includes(result.settings_model)
      ? result.settings_model
      : SUPPORTED_MODELS[0];
  }
}

async function saveSettings() {
  const apiKey = (apiKeyInput?.value || '').trim();
  const model = modelSelect?.value || SUPPORTED_MODELS[0];

  if (!SUPPORTED_MODELS.includes(model)) {
    setStatus('Unsupported model.', 'error');
    return;
  }

  await chrome.storage.local.set({
    settings_api_key: apiKey,
    settings_model: model
  });

  setStatus('Settings saved.', 'success');
}

statusCloseBtn?.addEventListener('click', clearStatus);

toggleKeyBtn?.addEventListener('click', () => {
  if (!apiKeyInput) return;

  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  toggleKeyBtn.textContent = hidden ? 'Hide' : 'Show';
});

saveBtn?.addEventListener('click', saveSettings);

loadSettings().catch(() => {
  setStatus('Failed to load settings.', 'error');
});