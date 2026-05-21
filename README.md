# WebMCP Annotator

WebMCP Annotator is a Chrome extension that helps map page elements to WebMCP tool fields using an AI-assisted wrapper workflow.

## What It Does

1. Lets you select a wrapper on the current page.
2. Captures a screenshot and DOM summary for that wrapper.
3. Sends both to Gemini for field mapping.
4. Lets you validate mappings in the in-page widget.
5. Applies and persists WebMCP attributes on confirmed elements.

Screenshot capture uses only the currently visible viewport.
Use Browser Zoom in case you want to capture a bigger area.

## Installation

1. Open chrome://extensions/
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this repository folder.
5. Reload the extension after updates.

## Usage

1. Open the popup and configure:
1. Google AI Studio API key
1. Model selection
2. Open a website page.
3. Use the in-page widget:
1. Select a template
1. Click Pick Target
1. Click a wrapper on the page
4. Click Run AI On Selection.
5. In AI Validation:
1. Review each field
1. Accept or adjust selectors
1. Ensure required fields are valid
6. Click Apply Validated Markup.

Applied attributes include:
- toolname
- tooldescription
- toolparamtitle
- toolparamdescription
- toolautosubmit (when enabled)

## Persistence

Annotation configs are saved in local extension storage by hostname and auto-applied on revisit.

## Project Structure

- popup.css: popup-only styles
- widget.css: in-page widget-only styles
- test_page.css: test page-only styles
- popup.js: popup settings logic
- content_script.js: in-page widget and annotation runtime
- background.js: screenshot capture and cropping service worker
- templates.js: tool template definitions

## Local Test Page

Use test_page.html to test the complete flow with sample product cards and search controls.
