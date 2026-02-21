/**
 * Content script - runs on web pages.
 * Handles: selection mode, form extraction, fill.
 */

import { extractFormFields } from "../shared/formExtractor.js";

let selectionMode = false;
let selectionOverlay = null;

function createSelectionOverlay() {
  if (selectionOverlay) return;
  selectionOverlay = document.createElement("div");
  selectionOverlay.id = "agentic-autofill-overlay";
  selectionOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 255, 0.05);
    cursor: crosshair;
    z-index: 2147483646;
    pointer-events: auto;
  `;
  document.body.appendChild(selectionOverlay);
}

function removeSelectionOverlay() {
  if (selectionOverlay) {
    selectionOverlay.remove();
    selectionOverlay = null;
  }
}

function findFormUnderPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  return el;
}

function highlightElement(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  let box = document.getElementById("agentic-autofill-highlight");
  if (!box) {
    box = document.createElement("div");
    box.id = "agentic-autofill-highlight";
    box.style.cssText = `
      position: fixed;
      border: 2px solid #4f46e5;
      background: rgba(79, 70, 229, 0.15);
      pointer-events: none;
      z-index: 2147483647;
      transition: all 0.1s ease;
    `;
    document.body.appendChild(box);
  }
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function removeHighlight() {
  const box = document.getElementById("agentic-autofill-highlight");
  if (box) box.remove();
}

function enableSelectionMode() {
  selectionMode = true;
  createSelectionOverlay();

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = findFormUnderPoint(e.clientX, e.clientY);
    const result = extractFormFields(el);
    if (result && result.fields && result.fields.length > 0) {
      selectionMode = false;
      removeSelectionOverlay();
      removeHighlight();
      selectionOverlay?.removeEventListener("click", handler);
      selectionOverlay?.removeEventListener("mousemove", moveHandler);

      chrome.runtime.sendMessage({
        target: "panel",
        type: "form-extracted",
        fields: result.fields,
      });
    } else {
      highlightElement(el);
    }
  };

  const moveHandler = (e) => {
    const el = findFormUnderPoint(e.clientX, e.clientY);
    highlightElement(el);
  };

  const keyHandler = (e) => {
    if (e.key === "Escape") {
      disableSelectionMode();
      selectionOverlay?.removeEventListener("click", handler);
      selectionOverlay?.removeEventListener("mousemove", moveHandler);
      document.removeEventListener("keydown", keyHandler);
    }
  };

  selectionOverlay.addEventListener("click", handler);
  selectionOverlay.addEventListener("mousemove", moveHandler);
  document.addEventListener("keydown", keyHandler);
}

function disableSelectionMode() {
  selectionMode = false;
  removeSelectionOverlay();
  removeHighlight();
}

function fillForm(mapping) {
  // mapping: { fieldId: value, ... }
  for (const [fieldId, value] of Object.entries(mapping)) {
    if (value == null || value === "") continue;
    let el = document.getElementById(fieldId) || document.querySelector(`[name="${fieldId}"]`);
    if (!el && fieldId.startsWith("field_")) {
      const inputs = document.querySelectorAll("input, select, textarea");
      const idx = parseInt(fieldId.replace("field_", ""), 10);
      el = inputs[idx];
    }
    if (el) {
      if (el.tagName === "SELECT") {
        const option = [...el.options].find((o) => o.value === value || o.text === value);
        if (option) el.value = option.value;
      } else {
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "enable-selection") {
    enableSelectionMode();
  }
  if (message.type === "fill-form") {
    fillForm(message.mapping || {});
  }
});
