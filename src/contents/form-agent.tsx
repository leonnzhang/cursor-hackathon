import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
  DEFAULT_AGENCY,
  DEFAULT_PROFILE,
  DEFAULT_RESUME,
  loadAgentContext,
  loadAgency,
  loadProfile,
  loadResume,
  loadWhitelist,
  saveAgency,
  saveProfile,
  saveResumeRawText,
  saveWhitelist
} from "~src/lib/storage"
import type { AgencySettings } from "~src/types/agent"
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
    __formflowInitialized?: boolean
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
  if (window.__formflowInitialized) return
  window.__formflowInitialized = true
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

const hasMeaningfulValue = (field: { kind: string; currentValue: string }) => {
  if (field.kind === "checkbox" || field.kind === "radio") {
    return field.currentValue === "true"
  }
  return field.currentValue.trim().length > 0
}

const MIN_FILLABLE_FIELDS = 2

const debounce = <T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
): ((...args: Parameters<T>) => void) => {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
}

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

const profileField = (
  profile: UserProfile,
  key: keyof UserProfile,
  setProfile: Dispatch<SetStateAction<UserProfile>>,
  label: string,
  placeholder = ""
) => (
  <label className="aa-field">
    <span className="aa-field-label">{label}</span>
    <input
      className="aa-input"
      value={profile[key]}
      onChange={(e) =>
        setProfile((prev) => ({ ...prev, [key]: e.target.value }))
      }
      placeholder={placeholder}
    />
  </label>
)

