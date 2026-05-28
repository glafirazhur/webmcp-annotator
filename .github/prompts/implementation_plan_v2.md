# Feature Plan: AI-Powered WebMCP Annotator (via Google AI Studio) - Final

This feature introduces an AI-powered detection and annotation engine into the WebMCP Annotator browser extension. The extension will send a minified structural snapshot of the web page's interactive elements to a user-selected Gemini model via Google AI Studio. The model will identify candidate tools (like "Add to Cart" forms or buttons) and map their parameter inputs. The extension will then automatically inject the WebMCP markup and persist the configuration.

---

## User Review Required

> [!IMPORTANT]
> **API Key & Models Selection**:
> - Default API Key: `AIzaSyBsIVMLuYF_weq317143VlbyyiJyKQ3HUM`. This key will be pre-populated as the default.
> - Models dropdown:
>   1. **Gemini 3.5 Flash** (identifier: `gemini-2.5-flash` or fallback `gemini-2.0-flash`)
>   2. **Gemini 3.1 Flash Light** (identifier: `gemini-2.0-flash-lite` or fallback `gemini-1.5-flash`)
>   3. **Gemma 4 31B** (identifier: `gemma-2-27b` or custom endpoint)
>   *Note: We will map these developer-friendly display names to the corresponding stable Google AI Studio API identifiers, with an editable input for custom endpoints.*

> [!WARNING]
> **Rate Limiting**:
> To comply with the free-tier or customized limits, the extension will throttle API requests:
> - **Max 4 requests per minute**.
> - We will persist request timestamps in `chrome.storage.local` to enforce this rule across popup closes and tab switches. If exceeded, the UI will display a rate-limit warning.

> [!NOTE]
> **Persistence & Performance**:
> When a page is reloaded, the extension **will not** make any AI API requests. The persistence content script will retrieve the previously saved CSS selectors and annotations from `chrome.storage.local` and apply them directly to the DOM.

---

## Proposed Architecture & Workflow

### 1. The DOM Mini-Map Generator (Content Script)
To avoid sending massive HTML trees to Gemini, the content script will extract only interactive components.
- Temporary IDs (`data-webmcp-idx="N"`) will be assigned to candidates (forms, buttons, inputs, selects).
- A minified JSON description of the candidate elements will be constructed:
```json
[
  {
    "idx": 0,
    "tagName": "FORM",
    "attributes": { "class": "shopify-product-form", "action": "/cart/add" },
    "children": [
      { "idx": 1, "tagName": "SELECT", "attributes": { "name": "id", "class": "variant-selector" } },
      { "idx": 2, "tagName": "INPUT", "attributes": { "name": "quantity", "type": "number", "value": "1" } },
      { "idx": 3, "tagName": "BUTTON", "text": "Add to Cart" }
    ]
  }
]
```

### 2. Rate Limiting Implementation
Before making any API call, the script reads `api_call_timestamps` from `chrome.storage.local`.
- It filters out timestamps older than 60 seconds.
- If the remaining list has 4 or more entries, it blocks the call and shows a countdown in the popup.
- Otherwise, it appends the current timestamp, writes back to storage, and executes the API request.

### 3. Gemini System Prompt and Schema Execution
We will call the Gemini API directly from the background or popup script. We will request a structured JSON response:
- **Endpoint**: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- **Response Schema**: JSON format returning the matching target index and mapped parameter indices.

---

## Detailed File Changes

### [MODIFY] [manifest.json](file:///c:/Users/glafi/Projects/webmcp-annotator/manifest.json)
- Add `"storage"` permission to save settings (API key, model, rate limit timestamps) and page selectors.
- Add `host_permissions` for `https://generativelanguage.googleapis.com/*` so the extension can make direct outbound fetch calls.

### [NEW] [templates.js](file:///c:/Users/glafi/Projects/webmcp-annotator/templates.js)
Define WebMCP tools as JSON specifications. These configurations will be fed directly to the Gemini prompt generator.

### [NEW] [content_script.js](file:///c:/Users/glafi/Projects/webmcp-annotator/content_script.js)
- **DOM Scanner**: Assigns `data-webmcp-idx` to forms, buttons, inputs, selects, and maps them to a compact JSON tree.
- **Markup Applier**: Receives the target element indices from the popup, maps them back to real DOM nodes, applies the WebMCP attributes, and generates/saves a unique CSS selector.
- **Persistence Runner**: Automatically fires on load, retrieves CSS selector mappings for the active host/domain from `chrome.storage.local`, and injects the WebMCP markup (no AI calls).

### [MODIFY] [popup.html](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.html)
- Redesign using a premium dark glassmorphism layout with three tabs:
  1. **Annotate**: Choose a tool template, click "AI Find Candidates", view the AI-detected matches, and click "Inject Markup".
  2. **Saved Tools**: View and delete stored annotations for the current domain.
  3. **Settings**: Paste Google AI Studio API Key (defaulting to the specified key) and select model.

### [MODIFY] [popup.js](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.js)
- Handle tab-switching and settings.
- Implement rate limiting check.
- Invoke the Gemini API, parse the JSON, and call the content script to inject the attributes.

---

## Verification Plan

### Automated / Manual Verification
1. Verify API Key and Model selections in Settings.
2. Scan a page and verify rate limiting blocks the 5th scan within a minute.
3. Apply markup and refresh the page to verify annotations are applied immediately *without* initiating any API request.
