/**
 * Agentic Autofill - Side Panel
 * Phase 1+2+3: Profile, Select Form, Extract Fields, Rule-based + AI Autofill
 */

import { heuristicMap } from "../shared/heuristics.js";
import { CreateMLCEngine } from "@mlc-ai/web-llm";

const PROFILE_KEYS = ["name", "email", "phone", "address", "city", "state"];
const PROFILE_IDS = {
  name: "profile-name",
  email: "profile-email",
  phone: "profile-phone",
  address: "profile-address",
  city: "profile-city",
  state: "profile-state",
};

let extractedFields = [];
let engine = null;
const DEFAULT_MODEL = "Qwen2-0.5B-Instruct-q4f16_1-MLC";

// Load profile from storage
async function loadProfile() {
  const data = await chrome.storage.local.get("profile");
  const profile = data.profile || {};
  for (const key of PROFILE_KEYS) {
    const el = document.getElementById(PROFILE_IDS[key]);
    if (el) el.value = profile[key] || "";
  }
}

// Save profile to storage
async function saveProfile() {
  const profile = {};
  for (const key of PROFILE_KEYS) {
    const el = document.getElementById(PROFILE_IDS[key]);
    if (el) profile[key] = el.value.trim();
  }
  await chrome.storage.local.set({ profile });
  const status = document.getElementById("profile-status");
  if (status) {
    status.textContent = "Profile saved.";
    setTimeout(() => (status.textContent = ""), 2000);
  }
}

// Apply mapping to field inputs in the UI
function applyMappingToInputs(mapping) {
  document.querySelectorAll("#fields-list input[data-field-id]").forEach((input) => {
    const id = input.dataset.fieldId;
    if (mapping[id]) input.value = mapping[id];
  });
}

// Render extracted fields with editable inputs, pre-filled via heuristics
async function renderFields(fields) {
  extractedFields = fields || [];
  const section = document.getElementById("fields-section");
  const list = document.getElementById("fields-list");
  if (!section || !list) return;

  const { profile = {} } = await chrome.storage.local.get("profile");
  const heuristicMapping = heuristicMap(extractedFields, profile);

  list.innerHTML = "";
  extractedFields.forEach((field, i) => {
    const suggested = heuristicMapping[field.id] || "";
    const row = document.createElement("div");
    row.className = "field-row";
    row.innerHTML = `
      <div class="field-meta">
        <span class="field-label">${field.label || field.id}</span>
        <span class="field-type">(${field.type})</span>
      </div>
      <input type="text" data-field-id="${field.id}" data-field-index="${i}" placeholder="Value" value="${escapeHtml(suggested)}" />
    `;
    list.appendChild(row);
  });

  section.style.display = "block";
  const aiSection = document.getElementById("ai-section");
  if (aiSection) aiSection.style.display = "block";
}

function escapeHtml(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Build mapping from current inputs
function getMapping() {
  const mapping = {};
  document.querySelectorAll("#fields-list input[data-field-id]").forEach((input) => {
    const id = input.dataset.fieldId;
    const val = input.value.trim();
    if (id && val) mapping[id] = val;
  });
  return mapping;
}

// Fill form in content script
function doFill() {
  const mapping = getMapping();
  chrome.runtime.sendMessage({ type: "fill-form", mapping });
}

// Profile form submit
document.getElementById("profile-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  saveProfile();
});

// Select Form button
document.getElementById("select-form-btn")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "enable-selection" });
});

// Fill button
document.getElementById("fill-btn")?.addEventListener("click", doFill);

// Check WebGPU support
async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

// Suggest with AI - load WebLLM and run mapping
async function suggestWithAI() {
  const loadingEl = document.getElementById("ai-loading");
  const errorEl = document.getElementById("ai-error");
  loadingEl.style.display = "block";
  errorEl.style.display = "none";
  errorEl.textContent = "";

  const webgpuOk = await hasWebGPU();
  if (!webgpuOk) {
    loadingEl.style.display = "none";
    errorEl.textContent = "WebGPU not supported in this browser. Using heuristics.";
    errorEl.style.display = "block";
    const { profile = {} } = await chrome.storage.local.get("profile");
    const fallback = heuristicMap(extractedFields, profile);
    applyMappingToInputs(fallback);
    return;
  }

  try {
    if (!engine) {
      loadingEl.textContent = "Loading model (first time may take 1–2 min)...";
      engine = await CreateMLCEngine(DEFAULT_MODEL, {
        initProgressCallback: (report) => {
          loadingEl.textContent = report.text || "Loading...";
        },
      });
    }

    loadingEl.textContent = "Running AI...";

    const { profile = {} } = await chrome.storage.local.get("profile");
    const fieldsDesc = extractedFields
      .map((f) => `- id: "${f.id}", label: "${f.label}", type: ${f.type}`)
      .join("\n");
    const profileDesc = JSON.stringify(profile, null, 0);

    const prompt = `You are a form autofill assistant. Map each form field to the appropriate value from the user's profile.

Form fields:
${fieldsDesc}

User profile: ${profileDesc}

Return ONLY a valid JSON object where keys are field ids and values are the profile value to fill. Use empty string for fields you cannot match. Example: {"email":"user@example.com","name":"John Doe"}`;

    const completion = await engine.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      stream: false,
    });

    const content = completion?.choices?.[0]?.message?.content || "{}";
    let mapping;
    try {
      mapping = JSON.parse(content);
    } catch {
      mapping = {};
    }
    if (typeof mapping === "object" && mapping !== null) {
      applyMappingToInputs(mapping);
    }
  } catch (err) {
    console.error("AI suggest failed:", err);
    errorEl.textContent = err.message || "AI failed. Using heuristics.";
    errorEl.style.display = "block";
    const { profile = {} } = await chrome.storage.local.get("profile");
    const fallback = heuristicMap(extractedFields, profile);
    applyMappingToInputs(fallback);
  } finally {
    loadingEl.style.display = "none";
  }
}

document.getElementById("suggest-btn")?.addEventListener("click", suggestWithAI);

// Listen for extracted form data
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "form-extracted" && message.fields) {
    renderFields(message.fields);
  }
});

// Check session storage for form extracted before panel was ready
async function checkStoredForm() {
  const data = await chrome.storage.session.get("lastExtractedForm");
  if (data.lastExtractedForm) {
    renderFields(data.lastExtractedForm);
    chrome.storage.session.remove("lastExtractedForm");
  }
}

loadProfile();
checkStoredForm();
