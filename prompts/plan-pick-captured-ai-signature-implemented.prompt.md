## Plan: Pick-Captured AI Signature Flow

Shift AI analysis to a strict pick-captured contract: AI can run only when wrapper, screenshot, and compact signature payload are already captured from pick-time; remove count-based trimming and use a single resolver key concept (signature id) end-to-end; require AI-generated WebMCP text attributes; add a concrete JSON output example directly in prompt instructions.

**Steps**
1. Phase 1: State gating and flow contract
2. Add a central readiness evaluator in [content_script.js](content_script.js) that computes AI-run eligibility from: selected wrapper present, matching screenshot cache present, matching signature payload cache present, and not currently running.
3. Wire button state updates to all transitions (picker start, pick success, screenshot success/failure, cache reset, AI start/end), so Run AI stays disabled until pick data is complete. Depends on step 2.
4. Enforce run-time guard in AI execution path: if readiness is false, return early with explicit status explaining which artifact is missing (wrapper/screenshot/signature payload). Depends on step 2.
5. Remove/reduce fallback recapture behavior during AI run so default behavior is “use pick-captured artifacts only”; optional emergency recapture path is excluded unless requested.
6. Phase 2: Signature payload redesign
7. Replace count-based summarize logic in [content_script.js](content_script.js) with compact per-element signature entries generated for all wrapper elements needed for matching (no arbitrary top-N control/text slicing).
8. Define one canonical signature id format and include only minimal fields needed for deterministic matching and AI understanding (element kind, html tag, control subtype/role, normalized text/label token, visibility/disabled flags when relevant).
9. Build and cache this signature payload at pick-time together with the screenshot; bind cache to selected wrapper selector/version marker so AI always receives the exact captured snapshot context.
10. Update AI prompt assembly to embed the compact signature payload (not verbose control/text dumps) and clearly instruct that model output must reference only provided signature ids.
11. Phase 3: AI output contract and resolver
12. Update response schema in [content_script.js](content_script.js) to use signature ids as the single matching key (remove dual localId/signature concepts).
13. Extend output contract so each matched candidate includes generated WebMCP attribute text from AI (tool-level and field-level text) with no template-text fallback; template metadata may still define field existence/requiredness only.
14. Adjust resolver to map returned signature ids back to DOM elements via pick-time cache map, then run compatibility checks and selector generation as today.
15. Add robust warning pathways for unresolved signature ids, stale wrapper context, and incompatible field-element matches.
16. Phase 4: Prompt clarity and JSON example
17. Add an explicit “valid JSON output example” block in prompt text aligned exactly with schema keys, including multi-field matches, confidence/reason, warnings, and generated WebMCP texts.
18. Add a “disallowed output” note in prompt (unknown signature ids, schema key drift, free text outside JSON) to reduce malformed responses.
19. Keep responseMimeType and schema enforcement; confirm parser/recovery behavior for invalid JSON remains user-visible and actionable.
20. Phase 5: Validation and regression checks
21. Verify pick-only workflow end-to-end: Pick Target -> screenshot+signature cache built -> Run AI enabled -> AI consumes cached data only.
22. Verify AI button remains disabled for all incomplete states (no pick, screenshot failure, cache mismatch after repick).
23. Verify signature-id roundtrip on representative wrappers and ensure apply step still annotates correct elements.
24. Verify generated WebMCP attribute text is sourced from AI response only.

**Relevant files**
- [content_script.js](content_script.js) - primary flow/state updates: picker handlers, screenshot cache use, AI readiness gating, payload generation, prompt assembly, schema, resolver.
- [background.js](background.js) - screenshot capture behavior; likely unchanged, but validate error propagation semantics used by gating.
- [templates.js](templates.js) - keep field structure definitions; no template text fallback for output strings after this change.
- [popup.js](popup.js) - optional only if popup needs explicit readiness/status messaging parity; otherwise out of scope for this pass.

**Verification**
1. Manual: run extension and validate strict flow states across success and failure paths.
2. Manual: inspect prompt payload in console/log hook to confirm compact signature payload and included JSON example.
3. Manual: inspect AI response object shape to confirm signature-id-based matches and AI-generated text fields.
4. Manual: apply annotations and verify DOM attributes land on expected elements.
5. Automated/lint: run available workspace checks (if present) and confirm no new runtime errors in [content_script.js](content_script.js).

**Decisions**
- Single identifier concept only: replace localId exposure in AI contract with signature id as the sole model-facing match key.
- Signature should optimize deterministic resolver mapping first, then model readability.
- WebMCP descriptive text should come from AI only; no template suggestion fallback.
- Scope includes planning and contract redesign in content script flow; popup architecture rewrite remains out of scope.

**Further Considerations**
1. Signature collision policy: recommend deterministic tie-break suffixing when two elements normalize to same signature base.
2. Wrapper mutation policy between pick and AI run: recommend hard invalidation (disable Run AI and request repick) instead of silent refresh.
3. Prompt size guardrails: if wrapper is very large, recommend compact tokenization strategy before introducing element dropping heuristics.