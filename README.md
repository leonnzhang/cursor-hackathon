# FormFlow

**Cursor Composer 1.5 Hackathon Submission**

Chrome extension for guided form automation using local-only WebLLM (WebGPU), with user-confirmed step-by-step execution.

## Hackathon Context

This project was built during the **Cursor Composer 1.5 Hackathon** (Feb 2026).

### Theme: AI-Native Development
We embraced the "Rapid iteration" and "Shipping something functional" goals. This entire extension—from the React/Plasmo scaffolding to the WebLLM integration—was accelerated using Cursor Composer 1.5.

### Composer 1.5 Experience
- **What worked well**: Rapidly scaffolding the Chrome Extension manifest and message passing architecture. Generating complex React components for the floating UI.
- **Where it struggled**: Context limits when dealing with very large library definitions (WebLLM), though 1.5 handled it better than previous versions.
- **Workflow**: We used Composer to iterate on the "Action Planner" logic, treating the IDE as a pair programmer that understands the full context of the repo.

## What This MVP Does (Innovation & Impact)

**Problem**: Job applications and repetitive forms are tedious. Existing autofillers are dumb (regex-based) or privacy-nightmares (cloud-based).
**Solution**: A local-first AI agent that lives in your browser.

- **Privacy First**: Uses `@mlc-ai/web-llm` to run the LLM *entirely in the browser* (WebGPU). No data leaves your machine.
- **Human-in-the-Loop**: It doesn't just click wildly. It proposes a plan, and you approve/edit each step.
- **Smart Context**: Uses your local profile + resume to answer questions, not just fill standard fields.

### Key Features
- Captures form fields from the active tab (text/select/radio/checkbox).
- Generates an action plan via local WebLLM.
- Executes one approved action at a time (Approve / Skip / Edit value).
- Supports guided `Next`/`Continue` button clicks.
- Emergency stop and queue reset controls.

## Stack

- **Plasmo** + React (Floating UI injected on whitelisted pages)
- **Manifest V3** Chrome extension
- **WebLLM** (Local LLM inference on WebGPU)
- **TailwindCSS** (Styling)

## Local Run

```bash
npm install
npm run dev
```

Load the generated extension from the `build/chrome-mv3-dev` folder in Chrome (`chrome://extensions`) with Developer Mode enabled.

## Production Build

```bash
npm run build
```

## Deterministic Demo Runbook (Judging)

**Scenario**: Applying for a job on a supported board (Lever/Greenhouse).

1. **Setup**:
   - Open a job application page (e.g., `jobs.lever.co`).
   - Click the FormFlow FAB (bottom-right).
   - **Prewarm Local WebLLM** (downloads model weights to cache).
2. **Capture**:
   - Click **Capture form**. The agent scans the DOM for inputs.
3. **Plan**:
   - Click **Plan actions**. The local LLM generates a filling strategy based on your resume.
4. **Execute**:
   - Review the proposed actions.
   - Click **Approve** to fill fields one by one.
   - Watch it handle text inputs, dropdowns, and checkboxes.
5. **Safety**:
   - Show how the user remains in control (Approve/Skip).
   - Emergency Stop available at any time.

## Safety Guardrails

- Domain whitelist enforced.
- Never auto-submits.
- User confirmation required for each step.
- **Local-only** model inference (Privacy).

## Future Roadmap

- [ ] Support for multi-page forms (state persistence).
- [ ] PDF Resume parsing (currently text-based).
- [ ] More robust error handling for dynamic DOM changes.
