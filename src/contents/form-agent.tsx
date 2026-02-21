import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction
} from "react"
import type { PlasmoCSConfig } from "plasmo"

import { DEFAULT_WHITELIST } from "~src/config/whitelist"
import { getHostnameFromUrl, isWhitelistedHost } from "~src/config/whitelist"
import { buildActionPlan } from "~src/lib/action-engine"
import { extractFormSnapshot } from "~src/lib/form-extractor"
import { ensureWhitelisted, executeAction } from "~src/lib/action-executor"
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
import {
  type CuratedModel,
  getCuratedModels,
  getWebLlmStatus,
  isModelReady,
  setPreferredModel,
  warmupWebLlm
} from "~src/lib/webllm"
import type {
  ActionLogEntry,
  AgentAction,
  FormSnapshot,
  UserProfile
} from "~src/types/agent"
import type { AgentRequest, AgentResponse } from "~src/types/messages"

declare global {
  interface Window {
    __agenticAutofillInitialized?: boolean
  }
}

const handleMessage = async (message: AgentRequest): Promise<AgentResponse> => {
  switch (message.type) {
    case "agent.ping":
      return { ok: true, type: "agent.ping", detail: "form-agent-ready" }
    case "agent.extractForm":
      ensureWhitelisted(message.whitelist)
      return {
        ok: true,
        type: "agent.extractForm",
        snapshot: extractFormSnapshot()
      }
    case "agent.executeAction":
      ensureWhitelisted(message.whitelist)
      return {
        ok: true,
        type: "agent.executeAction",
        detail: executeAction(message.action)
      }
    default:
      return { ok: false, error: "Unknown message type" }
  }
}

const bootFormAgent = () => {
  if (window.__agenticAutofillInitialized) return
  window.__agenticAutofillInitialized = true
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message as AgentRequest)
      .then((response) => sendResponse(response))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown content error"
        } satisfies AgentResponse)
      )
    return true
  })
}

bootFormAgent()

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
  all_frames: false
}

const parseWhitelistText = (value: string) =>
  value
    .split(/[\n,]/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)

const nextAction = (actions: AgentAction[], index: number) => {
  if (index < 0 || index >= actions.length) return null
  return actions[index]
}

const addLog = (
  updater: Dispatch<SetStateAction<ActionLogEntry[]>>,
  actionId: string,
  status: ActionLogEntry["status"],
  detail: string
) => {
  updater((prev) => [
    { id: crypto.randomUUID(), actionId, timestamp: Date.now(), status, detail },
    ...prev
  ])
}

const getQueueLabel = (actions: AgentAction[], currentActionIndex: number) => {
  if (actions.length === 0) return "No actions"
  const boundedIndex = Math.min(currentActionIndex + 1, actions.length)
  return `${boundedIndex}/${actions.length}`
}

const baseStyle: CSSProperties = {
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontSize: 12,
  color: "#101828",
  lineHeight: 1.45,
  boxSizing: "border-box"
}

const sectionStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 6,
  padding: 10,
  marginBottom: 8,
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
      onChange={(e) =>
        setProfile((prev) => ({ ...prev, [key]: e.target.value }))
      }
      placeholder={placeholder}
    />
  </label>
)

type TabId = "setup" | "run" | "log"

