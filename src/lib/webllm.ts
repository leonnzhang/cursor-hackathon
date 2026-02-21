import {
  CreateMLCEngine,
  prebuiltAppConfig,
  type InitProgressReport,
  type MLCEngine,
  type ResponseFormat
} from "@mlc-ai/web-llm"

type LlmStatus =
  | { state: "idle"; detail: string; progress: number; modelId: string }
  | { state: "loading"; detail: string; progress: number; modelId: string }
  | { state: "ready"; detail: string; progress: number; modelId: string }
  | { state: "error"; detail: string; progress: number; modelId: string }

export interface CuratedModel {
  id: string
  label: string
}

const MODEL_HINTS: Array<{ hint: string; label: string }> = [
  { hint: "smollm2-360m", label: "SmolLM2 360M (fastest)" },
  { hint: "smollm2-1.7b", label: "SmolLM2 1.7B" },
  { hint: "qwen2.5-1.5b", label: "Qwen 2.5 1.5B" },
  { hint: "qwen2.5-0.5b", label: "Qwen 2.5 0.5B" },
]

export const getCuratedModels = (): CuratedModel[] => {
  const allModels = prebuiltAppConfig.model_list.map((m) => m.model_id)
  const lower = new Map(allModels.map((id) => [id.toLowerCase(), id] as const))
  const result: CuratedModel[] = []
  for (const { hint, label } of MODEL_HINTS) {
    const match = Array.from(lower.keys()).find((k) => k.includes(hint))
    if (match) {
      result.push({ id: lower.get(match)!, label })
    }
  }
  return result
}

let engine: MLCEngine | null = null
let pendingLoad: Promise<MLCEngine> | null = null
let currentModelId = ""
let userModelOverride: string | null = null

let status: LlmStatus = {
  state: "idle",
  detail: "Not loaded",
  progress: 0,
  modelId: ""
}

export const setPreferredModel = (modelId: string) => {
  if (engine && currentModelId !== modelId) {
    engine = null
    pendingLoad = null
    status = { state: "idle", detail: "Model changed, needs reload", progress: 0, modelId: "" }
  }
  userModelOverride = modelId
}

const chooseModelId = () => {
  const allModels = prebuiltAppConfig.model_list.map((model) => model.model_id)

  if (userModelOverride && allModels.includes(userModelOverride)) {
    return userModelOverride
  }

  const lowerToOriginal = new Map(
    allModels.map((modelId) => [modelId.toLowerCase(), modelId] as const)
  )

  for (const { hint } of MODEL_HINTS) {
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

export const isModelReady = () => status.state === "ready" && engine !== null

const updateStatusFromProgress = (modelId: string, report: InitProgressReport) => {
  status = {
    state: "loading",
    detail: report.text,
    progress: Math.min(Math.max(report.progress, 0), 1),
    modelId
  }
}

// #region agent log
const _dbgLog = (msg: string, data: Record<string, unknown>, hypId: string) => {
  fetch('http://127.0.0.1:7444/ingest/5febb908-5112-4db3-9ca9-07c57ed4c177',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a40af4'},body:JSON.stringify({sessionId:'a40af4',location:'webllm.ts:warmupWebLlm',message:msg,data,hypothesisId:hypId,timestamp:Date.now()})}).catch(()=>{});
};
// #endregion

export const warmupWebLlm = async (
  onProgress?: (report: InitProgressReport) => void
) => {
  // #region agent log
  _dbgLog("warmupWebLlm entry", {
    hasGpu: "gpu" in navigator,
    location: typeof location !== "undefined" ? location?.href : "no location",
    isExtensionContext: typeof chrome !== "undefined" && !!chrome?.runtime?.id
  }, "H1");
  try {
    const testCanvas = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(1, 1)
      : document.createElement("canvas");
    const ctx = testCanvas.getContext?.("webgpu");
    _dbgLog("canvas getContext(webgpu) test", {
      canvasType: typeof OffscreenCanvas !== "undefined" ? "OffscreenCanvas" : "HTMLCanvasElement",
      ctxIsNull: ctx === null,
      ctxType: ctx ? typeof ctx : "null"
    }, "H1");
  } catch (e) {
    _dbgLog("canvas test threw", { err: String(e) }, "H1");
  }
  // #endregion

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

  // #region agent log
  _dbgLog("calling CreateMLCEngine", { modelId }, "H3");
  // #endregion

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
      // #region agent log
      _dbgLog("CreateMLCEngine failed", {
        errMsg: error instanceof Error ? error.message : String(error),
        errName: error instanceof Error ? error.name : "unknown",
        stack: error instanceof Error ? error.stack : undefined,
        location: typeof location !== "undefined" ? location?.href : "no location"
      }, "H3");
      // #endregion
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

export const runWebLlmPrompt = async (
  systemPrompt: string,
  userPrompt: string,
  jsonSchema?: string
) => {
  const loadedEngine = await warmupWebLlm()

  const responseFormat: ResponseFormat | undefined = jsonSchema
    ? { type: "json_object", schema: jsonSchema } as ResponseFormat
    : undefined

  const completion = await loadedEngine.chat.completions.create({
    model: currentModelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 1500,
    response_format: responseFormat
  })

  const content = completion.choices?.[0]?.message?.content
  return normalizeAssistantText(content)
}

export const runWebLlmTextGeneration = async (
  systemPrompt: string,
  userPrompt: string
) => {
  const loadedEngine = await warmupWebLlm()

  const completion = await loadedEngine.chat.completions.create({
    model: currentModelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.5,
    max_tokens: 2000
  })

  const content = completion.choices?.[0]?.message?.content
  return normalizeAssistantText(content)
}
