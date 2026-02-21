import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type SetStateAction } from "react"

import { DEFAULT_WHITELIST } from "~src/config/whitelist"
import { buildActionPlan } from "~src/lib/action-engine"
import {
  DEFAULT_PROFILE,
  DEFAULT_RESUME,
  loadAgentContext,
  loadProfile,
  loadResume,
  loadWhitelist,
  saveProfile,
  saveResumeRawText,
  saveWhitelist
} from "~src/lib/storage"
import { type CuratedModel, getCuratedModels, getWebLlmStatus, isModelReady, setPreferredModel, warmupWebLlm } from "~src/lib/webllm"
import type { ActionLogEntry, AgentAction, FormSnapshot, UserProfile } from "~src/types/agent"
import type { AgentRequest, AgentResponse } from "~src/types/messages"

const panelStyle: CSSProperties = {
  fontFamily:
    "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontSize: 12,
  color: "#101828",
  padding: 12,
  lineHeight: 1.45
}

const sectionStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: 10,
  marginBottom: 10,
  background: "#ffffff"
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #d0d5dd",
  borderRadius: 6,
  marginBottom: 6,
  boxSizing: "border-box"
}

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  flexWrap: "wrap",
  marginTop: 6
}

const buttonStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid #98a2b3",
  background: "#f8f9fb",
  cursor: "pointer",
  fontSize: 12
}

const parseWhitelistText = (value: string) =>
  value
    .split(/[\n,]/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

const resolveActiveTabId = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) {
    throw new Error("No active tab found")
  }
  return tab.id
}

const ensureContentScriptInjected = async (tabId: number): Promise<void> => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "agent.ping" })
    return
  } catch {
    /* content script not ready - inject it */
  }
  const manifest = chrome.runtime.getManifest()
  const scripts = manifest.content_scripts?.[0]?.js
  if (!scripts?.[0]) {
    throw new Error("No content script found in manifest")
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [scripts[0]]
  })
}

const sendToActiveTab = async (payload: AgentRequest) => {
  const tabId = await resolveActiveTabId()
  await ensureContentScriptInjected(tabId)
  return (await chrome.tabs.sendMessage(tabId, payload)) as AgentResponse
}

const nextAction = (actions: AgentAction[], index: number) => {
  if (index < 0 || index >= actions.length) {
    return null
  }
  return actions[index]
}

const addLog = (
  updater: Dispatch<SetStateAction<ActionLogEntry[]>>,
  actionId: string,
  status: ActionLogEntry["status"],
  detail: string
) => {
  updater((previous) => [
    {
      id: crypto.randomUUID(),
      actionId,
      timestamp: Date.now(),
      status,
      detail
    },
    ...previous
  ])
}

const profileField = (
  profile: UserProfile,
  key: keyof UserProfile,
  setProfile: Dispatch<SetStateAction<UserProfile>>,
  label: string,
  placeholder = ""
) => (
  <label style={{ display: "block", marginBottom: 2 }}>
    {label}
    <input
      style={inputStyle}
      value={profile[key]}
      onChange={(event) =>
        setProfile((previous) => ({ ...previous, [key]: event.target.value }))
      }
      placeholder={placeholder}
    />
  </label>
)

const getQueueLabel = (actions: AgentAction[], currentActionIndex: number) => {
  if (actions.length === 0) {
    return "No actions"
  }
  const boundedIndex = Math.min(currentActionIndex + 1, actions.length)
  return `${boundedIndex}/${actions.length}`
}

