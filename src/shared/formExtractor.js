/**
 * Rule-based form field extraction.
 * Output: { fields: [{ id, name, label, type, selector }] }
 */

const INPUT_SELECTORS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]), select, textarea";

function getFieldIdentifier(el) {
  return el.id || el.name || el.getAttribute("aria-label") || "";
}

function getLabelForElement(el) {
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return label.textContent.trim();
  }
  // Check aria-label
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();
  // Check placeholder
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;
  // Check nearest label (parent or preceding)
  let parent = el.parentElement;
  while (parent && parent !== document.body) {
    if (parent.tagName === "LABEL") {
      return parent.textContent.trim();
    }
    parent = parent.parentElement;
  }
  // Preceding label (common pattern: <label>Email</label><input>)
  let prev = el.previousElementSibling;
  while (prev) {
    if (prev.tagName === "LABEL") return prev.textContent.trim();
    prev = prev.previousElementSibling;
  }
  return "";
}

function findFormContainer(element) {
  let el = element;
  while (el && el !== document.body) {
    if (el.tagName === "FORM") return el;
    const inputs = el.querySelectorAll(INPUT_SELECTORS);
    if (inputs.length > 0) return el;
    el = el.parentElement;
  }
  return null;
}

function extractFieldsFromContainer(container) {
  const inputs = container.querySelectorAll(INPUT_SELECTORS);
  const fields = [];
  const seen = new Set();

  inputs.forEach((el, index) => {
    const name = el.name || "";
    const id = el.id || "";
    const type = (el.type || el.tagName.toLowerCase()).toLowerCase();
    const label = getLabelForElement(el);
    const placeholder = el.getAttribute("placeholder") || "";

    // Build a unique key for deduping
    const key = id || name || `field-${index}`;
    if (seen.has(key) && !key.startsWith("field-")) return;
    seen.add(key);

    const fieldId = id || name || `field_${index}`;

    fields.push({
      id: fieldId,
      name,
      label: label || placeholder || fieldId,
      type,
      placeholder,
      selector: buildSelector(el),
    });
  });

  return fields;
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) {
    const tag = el.tagName.toLowerCase();
    const type = el.type ? `[type="${el.type}"]` : "";
    return `${tag}[name="${CSS.escape(el.name)}"]${type}`;
  }
  return null;
}

export function extractFormFields(element) {
  const container = findFormContainer(element);
  if (!container) return null;
  return {
    containerTag: container.tagName,
    fields: extractFieldsFromContainer(container),
  };
}
