# Wrapper-First WebMCP Annotation Flow

## Overview

This document describes a wrapper-first annotation flow for a browser extension that helps a user annotate e-commerce add-to-cart interfaces for WebMCP.

The main idea is to let the user manually pick a likely wrapper element on the page, capture a screenshot of that selected region, send the cropped image together with a compact DOM summary to a multimodal model, receive a structured JSON response, resolve the returned candidates against real DOM nodes inside the selected wrapper, and finally apply WebMCP attributes.

This approach keeps the human in the loop for the most ambiguous step, which is choosing the relevant visual region. It should reduce prompt size and visual noise compared with a full-page scan, while still giving the model enough semantic context to suggest useful field candidates.

## Why this flow

A wrapper-first flow is likely to be more reliable than a whole-page AI scan because the user explicitly narrows the search space before any model call.

A screenshot of the selected region can be captured in an extension by taking a visible-tab screenshot and cropping it to the selected element bounds, rather than by relying on a direct DevTools-only feature path.[cite:57]

Chrome and Chromium-based tooling expose node-level screenshot functionality in DevTools, which supports the product idea that a selected DOM node can be represented as a focused image region for model analysis.[cite:64][cite:67][cite:68]

The screenshot step should remain user-triggered and rate-limited, because `captureVisibleTab` has practical quota constraints and is not suitable for aggressive repeated capture loops.[cite:57][cite:58][cite:94]

Multimodal requests that combine image and text are a supported pattern in Gemini-style APIs, and structured outputs can be used to constrain the response into a predictable JSON object.[cite:85][cite:97]

## Product goals

The flow should support the following product goals:

- Let the user pick a wrapper visually, similar to hovering an element in DevTools.
- Capture only the selected wrapper region, not the whole page.
- Send a compact multimodal request: cropped image plus wrapper-only DOM summary.
- Receive JSON that maps template fields to candidate elements inside the wrapper.
- Resolve candidates locally in the DOM rather than asking the model for CSS selectors.
- Preview the matches and allow review before applying WebMCP attributes.
- Persist the annotation configuration per domain.

## Non-goals

The first version should not attempt to:

- Fully automate wrapper discovery on the whole page.
- Ask the model to generate or guess CSS selectors.
- Annotate every possible tool type in one release.
- Capture offscreen full-page stitched screenshots.
- Eliminate human review before applying markup.

## Scope for MVP

The recommended MVP scope is a single template, `add_to_cart`, because it has a clear visual structure and a strong business case.

The MVP should focus on finding these fields inside a chosen wrapper:

- `product_name`
- `id` or variant selector
- `quantity`
- `add_to_cart_button`
- `description`

## High-level architecture

The system is split into four layers:

1. **Popup UI**: starts the flow, displays progress, previews model suggestions, and confirms application.
2. **Content script**: handles hover highlight, wrapper selection, DOM summary extraction, local match resolution, and attribute application.
3. **Background or service worker**: captures the visible tab and crops the selected region.
4. **AI adapter**: builds the multimodal request and validates the structured JSON response.

## End-to-end flow

### 1. Template selection

The user opens the extension popup and chooses a tool template such as `add_to_cart`.

The popup loads the template profile, field definitions, and any tool-specific hints used by the UI or local matchers.

### 2. Wrapper picking mode

The user activates `Pick wrapper`.

The content script enters picker mode and renders a hover overlay that highlights the element currently under the pointer. The interaction should feel similar to the DevTools node highlight.

When the user clicks, the content script stores the selected wrapper element together with a stable selector, an optional XPath, a text sample, and the current bounding rectangle.

### 3. Wrapper normalization

After the click, the extension normalizes the chosen wrapper.

This step can optionally walk up or down a few ancestors and descendants if the selected node is obviously too small or too large, but the first MVP can simply use the exact user-selected element.

### 4. Screenshot capture

The content script ensures the wrapper is visible in the viewport.

The background layer captures the visible tab and crops the image to the wrapper rectangle. The crop logic must account for `devicePixelRatio`, otherwise coordinates will drift on HiDPI screens.[cite:50][cite:54]

The popup shows a preview of the cropped screenshot and stores it in temporary flow state.

### 5. Wrapper-only DOM summary

The content script extracts a compact DOM summary only from inside the selected wrapper.

