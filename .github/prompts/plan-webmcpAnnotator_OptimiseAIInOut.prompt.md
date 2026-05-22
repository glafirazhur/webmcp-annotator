## Plan: Tune Prompt And Output For WebMCP

Keep the current wrapper-first flow and the current AI payload preparation as-is. Do not change which nodes are collected or how the screenshot and payload are assembled. Focus on making add_to_cart behave like a minimal executable contract while letting the model use the full wrapper context for selection quality and text generation.

## Phase 1: Treat The Template As A Minimum Contract

Reuse current template metadata in [templates.js](c:/Users/glafi/Projects/webmcp-annotator/templates.js) as the planning source for what the model should prefer, but do not treat the template as an exhaustive inventory of everything visible inside the wrapper.

For add_to_cart, the template should describe only the minimum executable pieces:
1. the primary add_to_cart action
2. buyable option or variant controls when present
3. quantity control when present
4. one compact product identifier when helpful

Images, ratings, price, badges, reviews, and availability should usually stay as wrapper context rather than become first-class add_to_cart fields. The model can use them to understand the product and generate better WebMCP text, but should not map them unless they directly support one of the declared fields.

Small template-level guidance additions are acceptable if they only improve prompt steering and do not change the payload shape.

## Phase 2: Simplify Prompt

Keep the current multimodal structure in [content_script.js](c:/Users/glafi/Projects/webmcp-annotator/content_script.js): screenshot plus text prompt plus compact element signatures.

Rewrite the prompt so the model does only this:
1. choose the best signatureIds for each template field from the nodes already provided.
2. generate webmcp.toolName and webmcp.toolDescription.
3. generate webmcp.fieldTitles and webmcp.fieldDescriptions.
4. clearly return no match for a field when the payload does not support a confident match.
5. treat the whole wrapper as context for naming and disambiguation, not as a reason to invent more fields.

A good prompt block for this part:

You are annotating one selected wrapper for a WebMCP tool.

You already have all candidate nodes that may be relevant inside this wrapper.
Do not invent new elements, selectors, or ids.
Choose only from the provided signatureIds.

Your job is to select the smallest set of nodes that are useful for a WebMCP tool:

- For cta fields, prefer the primary clickable action that would execute the tool.
- For param fields, prefer actual value-carrying controls such as inputs, selects, textareas, radio/option controls, quantity steppers, or semantically relevant hidden inputs.
- For metadata fields, prefer only short high-value context that helps explain the tool or disambiguate the chosen action/parameters.
- Treat images, ratings, price, review counts, badges, and similar wrapper content as context unless they directly support a declared field.
- Ignore decorative, repetitive, boilerplate, navigational, or weakly related content unless it is necessary for a field.

Return matches for each template field using only signatureIds from the payload.
If a field is not present or you are not confident, return an empty signatureIds array for that field and explain why briefly.

Generate WebMCP-ready text:
- webmcp.toolName
- webmcp.toolDescription
- webmcp.fieldTitles
- webmcp.fieldDescriptions

Keep the output strict JSON only.
Do not output prose outside the schema.
Do not use unknown signatureIds.
Do not add keys outside the schema.

Keep:
1. one strict valid JSON example aligned to the schema.
2. one short disallowed-output note.

Remove prompt ambition that is not helping:
1. no wrapper-type taxonomy unless it is already useful in practice.
2. no broad reasoning requests beyond field matching.
3. no extra analysis objects unless they directly improve the current review UI.

## Phase 3: Keep AI Output Simple

Stay close to the current response schema in [content_script.js](c:/Users/glafi/Projects/webmcp-annotator/content_script.js).

Prefer this minimal structure:
1. tool
2. hasMatch
3. confidence
4. reason
5. matches[fieldId] = signatureIds + confidence + reason
6. webmcp.toolName
7. webmcp.toolDescription
8. webmcp.fieldTitles
9. webmcp.fieldDescriptions
10. warnings

Do not add:
1. rankedCandidates
2. finalChoice
3. compatibility payloads
4. projection blocks
5. wrapper taxonomy fields unless they are proven useful in the runtime

Let DOM compatibility remain a local runtime responsibility after AI returns signatureIds.

## Phase 4: Verification

1. Run at least one add_to_cart wrapper through the current AI flow using the unchanged payload.
2. Confirm the model chooses the add_to_cart action and any real option or quantity controls instead of overusing text blocks or passive content.
3. Confirm the model uses the wider wrapper context to improve naming and descriptions without turning ratings, images, or price rows into extra field matches.
4. Confirm required fields still resolve to valid elements after the prompt change.
5. Confirm the AI response still matches the current schema with only minimal schema edits if needed.
6. Confirm webmcp.toolName, webmcp.toolDescription, fieldTitles, and fieldDescriptions are good enough to apply directly.
7. Check one noisy wrapper case to confirm the prompt helps the model ignore decorative or repeated content without changing payload generation.
8. Confirm the JSON example and actual schema keys match exactly.

**Relevant files**
- [content_script.js](c:/Users/glafi/Projects/webmcp-annotator/content_script.js): prompt assembly and AI response schema are here.
- [templates.js](c:/Users/glafi/Projects/webmcp-annotator/templates.js): current field metadata should drive prompt guidance.
- [plan-wrapper-first-ai-contract-current.prompt.md](c:/Users/glafi/Projects/webmcp-annotator/prompts/plan-wrapper-first-ai-contract-current.prompt.md): update later if you want the repo plan to match this narrowed version.

**Decisions**
- Included scope: prompt tuning, add_to_cart template tightening, template-guided selection instructions, and keeping AI output simple.
- Excluded scope: payload preparation changes, screenshot/payload matching, cache validation, persistence changes, popup changes, and broad contract redesign.
- Preferred approach: keep all currently collected nodes, let the wrapper provide rich context, but keep the add_to_cart template limited to the minimum executable contract.
- Preferred output: minimal WebMCP-ready JSON that the current resolver can consume.

**Further Considerations**
1. If results are still noisy, first tighten prompt language for metadata selection before changing payload generation.
2. Do not expand add_to_cart with review, rating, gallery, or pricing fields unless they become necessary for an actual executable agent action.
3. If one template behaves differently from another, add small template-specific prompt hints rather than redesigning the whole contract.