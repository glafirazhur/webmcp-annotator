# Walkthrough: AI-Powered WebMCP Annotator

I have fully implemented the AI-powered WebMCP Annotator browser extension. Here is an overview of the architecture, key components, and testing guidelines.

---

## 🛠️ Changes Implemented

### 1. Manifest Upgrades ([manifest.json](file:///c:/Users/glafi/Projects/webmcp-annotator/manifest.json))
- Added the `"storage"` permission to support domain persistence and API settings.
- Allowed host permissions for the Gemini API (`https://generativelanguage.googleapis.com/*`).
- Configured a persistent content script (`content_script.js`) injected into all pages.

### 2. Extensible Tool Templates ([templates.js](file:///c:/Users/glafi/Projects/webmcp-annotator/templates.js))
- Created a registry for WebMCP tool types (currently supporting "Add to Cart" and "Product Search").
- Adding new WebMCP tool definitions only requires appending them to this registry. The AI prompt uses this config to find elements dynamically.

### 3. Client-Side Controller ([popup.js](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.js))
- **Settings tab**: Pre-populates the default API key (`AIzaSyBsIVMLuYF_weq317143VlbyyiJyKQ3HUM`) and handles model mappings (Gemini 3.5 Flash, Gemini 3.1 Flash Light, Gemma 4 31B).
- **AI Scanning**: Extracts candidate page elements, sends them to Gemini via a structured JSON schema prompt, and handles responses.
- **Throttling/Rate Limiter**: Persists request timestamps and blocks calls if they exceed **4 requests per minute**, displaying a warning to the user.

### 4. Interactive Page Handler ([content_script.js](file:///c:/Users/glafi/Projects/webmcp-annotator/content_script.js))
- **DOM Preprocessor**: Formats forms and buttons into a lightweight JSON model for the AI prompt.
- **Markup Applier**: Attaches standard WebMCP attributes (`toolname`, `tooldescription`, `toolautosubmit`, `toolparamtitle`, `toolparamdescription`, `tool-param-description`).
- **Manual Element Picker**: Overlays a hover highlight border allowing visual elements targeting.
- **Automatic Persistence**: Detects page loads, matches stored selectors for the domain, and auto-injects saved annotations **without calling the Gemini API**.

---

## 🧪 Verification & Manual Testing Guide

I created a custom test page in the project root: [test_page.html](file:///c:/Users/glafi/Projects/webmcp-annotator/test_page.html). You can use it to verify the extension:

### Step 1: Install the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** (top-left).
4. Select the project root folder: `c:\Users\glafi\Projects\webmcp-annotator`

> [!NOTE]
> If you have already loaded the extension earlier, you **must click the circular Reload icon** on the WebMCP Annotator card in `chrome://extensions/` for the new manifest storage permissions to activate.
> We have implemented a `safeStorage` wrapper to fall back to standard `localStorage` and prevent crashes if the extension hasn't been reloaded yet, but reload is required for persistence on web pages.

### Step 2: Open the Test Page
1. Open [test_page.html](file:///c:/Users/glafi/Projects/webmcp-annotator/test_page.html) in your browser.
2. The page contains:
   - A standard HTML form for Product 1 (Ultimate Wireless Headphones).
   - A custom JavaScript-only click-event button for Product 2 (Smartwatch Active Pro).
   - A Product Search form in the header.

### Step 3: Run AI Scan & Annotate
1. Click the WebMCP Annotator icon to open the popup.
2. Verify the pre-populated key in **Settings** (or save a new one). Select **Gemini 3.5 Flash**.
3. Under **Annotate**:
   - Select **Add to Cart** and click **AI Scan Page**.
   - Gemini will identify the form for Product 1 (or the JS button for Product 2), map the ID and quantity inputs, and display the suggestion.
   - Click **Apply & Persist Markup**.
4. The web page DOM will update instantly (the test page has CSS styles that will draw an green box outline labeled `WebMCP Tool: add_to_cart` and purple outlines around the mapped parameters).

### Step 4: Verify Persistence
1. Reload the page.
2. The green/purple annotations should be re-applied automatically.
3. Open the popup, click the **Saved** tab, and verify that the selectors for `test_page.html` are active. (No API requests are executed on reload).

### Step 5: Test Rate Limiting
1. Rapidly click **AI Scan Page** 5 times.
2. On the 5th attempt, verify that the status box shows: `Rate limit reached: Please wait X seconds before scanning again.`