type TabId = "setup" | "run" | "dev"
type SaveKey = "profile" | "resume" | "agency" | "whitelist"

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
  const [agency, setAgency] = useState<AgencySettings>(DEFAULT_AGENCY)
  const [toast, setToast] = useState<{ message: string } | null>(null)
  const [savedFlash, setSavedFlash] = useState<Record<SaveKey, boolean>>({
    profile: false,
    resume: false,
    agency: false,
    whitelist: false
  })

  const whitelist = useMemo(() => parseWhitelistText(whitelistText), [whitelistText])
  const currentAction = nextAction(actions, currentActionIndex)
  const pendingActions = Math.max(actions.length - currentActionIndex, 0)
  const currentStep = Math.min(currentActionIndex + 1, Math.max(actions.length, 1))
  const stepProgress = actions.length
    ? (Math.min(currentActionIndex, actions.length) / actions.length) * 100
    : 0
  const statusTone = statusMessage.toLowerCase().includes("error")
    ? "error"
    : isBusy
      ? "busy"
      : "ready"
  const onFormCapturedRef = useRef<
    (snapshot: FormSnapshot, source: "manual" | "auto") => void
  >(() => {})

  const flashSaved = (key: SaveKey) => {
    setSavedFlash((prev) => ({ ...prev, [key]: true }))
    setTimeout(() => {
      setSavedFlash((prev) => ({ ...prev, [key]: false }))
    }, 900)
  }

  useEffect(() => {
    const hydrate = async () => {
      const [storedProfile, storedResume, storedWhitelist, storedAgency] =
        await Promise.all([
          loadProfile(),
          loadResume(),
          loadWhitelist(DEFAULT_WHITELIST),
          loadAgency()
        ])
      setProfile(storedProfile)
      setResumeText(storedResume.rawText)
      setResumeHighlights(storedResume.parsedHighlights)
      setWhitelistText(storedWhitelist.join("\n"))
      setAgency(storedAgency)
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

  useEffect(() => {
    if (!isWhitelisted || !agency.autoCapture) return

    let lastCapturedKey = ""
    let lastCapturedAt = 0
    const CAPTURE_COOLDOWN_MS = 10000

    const tryAutoCapture = () => {
      const snapshotData = extractFormSnapshot()
      const emptyCount = snapshotData.fields.filter(
        (f) => !hasMeaningfulValue(f)
      ).length
      if (emptyCount < MIN_FILLABLE_FIELDS) return

      const key = `${snapshotData.url}:${snapshotData.fields.length}`
      const now = Date.now()
      if (key === lastCapturedKey && now - lastCapturedAt < CAPTURE_COOLDOWN_MS) {
        return
      }
      lastCapturedKey = key
      lastCapturedAt = now
      onFormCapturedRef.current(snapshotData, "auto")
    }

    const debouncedCapture = debounce(tryAutoCapture, 400)

    const observer = new MutationObserver(() => debouncedCapture())
    observer.observe(document.body, {
      childList: true,
      subtree: true
    })

    debouncedCapture()

    const onPopState = () => debouncedCapture()
    window.addEventListener("popstate", onPopState)

    const origPush = history.pushState
    const origReplace = history.replaceState
    history.pushState = function (...args) {
      origPush.apply(this, args)
      debouncedCapture()
    }
    history.replaceState = function (...args) {
      origReplace.apply(this, args)
      debouncedCapture()
    }

    return () => {
      observer.disconnect()
      window.removeEventListener("popstate", onPopState)
      history.pushState = origPush
      history.replaceState = origReplace
    }
  }, [isWhitelisted, agency.autoCapture])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(timer)
  }, [toast])

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
      flashSaved("profile")
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
      flashSaved("resume")
    })
  }

  const handleSaveWhitelist = async () => {
    await withBusyState(async () => {
      const normalized = whitelist.length > 0 ? whitelist : DEFAULT_WHITELIST
      await saveWhitelist(normalized)
      setWhitelistText(normalized.join("\n"))
      setStatusMessage("Whitelist saved.")
      flashSaved("whitelist")

      const hostname = getHostnameFromUrl(window.location.href)
      setIsWhitelisted(isWhitelistedHost(hostname, normalized))
    })
  }

  const handleSaveAgency = async () => {
    await withBusyState(async () => {
      await saveAgency(agency)
      setStatusMessage("Agency settings saved.")
      flashSaved("agency")
    })
  }

  const handleWarmupModel = async () => {
    try {
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Model warmup failed"
      if (message.includes("WebLLM unavailable") || message.includes("Using rule-based planning")) {
        setModelStatusMessage("Rule-based planning")
        setStatusMessage("Using rule-based planning.")
        return
      }
      setModelStatusMessage(`error: ${message}`)
      setStatusMessage(message)
    }
  }

  const handlePlanActions = async (snapshotOverride?: FormSnapshot) => {
    const targetSnapshot = snapshotOverride ?? snapshot
    await withBusyState(async () => {
      if (!targetSnapshot) throw new Error("Capture form first.")

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
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "unknown"
          if (message.includes("WebLLM unavailable") || message.includes("Using rule-based planning")) {
            setModelStatusMessage("Rule-based planning")
          } else {
            setModelStatusMessage(`error: ${message}`)
          }
        }
      }

      const context = await loadAgentContext(targetSnapshot.jobContext)
      const result = await buildActionPlan(targetSnapshot, context)
      setActions(result.actions)
      setCurrentActionIndex(0)
      setIsStopped(false)
      setPlanningSource(result.source)
      setStatusMessage(
        `Planned ${result.actions.length} steps (${result.source})`
      )
    })
  }

  const onFormCaptured = (
    snapshotData: FormSnapshot,
    source: "manual" | "auto"
  ) => {
    setSnapshot(snapshotData)
    const jobNote = snapshotData.jobContext?.companyName || snapshotData.jobContext?.jobTitle
      ? ` (${[snapshotData.jobContext.jobTitle, snapshotData.jobContext.companyName].filter(Boolean).join(" @ ")})`
      : ""
    setStatusMessage(
      `Captured ${snapshotData.fields.length} fields, ${snapshotData.navigationTargets.length} nav controls.${jobNote}`
    )
    if (agency.autoPlan) {
      handlePlanActions(snapshotData).catch((err: unknown) => {
        setStatusMessage(
          err instanceof Error ? err.message : "Auto-plan failed"
        )
      })
    }
    if (agency.showCaptureToast && source === "auto") {
      setToast({
        message: `Form captured. ${snapshotData.fields.length} fields.`
      })
    }
  }
  onFormCapturedRef.current = onFormCaptured

  const handleExtractForm = async () => {
    await withBusyState(async () => {
      ensureWhitelisted(whitelist)
      const snapshotData = extractFormSnapshot()
      onFormCaptured(snapshotData, "manual")
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

  useEffect(() => {
    if (
      agency.autoExecuteThreshold > 0 &&
      currentAction &&
      !isStopped &&
      !isBusy &&
      currentAction.confidence >= agency.autoExecuteThreshold
    ) {
      handleApproveStep().catch(() => {})
    }
  }, [
    currentAction?.id,
    currentAction?.confidence,
    agency.autoExecuteThreshold,
    isStopped,
    isBusy
  ])

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

  const handleApproveAllAboveThreshold = async () => {
    const threshold =
      agency.autoExecuteThreshold > 0 ? agency.autoExecuteThreshold : 0.9
    const remainder = actions.slice(currentActionIndex)
    const toApprove = remainder.filter((a) => a.confidence >= threshold)
    if (toApprove.length === 0) {
      setStatusMessage("No actions above threshold.")
      return
    }
    let maxIdx = currentActionIndex - 1
    for (const action of toApprove) {
      if (isStopped) break
      const idx = actions.findIndex((a) => a.id === action.id)
      if (idx < 0) continue
      await withBusyState(async () => {
        addLog(setLogs, action.id, "approved", `Approved ${action.fieldLabel}`)
        try {
          const detail = executeAction(action)
          addLog(setLogs, action.id, "executed", detail)
          setStatusMessage(detail)
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Execution failed"
          addLog(setLogs, action.id, "failed", msg)
        }
      })
      maxIdx = Math.max(maxIdx, idx)
    }
    setCurrentActionIndex(maxIdx + 1)
    setStatusMessage(
      `Approved ${toApprove.length} actions above ${(threshold * 100).toFixed(0)}%.`
    )
  }

  if (!isWhitelisted) return null

  return (
    <div className="aa-root">
      {toast && (
        <div role="status" className="aa-toast">
          <div className="aa-toast-message">{toast.message}</div>
          <button
            className="aa-toast-view"
            onClick={() => {
              setActiveTab("run")
              setExpanded(true)
              setToast(null)
            }}>
            View
          </button>
          <div className="aa-toast-progress" />
        </div>
      )}

      {expanded && (
        <div className="aa-panel">
          <div className="aa-panel-header">
            <div>
              <p className="aa-title">FormFlow</p>
              <p className="aa-subtitle">Agentic form assistant</p>
            </div>
            <span className={`aa-badge aa-badge-${statusTone}`}>
              {isBusy ? "Busy" : "Ready"}
            </span>
          </div>

          <div className="aa-tabs">
            {(["run", "setup", "dev"] as const).map((tab) => (
              <button
                key={tab}
                className={`aa-tab ${activeTab === tab ? "is-active" : ""}`}
                onClick={() => setActiveTab(tab)}>
                {tab}
              </button>
            ))}
          </div>

          <div className="aa-body">
            {activeTab === "setup" && (
              <div className="aa-stack">
                <section className="aa-card">
                  <div className="aa-section-title">Model</div>
                  {curatedModels.length > 0 && (
                    <label className="aa-field">
                      <span className="aa-field-label">Preferred model</span>
                      <select
                        className="aa-input"
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
                  <p className="aa-model-status">{modelStatusMessage}</p>
                  <button className="aa-btn aa-btn-secondary" onClick={handleWarmupModel} disabled={isBusy}>
                    Prewarm WebLLM
                  </button>
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Profile</div>
                  <button
                    className={`aa-btn aa-btn-secondary ${savedFlash.profile ? "is-saved" : ""}`}
                    onClick={() => setShowProfileModal(true)}>
                    Edit profile
                  </button>
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Resume</div>
                  <textarea
                    className="aa-textarea"
                    value={resumeText}
                    onChange={(e) => setResumeText(e.target.value)}
                    placeholder="Paste resume text"
                  />
                  <input
                    className="aa-file"
                    type="file"
                    accept=".txt,.md,.text"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) handleResumeFile(f).catch(console.error)
                    }}
                  />
                  <div className="aa-row">
                    <button
                      className={`aa-btn aa-btn-secondary ${savedFlash.resume ? "is-saved" : ""}`}
                      onClick={handleSaveResume}
                      disabled={isBusy}>
                      Save resume
                    </button>
                  </div>
                  {resumeHighlights.length > 0 && (
                    <ul className="aa-list">
                      {resumeHighlights.slice(0, 4).map((line, i) => (
                        <li key={`${line}-${i}`}>{line}</li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Agency</div>
                  <label className="aa-toggle-row">
                    <span>
                      <span className="aa-toggle-title">Auto capture form</span>
                      <span className="aa-toggle-description">
                        Continuously detect fillable forms while browsing.
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`aa-toggle ${agency.autoCapture ? "is-on" : ""}`}
                      onClick={() =>
                        setAgency((prev) => ({ ...prev, autoCapture: !prev.autoCapture }))
                      }
                      aria-pressed={agency.autoCapture}
                    />
                  </label>

                  <label className="aa-toggle-row">
                    <span>
                      <span className="aa-toggle-title">Auto-plan after capture</span>
                      <span className="aa-toggle-description">
                        Generate execution steps immediately after snapshot extraction.
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`aa-toggle ${agency.autoPlan ? "is-on" : ""}`}
                      onClick={() => setAgency((prev) => ({ ...prev, autoPlan: !prev.autoPlan }))}
                      aria-pressed={agency.autoPlan}
                    />
                  </label>

                  <label className="aa-toggle-row">
                    <span>
                      <span className="aa-toggle-title">Show capture toast</span>
                      <span className="aa-toggle-description">
                        Notify when auto-capture finds an active form.
                      </span>
                    </span>
                    <button
                      type="button"
                      className={`aa-toggle ${agency.showCaptureToast ? "is-on" : ""}`}
                      onClick={() =>
                        setAgency((prev) => ({
                          ...prev,
                          showCaptureToast: !prev.showCaptureToast
                        }))
                      }
                      aria-pressed={agency.showCaptureToast}
                    />
                  </label>

                  <label className="aa-field">
                    <span className="aa-field-label">Auto-execute threshold</span>
                    <div className="aa-segmented">
                      {[
                        ["0", "Off"],
                        ["0.8", "80%"],
                        ["0.9", "90%"],
                        ["0.95", "95%"],
                        ["1", "100%"]
                      ].map(([value, label]) => {
                        const numericValue = parseFloat(value)
                        const isActive =
                          (value === "0" && agency.autoExecuteThreshold === 0) ||
                          agency.autoExecuteThreshold === numericValue
                        return (
                          <button
                            key={value}
                            type="button"
                            className={`aa-segment ${isActive ? "is-active" : ""}`}
                            onClick={() =>
                              setAgency((prev) => ({
                                ...prev,
                                autoExecuteThreshold: isNaN(numericValue) ? 0 : numericValue
                              }))
                            }>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                  </label>

                  <button
                    className={`aa-btn aa-btn-secondary ${savedFlash.agency ? "is-saved" : ""}`}
                    onClick={handleSaveAgency}
                    disabled={isBusy}>
                    Save agency
                  </button>
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Domain whitelist</div>
                  <textarea
                    className="aa-textarea"
                    value={whitelistText}
                    onChange={(e) => setWhitelistText(e.target.value)}
                    placeholder="One hostname per line"
                  />
                  <button
                    className={`aa-btn aa-btn-secondary ${savedFlash.whitelist ? "is-saved" : ""}`}
                    onClick={handleSaveWhitelist}
                    disabled={isBusy}>
                    Save whitelist
                  </button>
                </section>
              </div>
            )}

            {activeTab === "run" && (
              <div className="aa-stack">
                <section className="aa-card">
                  <div className="aa-section-title">Action review</div>
                  {currentAction ? (
                    <div className="aa-action-card">
                      <div className="aa-progress-track">
                        <div className="aa-progress-fill" style={{ width: `${stepProgress}%` }} />
                      </div>
                      <div className="aa-action-top">
                        <div>
                          <p className="aa-action-label">{currentAction.fieldLabel}</p>
                          <p className="aa-action-step">
                            Step {currentStep} of {Math.max(actions.length, 1)}
                          </p>
                        </div>
                        <span className={`aa-badge aa-badge-action aa-badge-${currentAction.type}`}>
                          {currentAction.type}
                        </span>
                      </div>

                      <div className="aa-confidence-wrap">
                        <div className="aa-confidence-head">
                          <span>Confidence</span>
                          <span>{(currentAction.confidence * 100).toFixed(0)}%</span>
                        </div>
                        <div className="aa-confidence-track">
                          <div
                            className={`aa-confidence-fill ${
                              currentAction.confidence >= 0.9
                                ? "high"
                                : currentAction.confidence >= 0.7
                                  ? "mid"
                                  : "low"
                            }`}
                            style={{
                              width: `${Math.max(
                                0,
                                Math.min(100, currentAction.confidence * 100)
                              )}%`
                            }}
                          />
                        </div>
                      </div>

                      <p className="aa-reasoning">{currentAction.reasoning}</p>
                      <label className="aa-field">
                        <span className="aa-field-label">
                          Value
                          {editableActionValue !== currentAction.value && (
                            <span className="aa-edited">Edited</span>
                          )}
                        </span>
                        <input
                          className="aa-input"
                          value={editableActionValue}
                          onChange={(e) => setEditableActionValue(e.target.value)}
                        />
                      </label>

                      <div className="aa-approve-row">
                        <button
                          className="aa-btn aa-btn-approve"
                          onClick={handleApproveStep}
                          disabled={isBusy || !currentAction || isStopped}>
                          Approve & next
                        </button>
                        <button
                          className="aa-btn aa-btn-secondary"
                          onClick={handleSkipStep}
                          disabled={isBusy || !currentAction}>
                          Skip
                        </button>
                        <button
                          className="aa-btn aa-btn-danger aa-btn-sm"
                          onClick={handleStop}
                          disabled={!currentAction}
                          title="Stop execution">
                          Stop
                        </button>
                      </div>
                      <div className="aa-approve-links">
                        <button
                          className="aa-link"
                          onClick={handleApproveAllAboveThreshold}
                          disabled={isBusy || actions.length === 0 || isStopped}>
                          Approve all above{" "}
                          {agency.autoExecuteThreshold > 0
                            ? (agency.autoExecuteThreshold * 100).toFixed(0)
                            : 90}
                          %
                        </button>
                        <span className="aa-link-sep">·</span>
                        <button className="aa-link aa-link-muted" onClick={handleResetQueue}>
                          Reset queue
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="aa-empty">Capture and plan below to begin approvals.</p>
                  )}
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Run flow</div>
                  <div className="aa-stepper">
                    <button
                      className={`aa-step ${snapshot ? "is-done" : ""}`}
                      onClick={handleExtractForm}
                      disabled={isBusy}>
                      <span className="aa-step-index">{snapshot ? "ok" : "1"}</span>
                      <span>Capture</span>
                    </button>
                    <div className={`aa-step-line ${snapshot ? "is-active" : ""}`} />
                    <button
                      className={`aa-step ${actions.length > 0 ? "is-done" : ""}`}
                      onClick={handlePlanActions}
                      disabled={isBusy || !snapshot}>
                      <span className="aa-step-index">{actions.length > 0 ? "ok" : "2"}</span>
                      <span>Plan</span>
                    </button>
                  </div>

                  <p className={`aa-meta aa-planner planner-${planningSource}`}>
                    Planner: {planningSource}
                  </p>
                  <p className="aa-meta">Queue: {getQueueLabel(actions, currentActionIndex)}</p>
                </section>
              </div>
            )}

            {activeTab === "dev" && (
              <div className="aa-stack">
                <section className="aa-card">
                  <div className="aa-card-head">
                    <div className="aa-section-title">Execution log</div>
                    <div className="aa-row aa-row-tight">
                      <button
                        className="aa-btn aa-btn-secondary"
                        onClick={async () => {
                          const logText = logs
                            .map(
                              (log) =>
                                `[${new Date(log.timestamp).toISOString()}] ${log.status}: ${log.detail}`
                            )
                            .join("\n")
                          try {
                            await navigator.clipboard.writeText(logText)
                            setStatusMessage("Copied log to clipboard.")
                          } catch {
                            setStatusMessage("Clipboard permission denied.")
                          }
                        }}
                        disabled={logs.length === 0}>
                        Copy all
                      </button>
                      <button
                        className="aa-btn aa-btn-secondary"
                        onClick={() => setLogs([])}
                        disabled={logs.length === 0}>
                        Clear
                      </button>
                    </div>
                  </div>

                  {logs.length === 0 ? (
                    <p className="aa-empty">No actions yet.</p>
                  ) : (
                    <div className="aa-log-list">
                      {logs.map((log) => (
                        <div className="aa-log-item" key={log.id}>
                          <span className={`aa-badge aa-badge-log aa-log-${log.status}`}>
                            {log.status}
                          </span>
                          <span className="aa-log-time">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className="aa-log-detail">{log.detail}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Diagnostics</div>
                  <div className="aa-diagnostics">
                    <p>
                      <span
                        className={`aa-dot ${
                          modelStatusMessage.startsWith("ready")
                            ? "ready"
                            : modelStatusMessage.startsWith("loading")
                              ? "loading"
                              : /rule-based/i.test(modelStatusMessage)
                                ? "ready"
                                : "idle"
                        }`}
                      />
                      Model: {modelStatusMessage}
                    </p>
                    <p>Planner: {planningSource}</p>
                    <p>Queue: {getQueueLabel(actions, currentActionIndex)}</p>
                    <p>URL: {snapshot?.url ?? window.location.href}</p>
                    <p>
                      Snapshot fields: {snapshot?.fields.length ?? 0} (filled{" "}
                      {snapshot
                        ? snapshot.fields.filter((field) => hasMeaningfulValue(field)).length
                        : 0}
                      , empty{" "}
                      {snapshot
                        ? snapshot.fields.filter((field) => !hasMeaningfulValue(field)).length
                        : 0}
                      )
                    </p>
                  </div>
                </section>

                <section className="aa-card">
                  <div className="aa-section-title">Manual controls</div>
                  <div className="aa-row">
                    <button className="aa-btn aa-btn-secondary" onClick={handleExtractForm} disabled={isBusy}>
                      Capture form
                    </button>
                    <button
                      className="aa-btn aa-btn-secondary"
                      onClick={handlePlanActions}
                      disabled={isBusy || !snapshot}>
                      Re-plan
                    </button>
                  </div>
                  <details className="aa-raw-json">
                    <summary>Raw snapshot</summary>
                    <pre>{JSON.stringify(snapshot, null, 2)}</pre>
                  </details>
                </section>
              </div>
            )}
          </div>

          <p className="aa-status" title={statusMessage}>
            <span className={`aa-dot ${statusTone}`} />
            <span>{statusMessage}</span>
          </p>
        </div>
      )}

      <button
        onClick={() => setExpanded((e) => !e)}
        className={`aa-fab ${expanded ? "is-open" : ""} ${pendingActions > 0 ? "has-pending" : ""}`}
        aria-label={expanded ? "Close agent panel" : "Open agent panel"}>
        <span className="aa-fab-icon">{expanded ? "X" : "AI"}</span>
        {pendingActions > 0 && <span className="aa-fab-badge">{pendingActions}</span>}
      </button>

      {showProfileModal && (
        <div className="aa-modal-overlay" onClick={() => setShowProfileModal(false)}>
          <div className="aa-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="aa-modal-title">Edit profile</h3>

            <section className="aa-modal-group">
              <h4>Personal</h4>
              {profileField(profile, "fullName", setProfile, "Full name")}
              {profileField(profile, "currentTitle", setProfile, "Title")}
              {profileField(profile, "yearsExperience", setProfile, "Years experience")}
            </section>

            <section className="aa-modal-group">
              <h4>Contact</h4>
              {profileField(profile, "email", setProfile, "Email")}
              {profileField(profile, "phone", setProfile, "Phone")}
              {profileField(profile, "streetAddress", setProfile, "Street address")}
              <div className="aa-grid-2">
                {profileField(profile, "city", setProfile, "City")}
                {profileField(profile, "state", setProfile, "State")}
              </div>
              <div className="aa-grid-2">
                {profileField(profile, "zipCode", setProfile, "Zip code")}
                {profileField(profile, "country", setProfile, "Country")}
              </div>
            </section>

            <section className="aa-modal-group">
              <h4>Professional</h4>
              {profileField(profile, "workAuthorization", setProfile, "Work authorization")}
              {profileField(profile, "needsSponsorship", setProfile, "Needs sponsorship")}
            </section>

            <section className="aa-modal-group">
              <h4>Links</h4>
              {profileField(profile, "linkedin", setProfile, "LinkedIn")}
              {profileField(profile, "github", setProfile, "GitHub")}
              {profileField(profile, "portfolio", setProfile, "Portfolio")}
            </section>

            <label className="aa-field">
              <span className="aa-field-label">Summary</span>
              <textarea
                className="aa-textarea"
                value={profile.summary}
                onChange={(e) =>
                  setProfile((prev) => ({ ...prev, summary: e.target.value }))
                }
              />
            </label>

            <div className="aa-row">
              <button
                className={`aa-btn aa-btn-approve ${savedFlash.profile ? "is-saved" : ""}`}
                onClick={handleSaveProfile}
                disabled={isBusy}>
                Save profile
              </button>
              <button className="aa-btn aa-btn-secondary" onClick={() => setShowProfileModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const getStyle = () => {
  const style = document.createElement("style")
  style.textContent = `
    .aa-root, .aa-root * {
      box-sizing: border-box;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .aa-root {
      --aa-primary: #4f46e5;
      --aa-primary-2: #7c3aed;
      --aa-primary-light: #eef2ff;
      --aa-success: #10b981;
      --aa-warning: #f59e0b;
      --aa-danger: #f43f5e;
      --aa-text: #0f172a;
      --aa-muted: #64748b;
      --aa-surface: rgba(255, 255, 255, 0.74);
      --aa-surface-strong: rgba(255, 255, 255, 0.9);
      font-size: 12px;
      line-height: 1.4;
      color: var(--aa-text);
    }

    .aa-fab {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 54px;
      height: 54px;
      border: none;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--aa-primary), var(--aa-primary-2));
      color: #fff;
      box-shadow: 0 12px 30px rgba(79, 70, 229, 0.45);
      cursor: pointer;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.16s ease, box-shadow 0.2s ease;
    }

    .aa-fab:hover { transform: scale(1.05); }
    .aa-fab.is-open .aa-fab-icon { transform: rotate(180deg); }
    .aa-fab-icon { transition: transform 0.2s ease; font-size: 14px; font-weight: 700; letter-spacing: 0.4px; }
    .aa-fab.has-pending::before {
      content: "";
      position: absolute;
      inset: -7px;
      border: 2px solid rgba(99, 102, 241, 0.45);
      border-radius: 999px;
      animation: aa-pulse 1.8s infinite ease-out;
    }

    .aa-fab-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      min-width: 18px;
      height: 18px;
      border-radius: 99px;
      background: #111827;
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      padding: 0 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.65);
    }

    .aa-panel {
      position: fixed;
      right: 16px;
      bottom: 78px;
      width: 360px;
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.5);
      background: var(--aa-surface);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 14px 44px rgba(15, 23, 42, 0.24), 0 3px 10px rgba(15, 23, 42, 0.14);
      overflow: hidden;
      z-index: 2147483646;
      animation: aa-slide-up 0.25s ease-out;
    }

    .aa-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 12px 8px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      background: linear-gradient(180deg, rgba(238,242,255,0.9), rgba(255,255,255,0.35));
    }

    .aa-title { margin: 0; font-size: 13px; font-weight: 700; }
    .aa-subtitle { margin: 2px 0 0; color: var(--aa-muted); font-size: 11px; }
    .aa-model-status { margin: 6px 0 8px; color: #475569; font-size: 11px; }

    .aa-tabs {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      margin: 8px 10px 0;
      padding: 4px;
      border-radius: 999px;
      background: rgba(241, 245, 249, 0.9);
    }

    .aa-tab {
      border: none;
      background: transparent;
      color: #475569;
      border-radius: 999px;
      text-transform: capitalize;
      font-size: 12px;
      padding: 6px 0;
      cursor: pointer;
      transition: all 0.16s ease;
    }
    .aa-tab.is-active {
      background: linear-gradient(135deg, var(--aa-primary), var(--aa-primary-2));
      color: #fff;
      box-shadow: 0 6px 14px rgba(79,70,229,0.35);
    }

    .aa-body {
      flex: 1;
      overflow: auto;
      padding: 10px;
      animation: aa-fade-in 0.25s ease;
    }
    .aa-stack { display: grid; gap: 10px; }
    .aa-card {
      background: var(--aa-surface-strong);
      border: 1px solid rgba(226, 232, 240, 0.95);
      border-radius: 10px;
      padding: 10px;
      box-shadow: 0 6px 20px rgba(15,23,42,0.08);
    }
    .aa-card-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .aa-section-title { font-size: 12px; font-weight: 700; margin-bottom: 8px; color: #0f172a; }

    .aa-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .aa-row-tight { margin-top: 6px; }
    .aa-approve-row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .aa-approve-row .aa-btn-approve { flex: 1; min-width: 100px; }
    .aa-approve-links {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .aa-link-sep { color: #cbd5e1; font-size: 10px; }
    .aa-btn-sm { padding: 5px 10px; font-size: 10px; }

    .aa-input, .aa-textarea, .aa-file {
      width: 100%;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      padding: 7px 9px;
      font-size: 12px;
      color: #0f172a;
      background: #fff;
      transition: border-color .16s ease, box-shadow .16s ease;
    }
    .aa-input:focus, .aa-textarea:focus {
      outline: none;
      border-color: #818cf8;
      box-shadow: 0 0 0 3px rgba(129,140,248,0.18);
    }
    .aa-textarea { min-height: 72px; resize: vertical; }
    .aa-file { padding: 6px; margin-top: 6px; }

    .aa-field { display: block; margin-bottom: 8px; }
    .aa-field-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: #334155;
      margin-bottom: 4px;
      font-weight: 600;
    }
    .aa-edited {
      background: #dbeafe;
      color: #1d4ed8;
      border-radius: 999px;
      padding: 1px 6px;
      font-size: 10px;
      font-weight: 700;
    }

    .aa-btn {
      border: 1px solid transparent;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.16s ease;
      padding: 7px 10px;
    }
    .aa-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .aa-btn-secondary {
      background: #f8fafc;
      border-color: #cbd5e1;
      color: #1e293b;
    }
    .aa-btn-secondary:hover:not(:disabled) {
      background: #eef2ff;
      border-color: #a5b4fc;
    }
    .aa-btn-approve {
      width: 100%;
      color: #fff;
      border: none;
      background: linear-gradient(135deg, #059669, #10b981);
      box-shadow: 0 8px 16px rgba(16,185,129,0.35);
    }
    .aa-btn-approve:hover:not(:disabled) { transform: translateY(-1px); }
    .aa-btn-danger {
      background: #fff1f2;
      border-color: #fecdd3;
      color: #be123c;
      flex: 1;
    }
    .aa-btn-danger:hover:not(:disabled) { background: #ffe4e6; }
    .aa-btn.is-saved {
      background: #ecfdf5;
      border-color: #6ee7b7;
      color: #047857;
    }

    .aa-link {
      border: none;
      background: transparent;
      color: var(--aa-primary);
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      padding: 4px 0;
      text-align: left;
    }
    .aa-link:disabled { opacity: 0.5; cursor: not-allowed; }
    .aa-link-muted { color: #64748b; }

    .aa-badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 8px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      border: 1px solid transparent;
    }
    .aa-badge-ready { background: #ecfdf5; color: #047857; border-color: #6ee7b7; }
    .aa-badge-busy { background: #fffbeb; color: #b45309; border-color: #fcd34d; }
    .aa-badge-error { background: #fff1f2; color: #be123c; border-color: #fda4af; }
    .aa-badge-action { text-transform: none; font-size: 10px; }
    .aa-badge-setValue { background: #e0e7ff; color: #3730a3; border-color: #a5b4fc; }
    .aa-badge-clickNext { background: #fef3c7; color: #92400e; border-color: #fcd34d; }
    .aa-badge-selectOption { background: #ede9fe; color: #5b21b6; border-color: #c4b5fd; }

    .aa-stepper { display: flex; align-items: center; gap: 7px; }
    .aa-step {
      border: 1px solid #cbd5e1;
      background: #fff;
      border-radius: 9px;
      padding: 7px 9px;
      display: flex;
      align-items: center;
      gap: 7px;
      color: #334155;
      font-size: 11px;
      cursor: pointer;
      flex: 1;
      min-width: 0;
    }
    .aa-step.is-done {
      border-color: #34d399;
      background: #ecfdf5;
      color: #065f46;
    }
    .aa-step:disabled { opacity: 0.55; cursor: not-allowed; }
    .aa-step-index {
      width: 18px;
      height: 18px;
      border-radius: 99px;
      border: 1px solid #cbd5e1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 10px;
      background: #fff;
      flex-shrink: 0;
    }
    .aa-step-line {
      width: 14px;
      height: 2px;
      border-radius: 99px;
      background: #cbd5e1;
      flex-shrink: 0;
    }
    .aa-step-line.is-active { background: #34d399; }

    .aa-meta { margin: 7px 0 0; color: #475569; font-size: 11px; }
    .aa-planner.planner-hybrid { color: #047857; }
    .aa-planner.planner-rule-based { color: #b45309; }

    .aa-action-card {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px;
      background: #fff;
      position: relative;
      overflow: hidden;
    }
    .aa-progress-track { height: 3px; border-radius: 999px; background: #e2e8f0; margin-bottom: 8px; }
    .aa-progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #4f46e5, #8b5cf6);
      transition: width 0.18s ease;
    }
    .aa-action-top { display: flex; justify-content: space-between; gap: 10px; align-items: start; margin-bottom: 8px; }
    .aa-action-label { margin: 0; font-size: 12px; font-weight: 700; }
    .aa-action-step { margin: 2px 0 0; font-size: 10px; color: #64748b; }

    .aa-confidence-wrap { margin-bottom: 8px; }
    .aa-confidence-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 10px; color: #475569; }
    .aa-confidence-track { height: 7px; border-radius: 999px; background: #e2e8f0; overflow: hidden; }
    .aa-confidence-fill { height: 100%; border-radius: inherit; }
    .aa-confidence-fill.high { background: linear-gradient(90deg, #22c55e, #16a34a); }
    .aa-confidence-fill.mid { background: linear-gradient(90deg, #f59e0b, #d97706); }
    .aa-confidence-fill.low { background: linear-gradient(90deg, #fb7185, #e11d48); }
    .aa-reasoning {
      margin: 0 0 8px;
      color: #475569;
      font-size: 11px;
      background: #f8fafc;
      border-radius: 8px;
      padding: 7px;
    }

    .aa-empty { margin: 0; color: #64748b; font-size: 11px; }

    .aa-segmented {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 3px;
      background: #f8fafc;
    }
    .aa-segment {
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #334155;
      font-size: 10px;
      padding: 5px 0;
      cursor: pointer;
    }
    .aa-segment.is-active {
      background: #e0e7ff;
      color: #3730a3;
      font-weight: 700;
    }

    .aa-toggle-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .aa-toggle-title { display: block; font-size: 11px; font-weight: 600; }
    .aa-toggle-description { display: block; font-size: 10px; color: #64748b; margin-top: 2px; }
    .aa-toggle {
      width: 40px;
      height: 22px;
      border: 1px solid #cbd5e1;
      border-radius: 99px;
      background: #e2e8f0;
      position: relative;
      cursor: pointer;
      flex-shrink: 0;
      transition: background 0.16s ease;
    }
    .aa-toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.2);
      transition: transform 0.16s ease;
    }
    .aa-toggle.is-on { background: linear-gradient(135deg, #4f46e5, #7c3aed); border-color: transparent; }
    .aa-toggle.is-on::after { transform: translateX(18px); }

    .aa-list {
      margin: 8px 0 0;
      padding-left: 16px;
      color: #475569;
      font-size: 11px;
    }

    .aa-log-list {
      margin-top: 8px;
      max-height: 190px;
      overflow: auto;
      display: grid;
      gap: 6px;
    }
    .aa-log-item {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 6px;
      align-items: center;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 6px 7px;
      background: #fff;
    }
    .aa-badge-log { text-transform: none; font-size: 10px; padding: 2px 6px; }
    .aa-log-executed { background: #ecfdf5; color: #047857; border-color: #6ee7b7; }
    .aa-log-failed { background: #fff1f2; color: #be123c; border-color: #fda4af; }
    .aa-log-skipped { background: #f1f5f9; color: #334155; border-color: #cbd5e1; }
    .aa-log-edited { background: #dbeafe; color: #1d4ed8; border-color: #93c5fd; }
    .aa-log-stopped { background: #ffedd5; color: #c2410c; border-color: #fdba74; }
    .aa-log-approved { background: #e0e7ff; color: #3730a3; border-color: #a5b4fc; }
    .aa-log-time {
      color: #64748b;
      font-size: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      white-space: nowrap;
    }
    .aa-log-detail { color: #0f172a; font-size: 11px; }

    .aa-diagnostics p { margin: 0 0 5px; color: #475569; font-size: 11px; }

    .aa-raw-json {
      margin-top: 8px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 6px 8px;
      background: #f8fafc;
    }
    .aa-raw-json summary { cursor: pointer; font-size: 11px; color: #334155; font-weight: 600; }
    .aa-raw-json pre {
      margin: 8px 0 0;
      max-height: 180px;
      overflow: auto;
      padding: 8px;
      border-radius: 8px;
      background: #0f172a;
      color: #cbd5e1;
      font-size: 10px;
      line-height: 1.35;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    .aa-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      display: inline-block;
      margin-right: 6px;
      background: #94a3b8;
      vertical-align: middle;
    }
    .aa-dot.ready { background: #10b981; }
    .aa-dot.busy, .aa-dot.loading { background: #f59e0b; }
    .aa-dot.error { background: #f43f5e; }
    .aa-dot.idle { background: #94a3b8; }

    .aa-status {
      margin: 0;
      border-top: 1px solid rgba(148,163,184,0.2);
      color: #475569;
      font-size: 11px;
      padding: 8px 10px;
      background: rgba(248,250,252,0.75);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .aa-toast {
      position: fixed;
      bottom: 80px;
      left: 16px;
      right: 16px;
      max-width: 360px;
      border-radius: 12px;
      border: 1px solid rgba(129,140,248,0.35);
      background: rgba(15,23,42,0.92);
      color: #fff;
      padding: 10px 10px 14px;
      box-shadow: 0 12px 28px rgba(2,6,23,0.35);
      z-index: 2147483645;
      animation: aa-slide-up 0.2s ease-out;
      overflow: hidden;
    }
    .aa-toast::before {
      content: "";
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      background: linear-gradient(180deg, #818cf8, #7c3aed);
    }
    .aa-toast-message { margin-right: 68px; font-size: 12px; }
    .aa-toast-view {
      position: absolute;
      right: 10px;
      top: 9px;
      border: none;
      border-radius: 999px;
      background: rgba(129,140,248,0.25);
      color: #fff;
      font-size: 11px;
      padding: 4px 9px;
      cursor: pointer;
    }
    .aa-toast-progress {
      position: absolute;
      left: 0;
      bottom: 0;
      height: 2px;
      width: 100%;
      background: linear-gradient(90deg, #818cf8, #a855f7);
      transform-origin: left;
      animation: aa-shrink 4s linear forwards;
    }

    .aa-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483648;
      background: rgba(2, 6, 23, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
    }
    .aa-modal {
      width: min(560px, 100%);
      max-height: 88vh;
      overflow: auto;
      border-radius: 14px;
      background: rgba(255,255,255,0.96);
      border: 1px solid rgba(226,232,240,0.9);
      box-shadow: 0 20px 40px rgba(15,23,42,0.24);
      padding: 14px;
      animation: aa-fade-in 0.2s ease-out;
    }
    .aa-modal-title { margin: 0 0 10px; font-size: 16px; }
    .aa-modal-group {
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      background: #fff;
      padding: 10px;
      margin-bottom: 10px;
    }
    .aa-modal-group h4 {
      margin: 0 0 8px;
      font-size: 12px;
      color: #334155;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .aa-grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }

    @keyframes aa-slide-up {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes aa-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes aa-pulse {
      0% { transform: scale(0.96); opacity: 1; }
      100% { transform: scale(1.2); opacity: 0; }
    }
    @keyframes aa-shrink {
      from { transform: scaleX(1); }
      to { transform: scaleX(0); }
    }
  `
  return style
}

export default FloatingMenu
