# webmcp-annotator

Browser extension to annotate webpages for AI agents.

## Chrome Extension boilerplate (Manifest V3)

This repository now contains a minimal, installable Chrome extension.

### Install in Chrome (unpacked)

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this folder:
   `/home/runner/work/webmcp-annotator/webmcp-annotator`
5. Pin/open the extension and click **Annotate H1**

### What it does

- The popup contains one button.
- On click, it safely runs only on the active tab via `activeTab` + `chrome.scripting.executeScript`.
- It finds the first `<h1>` and applies:
  - `font-size: 150px !important`
  - `font-weight: 800 !important`
  - `color: red !important`
- It also sets `tool="page heading"` on that `<h1>`.

No persistent content script is injected; changes happen only when you click the button.