The summary should include the container metadata, interactive controls, meaningful text blocks, labels, and a small amount of technical metadata such as `name`, `id`, `type`, `aria-label`, and `placeholder`.

The summary should not contain raw HTML. It should instead be a normalized JSON object with stable local IDs such as `ctl_01` and `txt_01`.

### 6. Multimodal model analysis

The popup or AI adapter sends a request that contains:

- The cropped image.
- A short task instruction.
- The tool template profile.
- The wrapper-only DOM summary.
- A strict response schema.

The model returns a structured JSON object that describes the wrapper type, field matches, confidence, optional warnings, and suggested WebMCP texts.

The model should return `localIds` from the DOM summary instead of selectors. This keeps the DOM resolution step deterministic and easier to debug.

### 7. Local DOM resolution

The content script resolves the returned `localIds` back to real DOM nodes inside the wrapper.

Each returned field is validated against local compatibility rules. For example, a CTA must resolve to a clickable element, while quantity should resolve to a numeric input, select, or equivalent stepper control.

If a field fails compatibility checks, the system should raise a warning and avoid blind auto-application.

### 8. Review screen

The popup presents the proposed annotation:

- Selected wrapper preview.
- Cropped image preview.
- Field-to-node mapping.
- Confidence and warnings.
- Suggested `toolname`, `tooldescription`, and field descriptions.

The user can then accept all, retry the AI step, repick the wrapper, or override individual field matches.

### 9. Apply WebMCP markup

After confirmation, the content script applies WebMCP-related attributes to the resolved nodes.

The wrapper receives the tool-level metadata, while parameter or metadata nodes receive the relevant field-level titles and descriptions.

### 10. Persist configuration

The extension stores the saved annotation configuration per domain so that it can be re-applied or edited later.

Persistence should store stable selectors and tool metadata, not screenshots or temporary local IDs.

## Core data structures

### ToolTemplate

```ts
export type ToolTemplate = {
  id: string;
  name: string;
  description: string;
  defaultToolName: string;
  defaultToolDescription: string;
  fields: ToolField[];
};

export type ToolField = {
  id: string;
  label: string;
  required: boolean;
  webmcpTarget: "cta" | "param" | "metadata";
  domHints: {
    tags?: string[];
    typeKeywords?: string[];
    textKeywords?: string[];
    ariaKeywords?: string[];
  };
  visionHints: {
    elementTypes?: string[];
    textPatterns?: string[];
  };
};
```

### SelectedWrapper

```ts
export type SelectedWrapper = {
  id: string;
  templateId: string;
  tabId: number;
  url: string;
  hostname: string;
  selector: string;
  xpath?: string | null;
  tagName: string;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    devicePixelRatio: number;
  };
  preview: {
    textSample: string;
    className: string;
    childCount: number;
  };
  createdAt: string;
};
```

### WrapperDomSummary

```ts
export type WrapperDomSummary = {
  container: {
    tagName: string;
    role: string | null;
    id: string | null;
    classTokens: string[];
    textSample: string;
    childElementCount: number;
  };
  controls: SummaryControl[];
  textBlocks: SummaryTextBlock[];
  stats: {
    controlCount: number;
    textBlockCount: number;
  };
};

export type SummaryControl = {
  localId: string;
  tagName: string;
  type: string | null;
  role: string | null;
  inputMode: string | null;
  name: string | null;
  id: string | null;
  ariaLabel: string | null;
  placeholder: string | null;
  text: string;
  labels: string[];
  isHidden: boolean;
  isDisabled: boolean;
  selectorHint: string;
};

export type SummaryTextBlock = {
  localId: string;
  tagName: string;
  text: string;
  selectorHint: string;
};
```

### WrapperScreenshot

```ts
export type WrapperScreenshot = {
  imageMimeType: "image/png";
  base64: string;
  width: number;
  height: number;
  sourceRectCssPx: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};
```

### AnalyzeWrapperRequest

```ts
export type AnalyzeWrapperRequest = {
  model: string;
  templateId: string;
  wrapper: SelectedWrapper;
  domSummary: WrapperDomSummary;
  screenshot: WrapperScreenshot;
};
```

### AnalyzeWrapperResponse

```ts
export type AnalyzeWrapperResponse = {
  tool: string;
  hasMatch: boolean;
  wrapperType: string;
  confidence: number;
  reason: string;
  matches: Record<string, {
    localIds: string[];
    confidence: number;
    reason: string;
  }>;
  webmcp: {
    toolName: string;
    toolDescription: string;
    fieldDescriptions: Record<string, string>;
  };
  warnings: string[];
};
```

