# Rewrite WebMCP Annotator → Wrapper-First Flow

## Overview

Rewrite the entire extension from a **full-page AI scan** approach to a **wrapper-first annotation flow** as described in [webmcp-wrapper-flow-plan.md](file:///c:/Users/glafi/Projects/webmcp-annotator/prompts/webmcp-wrapper-flow-plan.md).

### Key architectural changes

| Aspect | Current | New |
|---|---|---|
| Selection target | Forms, buttons, inputs | Any wrapper/container element |
| AI input | Text-only (JSON of all page candidates) | Multimodal (cropped screenshot + wrapper-only DOM summary) |
| AI output | `targetIdx` pointing to a flat list | `localIds` from the DOM summary |
| Screenshot | None | Background service worker captures & crops |
| DOM summary | Entire page interactive elements | Compact wrapper-only summary with `ctl_XX` / `txt_XX` IDs |
| Flow control | Single-step scan | State machine with 10 stages |
| Template schema | Simple `parameters[]` | Rich `fields[]` with `webmcpTarget`, `domHints`, `visionHints` |
| Resolution | Direct idx → element | localId → DOM node + compatibility checks |
| Review | Minimal editor panel | Full review screen with confidence, warnings, overrides |

---

## Proposed Changes

### Phase 1: Foundation — Manifest & Templates

#### [MODIFY] [manifest.json](file:///c:/Users/glafi/Projects/webmcp-annotator/manifest.json)

- Add `"background"` section with service worker pointing to new `background.js`
- Add `"tabs"` to permissions (needed for `chrome.tabs.captureVisibleTab`)
- Keep existing permissions (`activeTab`, `scripting`, `storage`)

#### [MODIFY] [templates.js](file:///c:/Users/glafi/Projects/webmcp-annotator/templates.js)

Complete rewrite to match the plan's `ToolTemplate` / `ToolField` types:
- Each template gets `fields[]` instead of `parameters[]`
- Each field gets `webmcpTarget` (`"cta"` | `"param"` | `"metadata"`), `domHints`, and `visionHints`
- MVP focuses on `add_to_cart` template with fields: `product_name`, `id`, `quantity`, `add_to_cart_button`, `description`
- Keep `search_products` as a secondary template

---

### Phase 2: Background Service Worker — Screenshot Pipeline

#### [NEW] [background.js](file:///c:/Users/glafi/Projects/webmcp-annotator/background.js)

New background service worker responsible for:
- Listening for `captureWrapperScreenshot` messages from popup
- Calling `chrome.tabs.captureVisibleTab()` to get full viewport screenshot
- Cropping to the wrapper's bounding rect (accounting for `devicePixelRatio`)
- Using `OffscreenCanvas` (available in service workers) for crop
- Returning `WrapperScreenshot` object (`base64`, dimensions, source rect)
- Error handling for quota limits, offscreen elements, blank crops

---

### Phase 3: Content Script — Wrapper Picker + DOM Summary + Resolution

#### [MODIFY] [content_script.js](file:///c:/Users/glafi/Projects/webmcp-annotator/content_script.js)

Complete rewrite. New responsibilities:

**Wrapper Picker (replaces old picker)**
- `startWrapperPicker(templateId)`: Enter picker mode — hover highlights **any** element (not just forms/buttons)
- Hover overlay shows element tag, size, and child count
- Click stores `SelectedWrapper` (selector, XPath, tagName, rect with scrollX/scrollY/devicePixelRatio, preview)
- `cancelWrapperPicker()`: Clean exit from picker mode

**DOM Summary Extraction**
- `buildWrapperDomSummary(wrapperEl)`: Extracts `WrapperDomSummary` from inside the selected wrapper only
- Generates stable local IDs: `ctl_01`, `ctl_02` for controls; `txt_01`, `txt_02` for text blocks
- Stores a `localId → element` map in memory for later resolution
- Includes container metadata, controls (button/input/select/textarea/a[role=button]), text blocks (headings, labels, meaningful text), with normalization (trim, collapse whitespace, limit lengths)
- Excludes script, style, SVG decoration, long prose

**Local DOM Resolution**
- `resolveAiMatches(aiResponse)`: Maps `localIds` from AI response back to real DOM nodes
- Field-specific compatibility checks (CTA must be clickable, quantity must be numeric input, etc.)
- Produces `ProposedAnnotation` with warnings

**Attribute Application**
- `applyProposedAnnotation(annotation)`: Applies WebMCP attributes to resolved nodes
- Wrapper gets `toolname`, `tooldescription`, `toolautosubmit`
- Fields get `toolparamtitle`, `toolparamdescription`
- Returns `selectorConfig` for persistence

**Auto-apply on load** (kept from current code, adapted to new persistence format)

**Message listener** — new message contracts:
```
startWrapperPicker → starts picker
cancelWrapperPicker → stops picker
getSelectedWrapperSummary → returns wrapper + domSummary
resolveAiMatches → returns ProposedAnnotation
applyProposedAnnotation → applies attributes, returns selectorConfig
```

---

### Phase 4: Popup HTML — New UI Structure

#### [MODIFY] [popup.html](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.html)

Rewrite the Annotate tab to support the flow state machine stages:

1. **Idle / Template selection**: Template dropdown + "Pick Wrapper" button (replaces "AI Scan Page" + "Target Picker")
2. **Picking wrapper**: Status message telling user to pick an element on the page
3. **Wrapper selected**: Preview card showing selected wrapper info (tag, selector, text sample, child count)
4. **Screenshot preview**: Shows the cropped wrapper image
5. **DOM summary preview** (debug): Collapsible section showing summary JSON
6. **AI analyzing**: Spinner with progress message
7. **Review screen**: Full review UI showing:
   - Cropped screenshot thumbnail
   - Field-to-node mapping table with confidence scores
   - Warnings list
   - Suggested tool name / description (editable)
   - Accept / Retry AI / Repick Wrapper / Manual Override buttons
8. **Applying**: Progress indicator
9. **Done**: Success message with link to Saved tab
10. **Error**: Error message with retry options

Keep Settings and Saved tabs largely the same, but update Saved tab to show new `SavedAnnotationConfig` format.

---

### Phase 5: Popup JS — Flow State Machine + Multimodal AI

#### [MODIFY] [popup.js](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.js)

Complete rewrite. Key changes:

**Flow state machine**
- `FlowState` object tracking: `stage`, `templateId`, `wrapper`, `screenshot`, `domSummary`, `aiResponse`, `proposedAnnotation`, `error`
- `setFlowStage(stage)` function that shows/hides the correct UI panels
- Clean transitions between stages with error recovery

**Step 1 — Template selection + Pick Wrapper**
- User selects template → clicks "Pick Wrapper" → sends `startWrapperPicker` to content script
- Listens for `wrapperPicked` message back → transitions to `wrapper_selected`

**Step 2 — Screenshot capture**
- Sends `captureWrapperScreenshot` to background with tab ID and wrapper rect
- Receives `wrapperScreenshotReady` → stores screenshot, shows preview
- Transitions to `building_dom_summary`

**Step 3 — DOM summary**
- Sends `getSelectedWrapperSummary` to content script
- Receives `wrapperSummaryReady` → stores summary
- Auto-transitions to `analyzing_with_ai`

**Step 4 — Multimodal AI call**
- Builds multimodal request with:
  - Cropped image as `inlineData` (base64 PNG)
  - Task instruction text
  - Template field list
  - DOM summary JSON
  - Strict response schema matching `AnalyzeWrapperResponse`
- Uses `generateContent` with `responseMimeType: 'application/json'` + `responseSchema`
- Validates response structure
- Transitions to `resolving_matches`

**Step 5 — Local resolution**
- Sends `resolveAiMatches` to content script with AI response
- Receives `resolvedAnnotationReady` → stores `ProposedAnnotation`
- Transitions to `review_ready`

**Step 6 — Review & Apply**
- Displays review screen from `ProposedAnnotation`
- User can Accept → sends `applyProposedAnnotation` → persist to storage
- User can Retry AI → back to `analyzing_with_ai`
- User can Repick Wrapper → back to `picking_wrapper`

**Remove old code**
- Remove `extractInteractiveCandidates` call pattern
- Remove `buildCompactCandidates`, `buildGeminiSchema` (text-only schema)
- Remove old `callGeminiAPI` (replace with multimodal version)
- Remove `runAiScan` (replace with flow state machine)
- Remove `startManualPicker` (replace with `startWrapperPicker`)
- Remove old `applyMarkup` (replace with flow-based apply)
- Remove `DEFAULT_API_KEY` hardcoded value

---

### Phase 6: Popup CSS — New UI Components

#### [MODIFY] [popup.css](file:///c:/Users/glafi/Projects/webmcp-annotator/popup.css)

Add styles for new components:
- **Wrapper preview card**: Shows selected wrapper info with tag badge, selector, text sample
- **Screenshot preview**: Image container with border, max-height, aspect ratio
- **Flow progress indicator**: Step dots or stage label showing current position in flow
- **Review table**: Field mapping table with confidence bars, warning icons
- **Warning pills**: Yellow/orange badges for warnings
- **Confidence indicator**: Color-coded confidence score (green/yellow/red)
- **Debug panel**: Collapsible section for DOM summary JSON
- **Action button group**: Accept / Retry / Repick grouped buttons

Keep existing design system (dark theme, gradients, glassmorphism, Plus Jakarta Sans).

---

## Open Questions

> [!IMPORTANT]
> **API Key**: The current code has a hardcoded `DEFAULT_API_KEY`. The plan says to remove it. Should I remove it entirely, or keep it as a fallback for development?

> [!IMPORTANT]
> **Screenshot crop approach**: Service workers can use `OffscreenCanvas` for image cropping. An alternative is to create an offscreen document. Which approach do you prefer, or should I go with `OffscreenCanvas` as the simpler option?

> [!IMPORTANT]
> **Debug mode**: The plan mentions a debug UI showing raw JSON, DOM summary, etc. Should this be a separate tab, a collapsible section within the Annotate tab, or a toggle in Settings?

---

## Verification Plan

### Manual Verification
1. Load extension in Chrome → verify no console errors
2. Open [test_page.html](file:///c:/Users/glafi/Projects/webmcp-annotator/test_page.html) → pick wrapper around product card
3. Verify screenshot preview shows cropped region
4. Verify DOM summary contains expected controls and text blocks
5. Verify AI returns structured response with localIds
6. Verify review screen shows field mappings
7. Verify Apply persists annotations and they auto-apply on reload
8. Verify Saved tab shows new format
9. Test error paths: cancel picker, invalid API key, AI returns no match