const FloatingMenu = () => {
  const [expanded, setExpanded] = useState(false)
  const [activeTab, setActiveTab] = useState<TabId>("run")
  const [showProfileModal, setShowProfileModal] = useState(false)

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
  const [isWhitelisted, setIsWhitelisted] = useState(true)

  const whitelist = useMemo(() => parseWhitelistText(whitelistText), [whitelistText])
  const currentAction = nextAction(actions, currentActionIndex)

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

      const hostname = getHostnameFromUrl(window.location.href)
      setIsWhitelisted(
        storedWhitelist.length === 0 || isWhitelistedHost(hostname, storedWhitelist)
      )
    }
    hydrate().catch((err: unknown) => {
      setStatusMessage(
        err instanceof Error ? err.message : "Failed to load settings"
      )
    })
  }, [])

  useEffect(() => {
    setEditableActionValue(currentAction?.value ?? "")
  }, [currentAction?.id, currentAction?.value])

  const withBusyState = async (task: () => Promise<void>) => {
    if (isBusy) return
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
      setStatusMessage("Profile saved.")
      setShowProfileModal(false)
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
      setStatusMessage("Resume saved.")
    })
  }

  const handleSaveWhitelist = async () => {
    await withBusyState(async () => {
      const normalized = whitelist.length > 0 ? whitelist : DEFAULT_WHITELIST
      await saveWhitelist(normalized)
      setWhitelistText(normalized.join("\n"))
      setStatusMessage("Whitelist saved.")

      const hostname = getHostnameFromUrl(window.location.href)
      setIsWhitelisted(isWhitelistedHost(hostname, normalized))
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
      setStatusMessage("WebLLM ready.")
    })
  }

  const handleExtractForm = async () => {
    await withBusyState(async () => {
      ensureWhitelisted(whitelist)
      const snapshotData = extractFormSnapshot()
      setSnapshot(snapshotData)
      setStatusMessage(
        `Captured ${snapshotData.fields.length} fields, ${snapshotData.navigationTargets.length} nav controls.`
      )
    })
  }

  const handlePlanActions = async () => {
    await withBusyState(async () => {
      if (!snapshot) throw new Error("Capture form first.")

      if (!isModelReady()) {
        setStatusMessage("Loading model...")
        setModelStatusMessage("loading: auto-warmup")
        try {
          await warmupWebLlm((report) => {
            const percent = Math.round(report.progress * 100)
            setModelStatusMessage(`loading: ${report.text} (${percent}%)`)
          })
          const modelStatus = getWebLlmStatus()
          setModelStatusMessage(`${modelStatus.state}: ${modelStatus.detail}`)
        } catch {
          setModelStatusMessage("error: using rule-based fallback")
        }
      }

      const context = await loadAgentContext()
      const result = await buildActionPlan(snapshot, context)
      setActions(result.actions)
      setCurrentActionIndex(0)
      setIsStopped(false)
      setPlanningSource(result.source)
      setStatusMessage(
        `Planned ${result.actions.length} steps (${result.source})`
      )
    })
  }

  const handleApproveStep = async () => {
    if (!currentAction) return
    await withBusyState(async () => {
      if (isStopped)
        throw new Error("Execution stopped. Reset queue first.")

      let actionToRun = currentAction
      if (editableActionValue !== currentAction.value) {
        actionToRun = { ...currentAction, value: editableActionValue }
        setActions((prev) =>
          prev.map((item) => (item.id === currentAction.id ? actionToRun : item))
        )
        addLog(setLogs, actionToRun.id, "edited", `Edited: ${editableActionValue}`)
      }

      addLog(setLogs, actionToRun.id, "approved", `Approved ${actionToRun.fieldLabel}`)
      try {
        const detail = executeAction(actionToRun)
        addLog(setLogs, actionToRun.id, "executed", detail)
        setCurrentActionIndex((prev) => prev + 1)
        setStatusMessage(detail)
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Execution failed"
        addLog(setLogs, actionToRun.id, "failed", msg)
        throw err
      }
    })
  }

  const handleSkipStep = () => {
    if (!currentAction) return
    addLog(setLogs, currentAction.id, "skipped", `Skipped ${currentAction.fieldLabel}`)
    setCurrentActionIndex((prev) => prev + 1)
  }

  const handleStop = () => {
    setIsStopped(true)
    addLog(setLogs, currentAction?.id ?? "none", "stopped", "Emergency stop")
    setStatusMessage("Stopped. Reset queue to continue.")
  }

  const handleResetQueue = () => {
    setActions([])
    setCurrentActionIndex(0)
    setIsStopped(false)
    setPlanningSource("none")
    setStatusMessage("Queue reset.")
  }

  if (!isWhitelisted) return null

  return (
    <div style={baseStyle}>
      {expanded && (
        <div
          style={{
            position: "fixed",
            bottom: 56,
            right: 16,
            width: 320,
            maxHeight: "80vh",
            background: "#fff",
            borderRadius: 10,
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            zIndex: 2147483646
          }}>
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid #e5e7eb",
              padding: "6px 8px",
              gap: 4
            }}>
            {(["setup", "run", "log"] as const).map((tab) => (
              <button
                key={tab}
                style={{
                  ...buttonStyle,
                  background: activeTab === tab ? "#e5e7eb" : "transparent",
                  textTransform: "capitalize"
                }}
                onClick={() => setActiveTab(tab)}>
                {tab}
              </button>
            ))}
          </div>

          <div style={{ overflow: "auto", flex: 1, padding: 10 }}>
            {activeTab === "setup" && (
              <div>
                <section style={sectionStyle}>
                  <strong>Model</strong>
                  {curatedModels.length > 0 && (
                    <label style={{ display: "block", marginBottom: 4, marginTop: 4 }}>
                      <select
                        style={{ ...inputStyle, cursor: "pointer" }}
                        value={selectedModel}
                        onChange={(e) => {
                          setSelectedModel(e.target.value)
                          setPreferredModel(e.target.value)
                          setModelStatusMessage("idle: model changed")
                        }}>
                        <option value="">Auto (smallest)</option>
                        {curatedModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p style={{ margin: "6px 0" }}>{modelStatusMessage}</p>
                  <button style={buttonStyle} onClick={handleWarmupModel} disabled={isBusy}>
                    Prewarm WebLLM
                  </button>
                </section>

                <section style={sectionStyle}>
                  <strong>Profile</strong>
                  <button style={buttonStyle} onClick={() => setShowProfileModal(true)}>
                    Edit profile
                  </button>
                </section>

                <section style={sectionStyle}>
                  <strong>Resume</strong>
                  <textarea
                    style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
                    value={resumeText}
                    onChange={(e) => setResumeText(e.target.value)}
                    placeholder="Paste resume text"
                  />
                  <input
                    type="file"
                    accept=".txt,.md,.text"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleResumeFile(f).catch(console.error)
                    }}
                  />
                  <div style={buttonRowStyle}>
                    <button style={buttonStyle} onClick={handleSaveResume} disabled={isBusy}>
                      Save resume
                    </button>
                  </div>
                  {resumeHighlights.length > 0 && (
                    <ul style={{ paddingLeft: 16, margin: "8px 0 0" }}>
                      {resumeHighlights.slice(0, 4).map((line, i) => (
                        <li key={`${line}-${i}`}>{line}</li>
                      ))}
                    </ul>
                  )}
                </section>

                <section style={sectionStyle}>
                  <strong>Domain Whitelist</strong>
                  <textarea
                    style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
                    value={whitelistText}
                    onChange={(e) => setWhitelistText(e.target.value)}
                    placeholder="One hostname per line"
                  />
                  <button style={buttonStyle} onClick={handleSaveWhitelist} disabled={isBusy}>
                    Save whitelist
                  </button>
                </section>
              </div>
            )}

            {activeTab === "run" && (
              <div>
                <section style={sectionStyle}>
                  <strong>Run Flow</strong>
                  <div style={buttonRowStyle}>
                    <button style={buttonStyle} onClick={handleExtractForm} disabled={isBusy}>
                      1. Capture form
                    </button>
                    <button
                      style={buttonStyle}
                      onClick={handlePlanActions}
                      disabled={isBusy || !snapshot}>
                      2. Plan actions
                    </button>
                  </div>
                  <div style={buttonRowStyle}>
                    <button
                      style={buttonStyle}
                      onClick={handleApproveStep}
                      disabled={isBusy || !currentAction || isStopped}>
                      Approve
                    </button>
                    <button style={buttonStyle} onClick={handleSkipStep} disabled={isBusy || !currentAction}>
                      Skip
                    </button>
                    <button style={buttonStyle} onClick={handleStop} disabled={!currentAction}>
                      Stop
                    </button>
                    <button style={buttonStyle} onClick={handleResetQueue}>
                      Reset
                    </button>
                  </div>
                  <p
                    style={{
                      margin: "8px 0 4px",
                      color:
                        planningSource === "hybrid"
                          ? "#027a48"
                          : planningSource === "rule-based"
                            ? "#b54708"
                            : "#344054"
                    }}>
                    Planner: {planningSource}
                  </p>
                  <p style={{ margin: "4px 0" }}>
                    Queue: {getQueueLabel(actions, currentActionIndex)}
                  </p>
                  {currentAction && (
                    <div
                      style={{
                        border: "1px solid #eaecf0",
                        borderRadius: 6,
                        padding: 8
                      }}>
                      <div>
                        <strong>{currentAction.type}</strong> - {currentAction.fieldLabel}
                      </div>
                      <div>Confidence: {(currentAction.confidence * 100).toFixed(0)}%</div>
                      <div style={{ marginTop: 4 }}>{currentAction.reasoning}</div>
                      <label style={{ display: "block", marginTop: 6 }}>
                        Value
                        <input
                          style={inputStyle}
                          value={editableActionValue}
                          onChange={(e) => setEditableActionValue(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeTab === "log" && (
              <section style={sectionStyle}>
                <strong>Execution Log</strong>
                {logs.length === 0 ? (
                  <p style={{ margin: "6px 0 0" }}>No actions yet.</p>
                ) : (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 14 }}>
                    {logs.slice(0, 10).map((log) => (
                      <li key={log.id}>
                        [{new Date(log.timestamp).toLocaleTimeString()}] {log.status} -{" "}
                        {log.detail}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>

          <p style={{ padding: "6px 10px", margin: 0, fontSize: 11, color: "#64748b" }}>
            {statusMessage}
          </p>
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          position: "fixed",
          bottom: 16,
          right: 16,
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: "#374151",
          color: "#fff",
          border: "none",
          cursor: "pointer",
          fontSize: 20,
          boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
          zIndex: 2147483647,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}>
        {expanded ? "×" : "◇"}
      </button>

      {showProfileModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 2147483648
          }}
          onClick={() => setShowProfileModal(false)}>
          <div
            style={{
              background: "#fff",
              borderRadius: 10,
              padding: 16,
              maxWidth: 400,
              maxHeight: "90vh",
              overflow: "auto",
              boxShadow: "0 4px 20px rgba(0,0,0,0.2)"
            }}
            onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px" }}>Edit Profile</h3>
            {profileField(profile, "fullName", setProfile, "Full name")}
            {profileField(profile, "email", setProfile, "Email")}
            {profileField(profile, "phone", setProfile, "Phone")}
            {profileField(profile, "streetAddress", setProfile, "Street address")}
            {profileField(profile, "city", setProfile, "City")}
            {profileField(profile, "state", setProfile, "State")}
            {profileField(profile, "country", setProfile, "Country")}
            {profileField(profile, "zipCode", setProfile, "Zip code")}
            {profileField(profile, "linkedin", setProfile, "LinkedIn")}
            {profileField(profile, "github", setProfile, "GitHub")}
            {profileField(profile, "portfolio", setProfile, "Portfolio")}
            {profileField(profile, "currentTitle", setProfile, "Title")}
            {profileField(profile, "yearsExperience", setProfile, "Years exp")}
            {profileField(profile, "workAuthorization", setProfile, "Work auth")}
            {profileField(profile, "needsSponsorship", setProfile, "Sponsorship")}
            <label style={{ display: "block", marginBottom: 2 }}>
              Summary
              <textarea
                style={{ ...inputStyle, minHeight: 60, resize: "vertical" }}
                value={profile.summary}
                onChange={(e) =>
                  setProfile((prev) => ({ ...prev, summary: e.target.value }))
                }
              />
            </label>
            <div style={buttonRowStyle}>
              <button style={buttonStyle} onClick={handleSaveProfile} disabled={isBusy}>
                Save
              </button>
              <button style={buttonStyle} onClick={() => setShowProfileModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default FloatingMenu