### ProposedAnnotation

```ts
export type ProposedAnnotation = {
  wrapperSelector: string;
  wrapperTagName: string;
  tool: {
    name: string;
    description: string;
    autosubmit: boolean;
  };
  fields: Array<{
    fieldId: string;
    role: "cta" | "param" | "metadata";
    selectors: string[];
    description: string;
    title: string;
    confidence: number;
  }>;
  warnings: string[];
};
```

## Message contracts

### Popup -> Content script

```ts
{ action: "startWrapperPicker", templateId: string }
{ action: "cancelWrapperPicker" }
{ action: "getSelectedWrapperSummary" }
{ action: "resolveAiMatches", aiResponse: AnalyzeWrapperResponse }
{ action: "applyProposedAnnotation", annotation: ProposedAnnotation }
```

### Content script -> Popup

```ts
{ action: "wrapperPicked", wrapper: SelectedWrapper }
{ action: "wrapperSummaryReady", wrapper: SelectedWrapper, domSummary: WrapperDomSummary }
{ action: "resolvedAnnotationReady", annotation: ProposedAnnotation }
{ action: "applyResult", success: boolean, selectorConfig?: unknown, error?: string }
```

### Popup -> Background

```ts
{ action: "captureWrapperScreenshot", tabId: number, rect: SelectedWrapper["rect"] }
```

### Background -> Popup

```ts
{ action: "wrapperScreenshotReady", screenshot: WrapperScreenshot }
{ action: "wrapperScreenshotError", error: string }
```

## Popup state machine

```ts
export type FlowStage =
  | "idle"
  | "picking_wrapper"
  | "wrapper_selected"
  | "capturing_screenshot"
  | "building_dom_summary"
  | "analyzing_with_ai"
  | "resolving_matches"
  | "review_ready"
  | "applying"
  | "done"
  | "error";
```

```ts
export type FlowState = {
  stage: FlowStage;
  templateId: string | null;
  wrapper: SelectedWrapper | null;
  screenshot: WrapperScreenshot | null;
  domSummary: WrapperDomSummary | null;
  aiResponse: AnalyzeWrapperResponse | null;
  proposedAnnotation: ProposedAnnotation | null;
  error: string | null;
};
```

## DOM summary extraction rules

The DOM summary should be compact, stable, and readable by both humans and the model.

### Include

- Headings and other meaningful text blocks.
- `button`, `input`, `select`, `textarea`.
- `a[role="button"]` and similar clickable elements.
- `label` text connected to controls.
- `details` and `summary` when they are likely to hold product details.
- Hidden inputs only if they look relevant to product or variant identity.

### Exclude

- `script`, `style`, and SVG decoration.
- Repeated recommendation cards unrelated to the selected purchase region.
- Very long prose that is unlikely to influence tool detection.
- Decorative icons and visually hidden boilerplate.
- Raw nested HTML.

### Normalization rules

- Trim and collapse whitespace.
- Limit text length per item.
- Convert class strings into a short token list.
- Generate stable local IDs such as `ctl_01`, `ctl_02`, `txt_01`.
- Store a `selectorHint` for debug display, but never ask the model to produce selectors.

## AI prompt design

The request should combine image and text, but the text side should stay compact. Multimodal prompting works best when the text clearly explains how the image and structured text relate to one another.[cite:80][cite:83][cite:85]

Recommended request composition:

1. Short instruction describing the task.
2. The cropped wrapper screenshot.
3. A sentence explicitly stating that the DOM summary below describes only elements inside the same selected wrapper.
4. The compact DOM summary.
5. The tool template field list.
6. The strict JSON schema.

The model should be asked to identify semantic candidates, not generate selectors.

## Matching strategy after AI

The local matcher should operate only within the selected wrapper.

### General rules

- Resolve each `localId` to a real DOM node.
- Check that every field type is compatible with the resolved node.
- Keep multiple candidates if confidence is close and user review is needed.
- Store reasons and warnings for the review UI.

### Field-specific compatibility checks