const SidePanelApp = () => {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_PROFILE)
  const [resumeText, setResumeText] = useState(DEFAULT_RESUME.rawText)
  const [resumeHighlights, setResumeHighlights] = useState<string[]>([])
  const [whitelistText, setWhitelistText] = useState(DEFAULT_WHITELIST.join("\n"))

  const [snapshot, setSnapshot] = useState<FormSnapshot | null>(null)
  const [actions, setActions] = useState<AgentAction[]>([])
  const [currentActionIndex, setCurrentActionIndex] = useState(0)
  const [editableActionValue, setEditableActionValue] = useState("")
  const [planningSource, setPlanningSource] = useState("none")
  const [logs, setLogs] = useState<ActionLogEntry[]>([])
  const [statusMessage, setStatusMessage] = useState("Ready")
  const [isBusy, setIsBusy] = useState(false)
  const [isStopped, setIsStopped] = useState(false)
  const [modelStatusMessage, setModelStatusMessage] = useState("idle")
  const [curatedModels, setCuratedModels] = useState<CuratedModel[]>([])
  const [selectedModel, setSelectedModel] = useState("")

  useEffect(() => {
    const hydrate = async () => {
      const [storedProfile, storedResume, storedWhitelist] = await Promise.all([
        loadProfile(),
        loadResume(),
        loadWhitelist(DEFAULT_WHITELIST)
      ])
      setProfile(storedProfile)
      setResumeText(storedResume.rawText)
      setResumeHighlights(storedResume.parsedHighlights)
      setWhitelistText(storedWhitelist.join("\n"))
      setCuratedModels(getCuratedModels())
      const status = getWebLlmStatus()
      setModelStatusMessage(`${status.state}: ${status.detail}`)
    }
    hydrate().catch((error: unknown) => {
      setStatusMessage(
        error instanceof Error ? error.message : "Failed to load local settings"
      )
    })
  }, [])

  const whitelist = useMemo(() => parseWhitelistText(whitelistText), [whitelistText])
  const currentAction = nextAction(actions, currentActionIndex)

  useEffect(() => {
    setEditableActionValue(currentAction?.value ?? "")
  }, [currentAction?.id, currentAction?.value])

  const withBusyState = async (task: () => Promise<void>) => {
    if (isBusy) {
      return
    }
    setIsBusy(true)
    try {
      await task()
    } finally {
      setIsBusy(false)
    }
  }

  const handleSaveProfile = async () => {
    await withBusyState(async () => {
      await saveProfile(profile)
      setStatusMessage("Profile saved to local extension storage.")
    })
  }

  const handleResumeFile = async (file: File) => {
    const text = await file.text()
    setResumeText(text)
  }

  const handleSaveResume = async () => {
    await withBusyState(async () => {
      await saveResumeRawText(resumeText)
      const refreshed = await loadResume()
      setResumeHighlights(refreshed.parsedHighlights)
      setStatusMessage("Resume text saved and highlights extracted.")
    })
  }

  const handleSaveWhitelist = async () => {
    await withBusyState(async () => {
      const normalized = whitelist.length > 0 ? whitelist : DEFAULT_WHITELIST
      await saveWhitelist(normalized)
      setWhitelistText(normalized.join("\n"))
      setStatusMessage("Whitelist saved.")
    })
  }

  const handleWarmupModel = async () => {
    await withBusyState(async () => {
      setModelStatusMessage("loading: starting")
      await warmupWebLlm((report) => {
        const percent = Math.round(report.progress * 100)
        setModelStatusMessage(`loading: ${report.text} (${percent}%)`)
      })
      const modelStatus = getWebLlmStatus()
      setModelStatusMessage(`${modelStatus.state}: ${modelStatus.detail}`)
      setStatusMessage("Local WebLLM is ready.")
    })
  }

  const handleExtractForm = async () => {
    await withBusyState(async () => {
      const response = await sendToActiveTab({
        type: "agent.extractForm",
        whitelist
      })
      if (!response?.ok) {
        throw new Error(response?.error ?? "Failed to extract form")
      }
      if (response.type !== "agent.extractForm") {
        throw new Error("Unexpected response when extracting form")
      }
      setSnapshot(response.snapshot)
      setStatusMessage(
        `Captured ${response.snapshot.fields.length} fields and ${response.snapshot.navigationTargets.length} navigation controls.`
      )
    })
  }

  const handlePlanActions = async () => {
    await withBusyState(async () => {
      if (!snapshot) {
        throw new Error("Capture a form snapshot first.")
      }

      if (!isModelReady()) {
        setStatusMessage("Loading model before planning...")
        setModelStatusMessage("loading: auto-warmup for planning")
        try {
          await warmupWebLlm((report) => {
            const percent = Math.round(report.progress * 100)
            setModelStatusMessage(`loading: ${report.text} (${percent}%)`)
          })
          const modelStatus = getWebLlmStatus()
          setModelStatusMessage(`${modelStatus.state}: ${modelStatus.detail}`)
        } catch {
          setModelStatusMessage("error: model failed to load, using rule-based fallback")
        }
      }

      const context = await loadAgentContext()
      const result = await buildActionPlan(snapshot, context)
      setActions(result.actions)
      setCurrentActionIndex(0)
      setIsStopped(false)
      setPlanningSource(result.source)

      const detail = result.llmDetail ? ` — ${result.llmDetail}` : ""
      setStatusMessage(
        `Planned ${result.actions.length} steps using ${result.source} mode${detail}`
      )
    })
  }

  const handleApproveStep = async () => {
    if (!currentAction) {
      return
    }
    await withBusyState(async () => {
      if (isStopped) {
        throw new Error("Execution stopped. Reset queue before approving steps.")
      }

      let actionToRun = currentAction
      if (editableActionValue !== currentAction.value) {
        actionToRun = { ...currentAction, value: editableActionValue }
        setActions((previous) =>
          previous.map((item) =>
            item.id === currentAction.id ? actionToRun : item
          )
        )
        addLog(setLogs, actionToRun.id, "edited", `Edited value to: ${editableActionValue}`)
      }

      addLog(setLogs, actionToRun.id, "approved", `Approved ${actionToRun.fieldLabel}`)
      const response = await sendToActiveTab({
        type: "agent.executeAction",
        whitelist,
        action: actionToRun
      })

      if (!response.ok) {
        addLog(
          setLogs,
          actionToRun.id,
          "failed",
          response.error ?? "Execution failed in page context"
        )
        throw new Error(response.error ?? "Action execution failed")
      }
      if (response.type !== "agent.executeAction") {
        throw new Error("Unexpected response when executing action")
      }

      addLog(setLogs, actionToRun.id, "executed", response.detail)
      setCurrentActionIndex((previous) => previous + 1)
      setStatusMessage(response.detail)
    })
  }

  const handleSkipStep = () => {
    if (!currentAction) {
      return
    }
    addLog(setLogs, currentAction.id, "skipped", `Skipped ${currentAction.fieldLabel}`)
    setCurrentActionIndex((previous) => previous + 1)
  }

  const handleStop = () => {
    setIsStopped(true)
    addLog(setLogs, currentAction?.id ?? "none", "stopped", "Emergency stop engaged")
    setStatusMessage("Stopped. Reset queue to continue.")
  }

  const handleResetQueue = () => {
    setActions([])
    setCurrentActionIndex(0)
    setIsStopped(false)
    setPlanningSource("none")
    setStatusMessage("Queue reset.")
  }

  return (
    <main style={panelStyle}>
      <h1 style={{ fontSize: 15, marginTop: 0, marginBottom: 10 }}>
        Agentic Autofill MVP
      </h1>

      <section style={sectionStyle}>
        <strong>Model</strong>
        {curatedModels.length > 0 && (
          <label style={{ display: "block", marginBottom: 4, marginTop: 4 }}>
            <select
              style={{ ...inputStyle, cursor: "pointer" }}
              value={selectedModel}
              onChange={(event) => {
                setSelectedModel(event.target.value)
                setPreferredModel(event.target.value)
                setModelStatusMessage("idle: model changed, needs reload")
              }}>
              <option value="">Auto (smallest available)</option>
              {curatedModels.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </label>
        )}
        <p style={{ margin: "6px 0" }}>Status: {modelStatusMessage}</p>
        <button style={buttonStyle} onClick={handleWarmupModel} disabled={isBusy}>
          Prewarm Local WebLLM
        </button>
      </section>

      <section style={sectionStyle}>
        <strong>Profile</strong>
        {profileField(profile, "fullName", setProfile, "Full name")}
        {profileField(profile, "email", setProfile, "Email")}
        {profileField(profile, "phone", setProfile, "Phone")}
        {profileField(profile, "streetAddress", setProfile, "Street address")}
        {profileField(profile, "city", setProfile, "City")}
        {profileField(profile, "state", setProfile, "State / Province")}
        {profileField(profile, "country", setProfile, "Country")}
        {profileField(profile, "zipCode", setProfile, "Zip / Postal code")}
        {profileField(profile, "linkedin", setProfile, "LinkedIn URL")}
        {profileField(profile, "github", setProfile, "GitHub URL")}
        {profileField(profile, "portfolio", setProfile, "Portfolio URL")}
        {profileField(profile, "currentTitle", setProfile, "Current title")}
        {profileField(profile, "yearsExperience", setProfile, "Years of experience")}
        {profileField(
          profile,
          "workAuthorization",
          setProfile,
          "Work authorization (e.g., US citizen)"
        )}
        {profileField(
          profile,
          "needsSponsorship",
          setProfile,
          "Needs sponsorship (yes/no)"
        )}
        <label style={{ display: "block", marginBottom: 2 }}>
          Summary
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
            value={profile.summary}
            onChange={(event) =>
              setProfile((previous) => ({ ...previous, summary: event.target.value }))
            }
          />
        </label>
        <button style={buttonStyle} onClick={handleSaveProfile} disabled={isBusy}>
          Save profile
        </button>
      </section>

      <section style={sectionStyle}>
        <strong>Resume Context</strong>
        <textarea
          style={{ ...inputStyle, minHeight: 90, resize: "vertical" }}
          value={resumeText}
          onChange={(event) => setResumeText(event.target.value)}
          placeholder="Paste resume text for local parsing"
        />
        <input
          type="file"
          accept=".txt,.md,.text"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) {
              return
            }
            handleResumeFile(file).catch((error: unknown) =>
              setStatusMessage(
                error instanceof Error ? error.message : "Failed reading resume file"
              )
            )
          }}
        />
        <div style={buttonRowStyle}>
          <button style={buttonStyle} onClick={handleSaveResume} disabled={isBusy}>
            Save resume text
          </button>
        </div>
        {resumeHighlights.length > 0 && (
          <ul style={{ paddingLeft: 16, margin: "8px 0 0" }}>
            {resumeHighlights.map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <section style={sectionStyle}>
        <strong>Domain Whitelist</strong>
        <textarea
          style={{ ...inputStyle, minHeight: 70, resize: "vertical" }}
          value={whitelistText}
          onChange={(event) => setWhitelistText(event.target.value)}
          placeholder="One hostname per line"
        />
        <button style={buttonStyle} onClick={handleSaveWhitelist} disabled={isBusy}>
          Save whitelist
        </button>
      </section>

      <section style={sectionStyle}>
        <strong>Run Flow</strong>
        <div style={buttonRowStyle}>
          <button style={buttonStyle} onClick={handleExtractForm} disabled={isBusy}>
            1. Capture form
          </button>
          <button style={buttonStyle} onClick={handlePlanActions} disabled={isBusy || !snapshot}>
            2. Plan actions
          </button>
        </div>
        <div style={buttonRowStyle}>
          <button
            style={buttonStyle}
            onClick={handleApproveStep}
            disabled={isBusy || !currentAction || isStopped}>
            Approve step
          </button>
          <button style={buttonStyle} onClick={handleSkipStep} disabled={isBusy || !currentAction}>
            Skip step
          </button>
          <button style={buttonStyle} onClick={handleStop} disabled={!currentAction}>
            Emergency stop
          </button>
          <button style={buttonStyle} onClick={handleResetQueue}>
            Reset queue
          </button>
        </div>
        <p style={{
          margin: "8px 0 4px",
          color: planningSource === "hybrid" ? "#027a48"
            : planningSource === "rule-based" ? "#b54708"
            : "#344054"
        }}>
          Planner: {planningSource === "hybrid" ? "hybrid (LLM + rules)"
            : planningSource === "rule-based" ? "rule-based (LLM unavailable)"
            : planningSource}
        </p>
        <p style={{ margin: "4px 0" }}>
          Queue: {getQueueLabel(actions, currentActionIndex)}
        </p>
        {currentAction && (
          <div style={{ border: "1px solid #eaecf0", borderRadius: 6, padding: 8 }}>
            <div>
              <strong>{currentAction.type}</strong> - {currentAction.fieldLabel}
            </div>
            <div>Confidence: {(currentAction.confidence * 100).toFixed(0)}%</div>
            <div style={{ marginTop: 4 }}>Reason: {currentAction.reasoning}</div>
            <label style={{ display: "block", marginTop: 6 }}>
              Value (editable)
              <input
                style={inputStyle}
                value={editableActionValue}
                onChange={(event) => setEditableActionValue(event.target.value)}
              />
            </label>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <strong>Execution Log</strong>
        {logs.length === 0 ? (
          <p style={{ margin: "6px 0 0" }}>No actions logged yet.</p>
        ) : (
          <ul style={{ margin: "8px 0 0", paddingLeft: 14 }}>
            {logs.slice(0, 10).map((log) => (
              <li key={log.id}>
                [{new Date(log.timestamp).toLocaleTimeString()}] {log.status} - {log.detail}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ marginBottom: 0 }}>Status: {statusMessage}</p>
    </main>
  )
}

export default SidePanelApp
