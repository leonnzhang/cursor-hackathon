import {
  CreateMLCEngine,
  prebuiltAppConfig,
  type InitProgressReport,
  type MLCEngine
} from "@mlc-ai/web-llm"

type LlmStatus =
  | { state: "idle"; detail: string; progress: number; modelId: string }
  | { state: "loading"; detail: string; progress: number; modelId: string }
  | { state: "ready"; detail: string; progress: number; modelId: string }
  | { state: "error"; detail: string; progress: number; modelId: string }

const PREFERRED_MODEL_HINTS = [
  "smollm2-360m",
  "smollm2"
]

let engine: MLCEngine | null = null
let pendingLoad: Promise<MLCEngine> | null = null
let currentModelId = ""

let status: LlmStatus = {
  state: "idle",
  detail: "Not loaded",
  progress: 0,
  modelId: ""
}

const chooseModelId = () => {
  const allModels = prebuiltAppConfig.model_list.map((model) => model.model_id)
  const lowerToOriginal = new Map(
    allModels.map((modelId) => [modelId.toLowerCase(), modelId] as const)
  )

  for (const hint of PREFERRED_MODEL_HINTS) {
    const match = Array.from(lowerToOriginal.keys()).find((modelId) =>
      modelId.includes(hint)
    )
    if (match) {
      return lowerToOriginal.get(match) ?? allModels[0]
    }
  }

  const lowResourceModel = prebuiltAppConfig.model_list.find(
    (model) => model.low_resource_required
  )
  if (lowResourceModel) {
    return lowResourceModel.model_id
  }

  return allModels[0]
}

export const getWebLlmStatus = () => status

const updateStatusFromProgress = (modelId: string, report: InitProgressReport) => {
  status = {
    state: "loading",
    detail: report.text,
    progress: Math.min(Math.max(report.progress, 0), 1),
    modelId
  }
}

export const warmupWebLlm = async (
  onProgress?: (report: InitProgressReport) => void
) => {
  if (!("gpu" in navigator)) {
    status = {
      state: "error",
      detail: "WebGPU is not available in this browser",
      progress: 0,
      modelId: ""
    }
    throw new Error(status.detail)
  }

  if (engine) {
    return engine
  }

  if (pendingLoad) {
    return pendingLoad
  }

  const modelId = chooseModelId()
  currentModelId = modelId
  status = {
    state: "loading",
    detail: "Starting local model load",
    progress: 0,
    modelId
  }

  pendingLoad = CreateMLCEngine(modelId, {
    initProgressCallback: (report) => {
      updateStatusFromProgress(modelId, report)
      onProgress?.(report)
    }
  })
    .then((loadedEngine) => {
      engine = loadedEngine
      status = {
        state: "ready",
        detail: `Loaded ${modelId}`,
        progress: 1,
        modelId
      }
      pendingLoad = null
      return loadedEngine
    })
    .catch((error: unknown) => {
      pendingLoad = null
      status = {
        state: "error",
        detail:
          error instanceof Error ? error.message : "Failed to load local model",
        progress: 0,
        modelId
      }
      throw error
    })

  return pendingLoad
}

const normalizeAssistantText = (content: unknown) => {
  if (typeof content === "string") {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string" ? part : String((part as { text?: string }).text ?? "")
      )
      .join("\n")
  }
  return ""
}

export const runWebLlmPrompt = async (systemPrompt: string, userPrompt: string) => {
  const loadedEngine = await warmupWebLlm()
  const completion = await loadedEngine.chat.completions.create({
    model: currentModelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 700
  })

  const content = completion.choices?.[0]?.message?.content
  return normalizeAssistantText(content)
}
