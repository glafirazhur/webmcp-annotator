# Feature Plan: Add to Cart Form Annotator (WebMCP Tool) - v1 (Heuristic)

This feature introduces a workflow in the WebMCP Annotator browser extension to identify "Add to Cart" elements (forms or buttons) on a page, automatically apply the appropriate WebMCP markup attributes, and persist these annotations across page loads for testing with AI agents.

## User Review Required

> [!IMPORTANT]
> **Fully Automated Markup Application**:
> - **Indication Phase**: The user either selects a candidate from the **automatically detected** list or uses the **manual picker** to target a specific form or button.
> - **Application Phase**: The extension will *automatically* inspect the target element, identify related inputs (for IDs, variant selections, or quantity), determine the best parameter bindings, and apply the WebMCP attributes directly. There is no manual field mapping required by the user; the extension performs the parsing and markup injection in one step.

> [!NOTE]
> **Markup-Only Constraints**:
> As per your feedback, we will only annotate the existing DOM elements of the website. We will not generate fake wrapper forms or mock interactive elements. If a simple `<button>` is targeted, we will apply the tool attributes directly to that button to allow agents to find and trigger it.

> [!TIP]
> **Domain Persistence**:
> We will add the `"storage"` permission to `manifest.json`. The extension will save the target selectors and their WebMCP attributes to `chrome.storage.local`. A lightweight content script will automatically run on page load to re-apply the attributes, ensuring the annotations persist for AI agents.

---

## Proposed Changes

We will introduce a modular template-driven framework so that "Add to Cart" is just the first template. We plan for easy expansion to other tools (e.g., search, signups).

### 1. Template Registry Architecture

We will create a structured file `templates.js` that houses the specifications and automated parsing rules for each tool type.

```javascript
// templates.js
export const WebMCPTemplates = {
  add_to_cart: {
    id: "add_to_cart",
    name: "Add to Cart",
    defaultToolName: "add_to_cart",
    defaultDescription: "Add a product/variant with a specific quantity to the shopping cart.",
    
    // Automated heuristic rules to find candidate elements on the page
    detect: (document) => {
      const candidates = [];

      // Scan all forms on the page
      document.querySelectorAll('form').forEach(form => {
        let score = 0;
        const html = form.innerHTML.toLowerCase();
        
        // Form contains add-to-cart style text on button
        const buttons = form.querySelectorAll('button, input[type="submit"], input[type="button"]');
        const hasCartText = Array.from(buttons).some(b => 
          /add\s*to\s*(cart|bag)|buy\s*now|order\s*now/i.test(b.innerText || b.value || '')
        );
        if (hasCartText) score += 50;

        // Form action matches typical cart patterns
        if (/cart|bag|checkout|basket/i.test(form.action || '')) score += 20;

        // Sub-elements match typical fields
        if (form.querySelector('input[name*="qty"], input[name*="quantity"]')) score += 15;
        if (form.querySelector('input[name*="id"], select[name*="id"], input[name*="variant"], select[name*="variant"]')) score += 15;

        if (score > 0) {
          candidates.push({
            element: form,
            type: 'form',
            score: score,
            selector: getUniqueSelector(form)
          });
        }
      });

      // Scan isolated buttons not inside forms (often found in modern React/VUE sites)
      document.querySelectorAll('button, input[type="button"], a.btn, a.button').forEach(btn => {
        // If already inside a form candidate, skip to avoid duplicate entries
        if (btn.closest('form')) return;

        const text = btn.innerText || btn.value || '';
        if (/add\s*to\s*(cart|bag)|buy\s*now/i.test(text)) {
          candidates.push({
            element: btn,
            type: 'button',
            score: 40,
            selector: getUniqueSelector(btn)
          });
        }
      });

      return candidates.sort((a, b) => b.score - a.score);
    },

    // Rules to automatically discover and map input attributes within/around the target element
    autoMarkup: (targetElement, defaults) => {
      const attributes = [
        { name: 'toolname', value: defaults.toolname || 'add_to_cart' },
        { name: 'tooldescription', value: defaults.tooldescription || 'Add this item to the cart.' },
        { name: 'toolautosubmit', value: '' } // Boolean attribute
      ];

      const inputMappings = [];

      // Find children inputs if form, or search container context if button
      const searchRoot = targetElement.tagName.toLowerCase() === 'form' 
        ? targetElement 
        : (targetElement.parentElement || targetElement);

      // 1. Identify Product ID / Variant field
      const idInput = searchRoot.querySelector('select[name*="id"], input[name*="id"], select[name*="variant"], input[name*="variant"], select[name*="sku"], input[name*="sku"]');
      if (idInput) {
        inputMappings.push({
          element: idInput,
          attributes: [
            { name: 'toolparamtitle', value: 'product_id' },
            { name: 'toolparamdescription', value: 'The product or variant ID to add to the cart.' },
            { name: 'tool-param-description', value: 'The product or variant ID to add to the cart.' }
          ]
        });
      }

      // 2. Identify Quantity field
      const qtyInput = searchRoot.querySelector('input[name*="qty"], input[name*="quantity"]');
      if (qtyInput) {
        inputMappings.push({
          element: qtyInput,
          attributes: [
            { name: 'toolparamtitle', value: 'quantity' },
            { name: 'toolparamdescription', value: 'Number of units to add (default is 1).' },
            { name: 'tool-param-description', value: 'Number of units to add (default is 1).' }
          ]
        });
      }

      return { targetAttributes: attributes, inputMappings };
    }
  }
};
```

---

### Component-Level Workflows

#### A. Automatic Indication & Markup
1. User opens the popup; default tool "Add to Cart" is selected.
2. The extension automatically executes the `detect` heuristic in the tab context.
3. If candidates are found, the popup renders a gorgeous **"Detected Candidates"** list (showing element type, snippet/classes, and a confidence rating).
4. Hovering over a candidate in the popup highlights it in the page with an indigo box.
5. Clicking **"Apply Markup"** on a candidate automatically runs the `autoMarkup` mapping algorithm, injects all attributes into the DOM elements, saves the config to `chrome.storage.local`, and shows a success animation.

#### B. Manual Indication & Markup
1. If the automatic list doesn't show the correct element, the user clicks **"Select Element Manually"**.
2. The popup minimizes, and the element picker highlights page elements under the cursor.
3. The user clicks the target form or button.
4. The extension automatically closes the picker, runs the `autoMarkup` rules on the selected element, applies the attributes, saves the configuration, and displays the success panel.

#### C. Domain Persistence Content Script
A background/content script monitors page loads:
1. When a page is loaded, it fetches stored rules for the current domain.
2. It matches selectors and applies the saved WebMCP attributes to forms, buttons, and inputs automatically.
