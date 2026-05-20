const annotateButton = document.getElementById('annotate-content');
const statusBox = document.getElementById('status');

function setStatus(text, type) {
  if (!statusBox) return;
  statusBox.textContent = text;
  statusBox.className = `status-box ${type}`;
}

annotateButton?.addEventListener('click', async () => {
  setStatus('Annotating content structures...', 'info');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab found.', 'error');
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        /** Mock functionality to test the extension */
        const findHeadings = (node) => {
          const found = [];
          if (!node) return found;

          // Check if this node is an element
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.toLowerCase();
            const role = node.getAttribute('role');

            // Match headings: h1-h6 and elements with role="heading"
            const isHeadingTag = /^[hH][1-6]$/.test(tagName);
            const isHeadingRole = role === 'heading';

            if (isHeadingTag || isHeadingRole) {
              found.push(node);
            }

            // Recurse into Shadow DOM if present
            if (node.shadowRoot) {
              found.push(...findHeadings(node.shadowRoot));
            }
          }

          // Recurse into children
          for (const child of node.childNodes) {
            found.push(...findHeadings(child));
          }

          return found;
        };

        const headings = findHeadings(document);
        let count = 0;

        for (const heading of headings) {
          try {
            heading.style.setProperty('font-size', '150px', 'important');
            heading.style.setProperty('font-weight', '800', 'important');
            heading.style.setProperty('color', 'red', 'important');
            heading.setAttribute('tool', 'page heading');
            count++;
          } catch (e) {
            // Ignore style errors on individual read-only or restricted elements
          }
        }

        return count;
      }
    });

    // Sum the annotated count across all accessible frames
    const totalAnnotated = results.reduce((sum, frameResult) => sum + (frameResult.result || 0), 0);

    if (totalAnnotated > 0) {
      setStatus(`Successfully annotated ${totalAnnotated} content heading(s)!`, 'success');
    } else {
      setStatus('No heading elements found on this page.', 'info');
    }
  } catch (error) {
    console.error('WebMCP Annotator error:', error);
    setStatus('Cannot access this page (restricted by browser).', 'error');
  }
});