| Field | Expected node types | Extra checks |
|---|---|---|
| `product_name` | heading, text node wrapper | Prefer top-level heading-like elements |
| `id` | hidden input, select, radio group, button group | Prefer product option controls or hidden product identifiers |
| `quantity` | number input, text input, select, stepper group | Prefer controls labeled `qty` or `quantity` |
| `add_to_cart_button` | button, submit input, button-like link | Must be clickable and visible |
| `description` | div, section, article, details | Prefer readable product-detail content |

## WebMCP annotation mapping

The final annotation should distinguish between wrapper-level tool metadata and field-level parameter metadata.

### Wrapper-level attributes

Apply to the selected container or chosen target wrapper:

- `toolname`
- `tooldescription`
- `toolautosubmit` when applicable

### Field-level attributes

Apply to matched nodes inside the wrapper:

- `toolparamtitle`
- `toolparamdescription`

If the project later introduces richer metadata for read-only contextual elements such as product title or description, those may need either an extended internal schema or a future WebMCP-compatible convention.

## Error handling

The flow needs explicit recovery paths.

### Picker errors

- User cancels picker.
- Selected node has zero width or height.
- Selected node is detached before capture.

### Screenshot errors

- Wrapper is mostly offscreen.
- `captureVisibleTab` fails or hits quota issues.[cite:57][cite:58]
- Cropped image is blank or unexpectedly tiny.

### AI errors

- Invalid or missing API key.
- Model returns malformed JSON.
- Model returns low confidence or no match.
- Request payload is too large.

### Resolution errors

- Returned `localIds` cannot be mapped.
- Nodes fail compatibility rules.
- Elements disappear before apply.

Each error state should offer a clear retry path: repick wrapper, retry screenshot, retry AI, or switch to manual field assignment.

## Persistence model

The long-term saved record should be small and stable.

```ts
export type SavedAnnotationConfig = {
  hostname: string;
  templateId: string;
  wrapperSelector: string;
  toolName: string;
  toolDescription: string;
  autosubmit: boolean;
  fields: Array<{
    fieldId: string;
    selectors: string[];
    description: string;
    title: string;
  }>;
  updatedAt: string;
};
```

Do not persist screenshots, raw model responses, or temporary local IDs as part of the long-term domain configuration.

## Debug mode

A debug mode will make this flow much easier to develop and maintain.

The debug UI should show:

- Selected wrapper selector and bounding box.
- Cropped screenshot preview.
- Compact DOM summary JSON.
- Raw AI response JSON.
- Resolved field-to-node mapping.
- Final saved annotation configuration.

## Security and privacy considerations

The extension should minimize data sent to the model.

Only the selected wrapper region and a compact wrapper-only DOM summary should be sent. Full-page DOM export should be avoided once a wrapper has been selected.

Because screenshots may contain sensitive information, the feature should be explicitly user-triggered and clearly scoped to the selected region.

## Suggested implementation phases

### Phase 1: Wrapper picker MVP

Deliver:

- Hover highlight overlay.
- Click-to-select wrapper.
- Stored selector, XPath, preview text, and rect.
- Popup preview of selected wrapper.

### Phase 2: Screenshot pipeline

Deliver:

- Background capture flow.
- Pixel-ratio-aware crop.[cite:50][cite:54]
- Wrapper image preview.
- Basic screenshot error handling.

### Phase 3: Wrapper DOM summary

Deliver:

- Summary builder inside selected wrapper.
- Local ID generation.
- Debug inspector for summary content.

### Phase 4: AI integration

Deliver:

- Multimodal request builder.
- Structured output schema.[cite:97]
- Response validation.
- Retry and error handling.

### Phase 5: Local resolution and review

Deliver:

- `localId -> node` resolution.
- Field compatibility rules.
- Review screen with confidence and warnings.
- Manual override controls.

### Phase 6: Apply and persist

Deliver:

- Attribute application.
- Saved per-domain configuration.
- Editing and re-application support.

## Recommended MVP decisions

The first real implementation should stay intentionally narrow:

- One template: `add_to_cart`.
- One user-selected wrapper.
- One cropped screenshot.
- One compact wrapper-only DOM summary.
- One structured model response.
- Mandatory human review before apply.

This is enough to prove the end-to-end architecture without overbuilding the first release.

## Final recommendation

The wrapper-first flow is a strong direction for this extension because it combines the strengths of visual interpretation and DOM-level precision.

The most important design rule is simple: let the user define the region, let the model interpret that region semantically, and let the extension resolve and apply the final DOM annotation locally.
