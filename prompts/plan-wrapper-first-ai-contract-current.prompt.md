## Final Plan: Current Wrapper-First AI Contract Changes

This plan is the single canonical plan for the current branch changes.

Goal: lock AI analysis to pick-captured artifacts, simplify model-to-DOM matching through one stable key, and harden output quality for WebMCP attribute generation while keeping add_to_cart as a minimum executable contract.

**Phase 1: State Gating And Contract Lock**
1. Add a single AI readiness evaluator in [content_script.js](content_script.js) that requires all of:
1. selected wrapper exists
1. screenshot cache exists and matches selected wrapper
1. signature payload cache exists and matches selected wrapper
1. AI run is not already active
2. Wire Run AI button enablement to every transition:
1. picker start/stop
1. wrapper picked
1. screenshot capture success/failure
1. signature payload built/reset
1. AI run start/end
3. Enforce runtime guard in AI execution path:
1. if readiness is false, stop early
1. show explicit missing prerequisites message
4. Keep AI default behavior as pick-captured only (no silent recapture during run).

**Phase 2: Signature Payload Redesign**
1. Replace count-based summary slicing with compact full-signature coverage for relevant wrapper nodes.
2. Use one canonical model-facing identifier: signature id.
3. Include only deterministic minimal signature fields:
1. kind
1. tag
1. control subtype or role
1. normalized text or label token
1. visibility or disabled flags where needed
4. Build and cache signature payload at pick-time together with screenshot.
5. Bind caches to wrapper selector so repicks invalidate stale data.

**Phase 3: AI Output Contract And Resolver**
1. Update AI response schema in [content_script.js](content_script.js) to use signature ids only for element matches.
2. Remove dual localId and signature concepts from the model-facing contract.
3. Require AI-generated WebMCP texts in output:
1. tool-level name and description
1. field-level title and description
4. Keep template data for field existence, requiredness, compatibility checks, and lightweight prompt guidance only.
5. Resolve signature ids to DOM via pick-time cache map, then run field compatibility checks and selector generation.
6. Emit warnings for:
1. unresolved signature ids
1. stale wrapper context
1. incompatible field-element mappings

**Phase 4: Prompt Hardening And JSON Example**
1. Add one explicit valid JSON example in prompt text aligned exactly with schema keys.
2. Remove wrapper taxonomy requirements that do not affect the runtime.
3. Treat add_to_cart as a minimum executable contract:
1. primary CTA
1. real option or variant controls when present
1. quantity control when present
1. one compact product identifier when useful
4. Allow the model to use the rest of the wrapper, including price, ratings, images, badges, reviews, and availability, as context for selection and text generation without turning them into extra fields.
2. Add disallowed output guidance in prompt:
1. unknown signature ids
1. schema key drift
1. free text outside JSON
1. matching broad passive wrapper content as if it were a field
6. Keep strict responseMimeType and responseSchema usage.
7. Keep parser errors user-visible and actionable.

**Phase 5: Validation And Regression Checks**
1. Verify strict end-to-end flow:
1. Pick Target
1. pick-time screenshot and signature cache built
1. Run AI enabled only when ready
1. AI run consumes cached artifacts only
2. Verify Run AI remains disabled for incomplete states and wrapper mismatches.
3. Verify signature-id roundtrip resolves to correct DOM elements on representative add_to_cart wrappers.
4. Verify apply step annotates expected elements without turning passive wrapper content into annotated fields.
5. Verify WebMCP text attributes used for apply come from AI response only.

**Relevant Files**
1. [content_script.js](content_script.js): readiness gating, cache lifecycle, signature payload, prompt, schema, resolver.
2. [background.js](background.js): validate screenshot error propagation used by readiness logic.
3. [templates.js](templates.js): keep field definitions and compatibility rules source; do not use template fallback text for output attributes.
4. [popup.js](popup.js): out of core scope unless parity status messaging is required.

**Decisions**
1. Single identifier concept: signature id only.
2. Pick-captured artifacts are source of truth for AI run.
3. WebMCP descriptive texts are sourced from AI output, not template fallback.
4. Add_to_cart remains a minimum executable contract, not a full product-card ontology.
5. Scope is content script contract hardening; popup architecture rewrite is excluded.

**Open Follow-Ups (After Current Changes)**
1. Add versioning for persisted annotation schema if output contract changes further.
2. Consider deterministic signature tie-break suffix policy if collisions grow.
3. Consider payload compaction strategy only if large-wrapper prompt size becomes a real issue.