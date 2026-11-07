# WebMCP Annotator

**WebMCP Annotator** is a Chrome extension that uses AI vision to turn any interactive section of a webpage—such as a product card, search bar, or filter panel—into an AI-ready **WebMCP tool**, even when the website uses custom visual buttons instead of standard HTML forms.

---

## How It Works

Many modern websites do not use traditional `<form>` tags or standard `<input>` fields. Instead, options like size pickers (`S`, `M`, `L`), color swatches, or custom dropdowns are built purely visually.

WebMCP Annotator solves this by combining **what the page looks like** with **how the page is built**:

1. **You pick a section** of any webpage.
2. **The extension takes a snapshot**: It captures a screenshot of that visible area along with a lightweight list of elements inside it.
3. **AI analyzes both together**: Gemini looks at the screenshot and the page structure at the same time to guess which elements are interactive controls and what each one does.
4. **Automatic tagging & visual preview**: The extension injects standard WebMCP attributes directly onto the page and highlights all discovered controls with a color-coded legend.

---

## Quick Start

### 1. Install the Extension
1. Open Chrome and go to `chrome://extensions/`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.

### 2. Add Your AI Key
1. Click the **WebMCP Annotator** icon in your Chrome toolbar.
2. Paste your **Gemini API Key**, choose a model, and click **Save Settings**.

### 3. Annotate Any Webpage
1. Open any webpage and click the **Open WebMCP Annotator** badge in the top-right corner.
2. Click **Pick wrapper**, then click on a section of the page (for example, a product card or search area).
   > *Tip: Screenshot capture uses only the visible screen area. Zoom out in your browser (`Ctrl/Cmd` + `-`) if you want to capture a larger block.*
3. Click **Run AI** and wait a few seconds for the analysis to complete.
4. Click **Inject Markup** to apply the WebMCP attributes and see the visual highlights on the page.
5. Use **Hide Elements / Show Elements** to toggle the visual boxes and legend at any time, or **Clear** to start over.

---

## What the Highlights Mean

When you click **Inject Markup**, the extension draws color-coded boxes on the page and opens a draggable **Annotation legend**:

- **Blue (`C` — Container)**: The main wrapper for the tool. Receives:
  - `toolname` — Name of the action (e.g., `add_to_cart`).
  - `tooldescription` — Summary of what the tool does.
  - `toolautosubmit` — Added when changing an option immediately updates the page without clicking a submit button.
- **Green (`1, 2, …` — Standard Controls)**: Standard form elements (inputs, dropdowns, buttons) that are ready for WebMCP right away. Each receives:
  - `toolparamdescription` — Plain-language description of what the control sets or changes.
- **Orange (`P1, P2, …` — Suggested Custom Controls)**: Elements that act like buttons or options visually (such as custom size or color pickers) but are built without standard form inputs. The legend explains why each one was flagged and suggests the `toolparamdescription` it should have.

> **Parameter Identity in the Legend**: For every highlighted control, the legend also displays its HTML tag/type, `name` attribute (or `name: none`), and computed `accessibleName` (or notes when the AI inferred its purpose visually from the UI).

---

## Main Project Files

- `manifest.json` — Chrome Extension (Manifest V3) configuration.
- `background.js` — Captures/crops the wrapper screenshot and sends the visual + DOM request to the Gemini API.
- `content_script.js` — Runs the in-page floating widget, element picker, DOM scanner, attribute injector, and visual legend.
- `widget.css` — Styles for the in-page floating widget and annotation overlays (isolated inside Shadow DOM).
- `popup.html` / `popup.js` / `popup.css` — Extension toolbar popup for saving your API key and model.
