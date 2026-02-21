# Agentic Autofill MVP

Chrome extension MVP for guided job-form automation using local-only WebLLM (WebGPU), with user-confirmed step-by-step execution.

## What This MVP Does

- Captures form fields from the active tab (text/select/radio/checkbox).
- Uses local profile + resume context from extension storage.
- Generates an action plan via local WebLLM, with rule-based fallback.
- Executes one approved action at a time (Approve / Skip / Edit value).
- Supports guided `Next`/`Continue` button clicks.
- Includes emergency stop and queue reset controls.

## Stack

- Plasmo + React floating menu (injected on whitelisted pages)
- Manifest V3 Chrome extension
- `@mlc-ai/web-llm` local inference on WebGPU

## Local Run

```bash
npm install
npm run dev
```

Load the generated extension from the build output folder in Chrome (`chrome://extensions`) with Developer Mode enabled.

## Production Build

```bash
npm run typecheck
npm run build
```

## Deterministic Demo Runbook

### Primary Site (recommended)

- `jobs.lever.co` form flow

### Backup Site

- `boards.greenhouse.io` form flow

### Demo Script

1. Open a known job-application page on primary site.
2. Click the floating FAB (bottom-right) to open the menu.
3. Click **Prewarm Local WebLLM** before starting the timed flow.
4. Confirm whitelist includes the target domain.
5. Save or verify profile + resume text.
6. Click **Capture form**.
7. Click **Plan actions**.
8. For 5-10 actions, show judge flow:
   - explain reasoning/confidence,
   - optionally edit one value,
   - approve execution step-by-step.
9. Show one guided `Next` click action.
10. Highlight execution log + emergency stop control.

## Safety Guardrails

- Domain whitelist enforced before extract/execute.
- Never auto-submits form.
- User confirmation required for each step.
- Stops on hidden/disabled/missing targets.
- Local-only storage and local-only model inference.

## Fast Cut Scope (if time-constrained)

- Keep one demo site only.
- Use profile + pasted resume text (no complex file parsing).
- Prioritize text/select fields first.
- Use rule-based planner if model output is malformed.
