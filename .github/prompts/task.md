# Wrapper-First Rewrite — Task Tracker

## Phase 1: Foundation — Manifest & Templates
- [ ] Update `manifest.json` (background service worker, tabs permission)
- [ ] Rewrite `templates.js` (ToolTemplate/ToolField types)

## Phase 2: Background Service Worker
- [ ] Create `background.js` (screenshot capture + crop)

## Phase 3: Content Script Rewrite
- [ ] Wrapper picker (hover highlight any element, click to select)
- [ ] DOM summary extraction (controls + text blocks with localIds)
- [ ] Local DOM resolution (localId → node + compatibility checks)
- [ ] Attribute application (WebMCP attributes)
- [ ] Auto-apply saved annotations on load
- [ ] New message listener contracts

## Phase 4: Popup HTML
- [ ] Rewrite Annotate tab for flow stages
- [ ] Update Saved tab for new config format

## Phase 5: Popup JS — Flow State Machine
- [ ] Flow state machine + stage transitions
- [ ] Wrapper picking flow
- [ ] Screenshot capture flow
- [ ] DOM summary flow
- [ ] Multimodal AI call (image + text)
- [ ] Local resolution flow
- [ ] Review & Apply flow
- [ ] Settings & Saved tab logic

## Phase 6: Popup CSS
- [ ] New component styles (wrapper preview, screenshot, review table, etc.)

## Verification
- [ ] Manual testing walkthrough
