import { z } from "zod"

import type { AgentContext, AgentAction, ExtractedField, FormSnapshot, PlanResult } from "~src/types/agent"
import { runWebLlmPrompt } from "~src/lib/webllm"
import { isGenerativeField, generateFieldContent } from "~src/lib/content-generator"

const llmActionSchema = z.object({
  selector: z.string().min(1),
  type: z.enum(["setValue", "setSelect", "setCheckbox", "setRadio", "clickNext"]),
  fieldLabel: z.string().default(""),
  value: z.string().default(""),
  reasoning: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.6)
})

const llmActionListSchema = z.array(llmActionSchema)

const FORM_FILL_TYPES = new Set<string>(["setValue", "setSelect", "setCheckbox", "setRadio"])

const sortActions = (actions: AgentAction[]): AgentAction[] =>
  [...actions].sort((a, b) => {
    const aIsFill = FORM_FILL_TYPES.has(a.type)
    const bIsFill = FORM_FILL_TYPES.has(b.type)
    if (aIsFill && !bIsFill) return -1
    if (!aIsFill && bIsFill) return 1
    return 0
  })

const PROFILE_HINTS: Array<{ key: keyof AgentContext["profile"]; hints: string[] }> = [
  { key: "fullName", hints: ["full name", "name", "legal name"] },
  { key: "email", hints: ["email"] },
  { key: "phone", hints: ["phone", "mobile", "telephone"] },
  { key: "city", hints: ["city", "town", "municipality"] },
  { key: "state", hints: ["state", "province", "region", "prefecture"] },
  { key: "country", hints: ["country", "nation"] },
  { key: "zipCode", hints: ["zip", "postal", "postcode", "zip code", "postal code"] },
  { key: "streetAddress", hints: ["street", "address line", "address 1", "mailing address"] },
  { key: "linkedin", hints: ["linkedin"] },
  { key: "github", hints: ["github"] },
  { key: "portfolio", hints: ["portfolio", "website", "personal site"] },
  { key: "currentTitle", hints: ["title", "current role", "position"] },
  { key: "yearsExperience", hints: ["years", "experience"] },
  { key: "workAuthorization", hints: ["work authorization", "authorized", "visa"] },
  { key: "needsSponsorship", hints: ["sponsorship", "sponsor"] }
]

const composeLocationString = (profile: AgentContext["profile"]) =>
  [profile.city, profile.state, profile.country].filter(Boolean).join(", ")

const normalize = (value: string) => value.trim().toLowerCase()

const extractLikelyJson = (raw: string) => {
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const firstBracket = raw.indexOf("[")
  const lastBracket = raw.lastIndexOf("]")
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return raw.slice(firstBracket, lastBracket + 1)
  }
  return raw
}

const repairJson = (raw: string): string => {
  let text = raw.trim()
  text = text.replace(/,\s*([}\]])/g, "$1")
  if (text.startsWith("[") && !text.endsWith("]")) {
    const openCount = (text.match(/\[/g) ?? []).length
    const closeCount = (text.match(/]/g) ?? []).length
    text += "]".repeat(openCount - closeCount)
  }
  if (text.startsWith("{") && !text.endsWith("}")) {
    text = "[" + text + "}]"
  }
  text = text.replace(/'/g, '"')
  text = text.replace(/(\w+)\s*:/g, (_match, key: string) => `"${key}":`)
  return text
}

const wrappedSchema = z.object({ actions: llmActionListSchema })

const tryParseActions = (raw: string): z.infer<typeof llmActionSchema>[] | null => {
  const extracted = extractLikelyJson(raw)
  for (const candidate of [extracted, repairJson(extracted), repairJson(raw)]) {
    try {
      const parsed = JSON.parse(candidate)

      // Structured output wraps in { actions: [...] }
      const wrapped = wrappedSchema.safeParse(parsed)
      if (wrapped.success && wrapped.data.actions.length > 0) return wrapped.data.actions

      // Direct array format (legacy / retry)
      const direct = llmActionListSchema.safeParse(parsed)
      if (direct.success && direct.data.length > 0) return direct.data
    } catch { /* try next candidate */ }
  }

  const objectPattern = /\{[^{}]*"selector"\s*:\s*"[^"]+?"[^{}]*\}/g
  const objects = raw.match(objectPattern)
  if (objects && objects.length > 0) {
    const partial: z.infer<typeof llmActionSchema>[] = []
    for (const obj of objects) {
      try {
        const result = llmActionSchema.safeParse(JSON.parse(obj))
        if (result.success) partial.push(result.data)
      } catch { /* skip malformed individual object */ }
    }
    if (partial.length > 0) return partial
  }

  return null
}

const COUNTRY_ALIASES: Record<string, string[]> = {
  "united states": ["us", "usa", "u.s.", "u.s.a.", "united states of america", "america"],
  "united kingdom": ["uk", "u.k.", "great britain", "gb", "england"],
  "canada": ["ca", "can"],
  "australia": ["au", "aus"],
  "germany": ["de", "deutschland"],
  "france": ["fr"],
  "india": ["in"],
  "china": ["cn", "prc"],
  "japan": ["jp", "jpn"],
  "south korea": ["kr", "korea"],
  "brazil": ["br"],
  "mexico": ["mx"]
}

const jaroWinkler = (a: string, b: string): number => {
  if (a === b) return 1
  const aLen = a.length
  const bLen = b.length
  if (aLen === 0 || bLen === 0) return 0

  const matchWindow = Math.max(Math.floor(Math.max(aLen, bLen) / 2) - 1, 0)
  const aMatches = new Array<boolean>(aLen).fill(false)
  const bMatches = new Array<boolean>(bLen).fill(false)

  let matches = 0
  let transpositions = 0

  for (let i = 0; i < aLen; i++) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(i + matchWindow + 1, bLen)
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  let k = 0
  for (let i = 0; i < aLen; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }

  const jaro =
    (matches / aLen + matches / bLen + (matches - transpositions / 2) / matches) / 3

  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(aLen, bLen)); i++) {
    if (a[i] === b[i]) prefix++
    else break
  }

  return jaro + prefix * 0.1 * (1 - jaro)
}

const resolveAlias = (target: string): string[] => {
  const candidates = [target]
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (target === canonical || aliases.includes(target)) {
      candidates.push(canonical, ...aliases)
    }
  }
  return [...new Set(candidates)]
}

const pickOptionValue = (field: ExtractedField, rawTarget: string): string => {
  if (!rawTarget) return ""
  const target = normalize(rawTarget)

  const exactValue = field.options.find((o) => normalize(o.value) === target)
  if (exactValue) return exactValue.value

  const exactLabel = field.options.find((o) => normalize(o.label) === target)
  if (exactLabel) return exactLabel.value

  const aliases = resolveAlias(target)
  for (const alias of aliases) {
    const aliasValue = field.options.find((o) => normalize(o.value) === alias)
    if (aliasValue) return aliasValue.value
    const aliasLabel = field.options.find((o) => normalize(o.label) === alias)
    if (aliasLabel) return aliasLabel.value
  }

  const substringLabel = field.options.find((o) =>
    normalize(o.label).includes(target) || target.includes(normalize(o.label))
  )
  if (substringLabel) return substringLabel.value

  let bestScore = 0
  let bestOption = ""
  for (const option of field.options) {
    const labelScore = jaroWinkler(target, normalize(option.label))
    const valueScore = jaroWinkler(target, normalize(option.value))
    const score = Math.max(labelScore, valueScore)
    if (score > bestScore) {
      bestScore = score
      bestOption = option.value
    }
  }
  if (bestScore >= 0.85) return bestOption

  return ""
}

interface PreResolvedField {
  field: ExtractedField
  resolvedValue: string | null
  resolvedAction: AgentAction | null
}

const preResolveSelectFields = (
  snapshot: FormSnapshot,
  context: AgentContext
): PreResolvedField[] => {
  return snapshot.fields.map((field) => {
    if (field.kind !== "select" || hasMeaningfulValue(field)) {
      return { field, resolvedValue: null, resolvedAction: null }
    }
    const profileValue = findProfileValueForField(field, context)
    if (!profileValue) {
      return { field, resolvedValue: null, resolvedAction: null }
    }
    const matched = pickOptionValue(field, profileValue)
    if (!matched) {
      return { field, resolvedValue: null, resolvedAction: null }
    }
    const matchedOption = field.options.find((o) => o.value === matched)
    const action: AgentAction = {
      id: crypto.randomUUID(),
      type: "setSelect",
      selector: field.selector,
      fieldLabel: field.label || field.name || "select field",
      value: matched,
      reasoning: `Pre-resolved: "${profileValue}" → "${matchedOption?.label ?? matched}"`,
      confidence: 0.85
    }
    return { field, resolvedValue: matched, resolvedAction: action }
  })
}

const findProfileValueForField = (field: ExtractedField, context: AgentContext) => {
  const combined = normalize(
    [field.label, field.name, field.placeholder].filter(Boolean).join(" ")
  )
  if (!combined) {
    return ""
  }

  for (const descriptor of PROFILE_HINTS) {
    if (descriptor.hints.some((hint) => combined.includes(normalize(hint)))) {
      const value = context.profile[descriptor.key]
      if (value) {
        return value
      }
    }
  }

  if (combined.includes("location") || combined.includes("address")) {
    const composed = composeLocationString(context.profile)
    if (composed) return composed
  }

  return ""
}

const hasMeaningfulValue = (field: ExtractedField) => {
  if (field.kind === "checkbox" || field.kind === "radio") {
    return field.currentValue === "true"
  }
  return field.currentValue.trim().length > 0
}

const convertFieldToAction = (
  field: ExtractedField,
  rawValue: string,
  source: "webllm" | "rule-based",
  confidence = 0.7
): AgentAction | null => {
  if (!rawValue) {
    return null
  }

  if (field.kind === "select") {
    const selected = pickOptionValue(field, rawValue)
    if (!selected) {
      return null
    }
    return {
      id: crypto.randomUUID(),
      type: "setSelect",
      selector: field.selector,
      fieldLabel: field.label || field.name || "select field",
      value: selected,
      reasoning: `Select option matched from ${source} plan`,
      confidence
    }
  }

  if (field.kind === "checkbox") {
    const target = normalize(rawValue)
    const checked = ["yes", "true", "1", "required"].some((value) =>
      target.includes(value)
    )
    return {
      id: crypto.randomUUID(),
      type: "setCheckbox",
      selector: field.selector,
      fieldLabel: field.label || field.name || "checkbox",
      value: String(checked),
      reasoning: `Checkbox decision from ${source} plan`,
      confidence
    }
  }

  if (field.kind === "radio") {
    const selected = pickOptionValue(field, rawValue) || rawValue
    return {
      id: crypto.randomUUID(),
      type: "setRadio",
      selector: field.selector,
      fieldLabel: field.label || field.name || "radio field",
      value: selected,
      reasoning: `Radio option from ${source} plan`,
      confidence
    }
  }

  return {
    id: crypto.randomUUID(),
    type: "setValue",
    selector: field.selector,
    fieldLabel: field.label || field.name || "text field",
    value: rawValue,
    reasoning: `Field matched from ${source} plan`,
    confidence
  }
}

const ruleBasedConfidence = (center: number, spread: number) =>
  Math.max(0, Math.min(1, center + (Math.random() - 0.5) * spread))

const buildRuleBasedPlan = (snapshot: FormSnapshot, context: AgentContext): AgentAction[] => {
  const fieldActions = snapshot.fields
    .map((field) => {
      if (hasMeaningfulValue(field)) return null
      const fieldLabel = field.label || field.name || field.placeholder || ""
      if (isGenerativeField(fieldLabel, field.kind)) return null
      const rawValue = findProfileValueForField(field, context)
      const conf = ruleBasedConfidence(0.62, 0.12)
      return convertFieldToAction(field, rawValue, "rule-based", conf)
    })
    .filter((action): action is AgentAction => Boolean(action))

  const nextButton = snapshot.navigationTargets[0]
  if (nextButton) {
    fieldActions.push({
      id: crypto.randomUUID(),
      type: "clickNext",
      selector: nextButton.selector,
      fieldLabel: nextButton.text || "Next button",
      value: "",
      reasoning: "Detected likely navigation control",
      confidence: ruleBasedConfidence(0.58, 0.12)
    })
  }

  return fieldActions
}

const ACTION_JSON_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          selector: { type: "string" },
          type: { type: "string", enum: ["setValue", "setSelect", "setCheckbox", "setRadio", "clickNext"] },
          fieldLabel: { type: "string" },
          value: { type: "string" },
          reasoning: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["selector", "type", "value"]
      }
    }
  },
  required: ["actions"]
})

const SYSTEM_PROMPT = `You review and complete a form-fill plan. Respond with a JSON object containing an "actions" array.

RULES:
1. Copy selectors EXACTLY from input. Never invent selectors.
2. For DROPDOWN fields: value MUST be one of the listed options. If no option fits, skip the field.
3. A "city" field needs a city name, NOT a country. A "country" field needs a country, NOT a city.
4. If the profile lacks data for a field, omit it. Set confidence below 0.5 for uncertain answers.
5. PRE-FILLED fields: keep unless clearly wrong. If wrong, include a corrected action.
6. UNFILLED fields: provide values from profile/resume. Use inference (e.g., derive first name from full name).
7. Fill actions first; clickNext last. Never click Apply/Submit buttons.`

const formatFieldForPrompt = (
  field: ExtractedField,
  prefilledValue?: string
): string => {
  const label = field.label || field.name || "?"
  const nameTag = field.name ? ` (name="${field.name}")` : ""
  const status = prefilledValue
    ? `pre-filled: "${prefilledValue}"`
    : "[needs value]"

  if (field.kind === "select") {
    const optionLabels = field.options
      .filter((o) => o.value)
      .slice(0, 50)
      .map((o) => o.label || o.value)
      .join(", ")
    return `${field.selector} | ${label}${nameTag} | DROPDOWN pick from: [${optionLabels}] | ${status}`
  }

  if (field.kind === "checkbox") {
    return `${field.selector} | ${label}${nameTag} | CHECKBOX (true/false) | ${status}`
  }

  if (field.kind === "radio") {
    const optionLabels = field.options.map((o) => o.label || o.value).join(", ")
    return `${field.selector} | ${label}${nameTag} | RADIO pick from: [${optionLabels}] | ${status}`
  }

  const typeTag = field.kind === "email" ? "EMAIL"
    : field.kind === "tel" ? "PHONE"
    : field.kind === "url" ? "URL"
    : field.kind === "date" ? "DATE"
    : "TEXT"
  return `${field.selector} | ${label}${nameTag} | ${typeTag} | ${status}`
}

const buildHybridUserPrompt = (
  snapshot: FormSnapshot,
  context: AgentContext,
  ruleActions: AgentAction[],
  preResolved: PreResolvedField[]
): string => {
  const ruleMap = new Map(ruleActions.map((a) => [a.selector, a]))
  const preResolvedMap = new Map(
    preResolved
      .filter((p) => p.resolvedAction)
      .map((p) => [p.field.selector, p.resolvedAction!])
  )

  const prefilledLines: string[] = []
  const unfilledLines: string[] = []

  for (const field of snapshot.fields) {
    if (hasMeaningfulValue(field)) continue
    const fieldLabel = field.label || field.name || field.placeholder || ""
    if (isGenerativeField(fieldLabel, field.kind)) continue
    const ruleAction = ruleMap.get(field.selector)
    const preAction = preResolvedMap.get(field.selector)
    const filledValue = preAction?.value ?? ruleAction?.value

    const line = formatFieldForPrompt(field, filledValue ?? undefined)
    if (filledValue) {
      prefilledLines.push(line)
    } else {
      unfilledLines.push(line)
    }
  }

  const navText = snapshot.navigationTargets
    .map((n) => `${n.selector} | ${n.text}`)
    .join("\n")

  const jobLine = context.jobContext.jobTitle || context.jobContext.companyName
    ? `JOB: ${context.jobContext.jobTitle}${context.jobContext.companyName ? ` at ${context.jobContext.companyName}` : ""}`
    : ""

  return `PROFILE: ${JSON.stringify(context.profile)}
RESUME HIGHLIGHTS: ${context.resume.parsedHighlights.slice(0, 5).join("; ")}
${jobLine ? jobLine + "\n" : ""}
PRE-FILLED (review for correctness — fix any that are wrong for the field type):
${prefilledLines.length ? prefilledLines.join("\n") : "(none)"}

UNFILLED (provide values using profile/resume context):
${unfilledLines.length ? unfilledLines.join("\n") : "(none)"}

NAV (for clickNext only): ${navText || "none"}

Output JSON array of actions for ALL fields (pre-filled corrections + unfilled values):`
}

const buildRetryPrompt = (
  snapshot: FormSnapshot,
  context: AgentContext
): string => {
  const fields = snapshot.fields
    .filter((f) => !hasMeaningfulValue(f))
    .map((f) => {
      const label = f.label || f.name || "?"
      if (f.kind === "select") {
        const opts = f.options.filter((o) => o.value).slice(0, 20).map((o) => o.label || o.value).join(", ")
        return `${f.selector} | ${label} | DROPDOWN [${opts}]`
      }
      return `${f.selector} | ${label} | ${f.kind}`
    })
    .join("\n")

  return `Fill these form fields. Output ONLY a JSON array.
Each item: {"selector":"...","type":"setValue"|"setSelect","fieldLabel":"...","value":"...","reasoning":"...","confidence":0.8}

PROFILE: ${JSON.stringify(context.profile)}
FIELDS:
${fields}

JSON array:`
}

const mergeLlmActions = (
  parsed: z.infer<typeof llmActionSchema>[],
  snapshot: FormSnapshot,
  allowedSelectors: Set<string>,
  mergedActions: Map<string, AgentAction>
): number => {
  let count = 0
  for (const llmAction of parsed) {
    if (!allowedSelectors.has(llmAction.selector)) continue
    const field = snapshot.fields.find((f) => f.selector === llmAction.selector)
    if (!field) continue

    let finalAction: AgentAction | null
    if (field.kind === "select") {
      const resolved = pickOptionValue(field, llmAction.value)
      if (!resolved) continue
      finalAction = {
        id: crypto.randomUUID(),
        ...llmAction,
        value: resolved,
        reasoning: llmAction.reasoning || "LLM refinement"
      }
    } else {
      finalAction = {
        id: crypto.randomUUID(),
        ...llmAction,
        reasoning: llmAction.reasoning || "LLM refinement"
      }
    }
    if (finalAction) {
      mergedActions.set(finalAction.selector, finalAction)
      count++
    }
  }
  return count
}

const isHardWebLlmUnavailableError = (message: string) =>
  message.includes("WebLLM unavailable in this browser context")

const appendNavAction = (
  snapshot: FormSnapshot,
  mergedActions: Map<string, AgentAction>
) => {
  const nextButton = snapshot.navigationTargets[0]
  if (nextButton) {
    mergedActions.set(nextButton.selector, {
      id: crypto.randomUUID(),
      type: "clickNext",
      selector: nextButton.selector,
      fieldLabel: nextButton.text || "Next button",
      value: "",
      reasoning: "Detected likely navigation control",
      confidence: 0.58
    })
  }
}

const generateContentForFields = async (
  snapshot: FormSnapshot,
  context: AgentContext,
  mergedActions: Map<string, AgentAction>
): Promise<number> => {
  const generativeFields = snapshot.fields.filter((field) => {
    if (hasMeaningfulValue(field)) return false
    const fieldLabel = field.label || field.name || field.placeholder || ""
    return isGenerativeField(fieldLabel, field.kind)
  })

  let generated = 0
  for (const field of generativeFields) {
    const fieldLabel = field.label || field.name || field.placeholder || ""
    try {
      const content = await generateFieldContent(fieldLabel, context)
      if (content) {
        mergedActions.set(field.selector, {
          id: crypto.randomUUID(),
          type: "setValue",
          selector: field.selector,
          fieldLabel: field.label || field.name || "text field",
          value: content,
          reasoning: "Generated from resume + job context",
          confidence: 0.75
        })
        generated++
      }
    } catch {
      /* skip failed generation, LLM planning may still handle it */
    }
  }
  return generated
}

export const buildActionPlan = async (
  snapshot: FormSnapshot,
  context: AgentContext
): Promise<PlanResult> => {
  const allowedSelectors = new Set<string>([
    ...snapshot.fields.map((field) => field.selector),
    ...snapshot.navigationTargets.map((target) => target.selector)
  ])

  const ruleActions = buildRuleBasedPlan(snapshot, context)
  const preResolved = preResolveSelectFields(snapshot, context)

  const mergedActions = new Map<string, AgentAction>()
  for (const action of ruleActions) {
    mergedActions.set(action.selector, action)
  }
  for (const { resolvedAction } of preResolved) {
    if (resolvedAction) {
      mergedActions.set(resolvedAction.selector, resolvedAction)
    }
  }

  const generatedCount = await generateContentForFields(
    snapshot,
    context,
    mergedActions
  )

  const totalFields = snapshot.fields.filter((f) => !hasMeaningfulValue(f)).length

  // Attempt 1: full hybrid prompt with structured JSON output
  let llmError = ""
  try {
    const userPrompt = buildHybridUserPrompt(snapshot, context, ruleActions, preResolved)
    const raw = await runWebLlmPrompt(SYSTEM_PROMPT, userPrompt, ACTION_JSON_SCHEMA)
    const parsed = tryParseActions(raw)

    if (parsed && parsed.length > 0) {
      const llmCount = mergeLlmActions(parsed, snapshot, allowedSelectors, mergedActions)
      appendNavAction(snapshot, mergedActions)
      const genNote = generatedCount > 0 ? `, ${generatedCount} generated` : ""
      return {
        source: "hybrid",
        actions: sortActions(Array.from(mergedActions.values())),
        llmDetail: `LLM refined ${llmCount}/${totalFields} fields${genNote}`
      }
    }
    llmError = `LLM returned unparseable output (${raw.length} chars)`
  } catch (error: unknown) {
    llmError = error instanceof Error ? error.message : "LLM call failed"
  }

  if (isHardWebLlmUnavailableError(llmError)) {
    appendNavAction(snapshot, mergedActions)
    const genNote = generatedCount > 0 ? ` (${generatedCount} fields generated)` : ""
    return {
      source: generatedCount > 0 ? "hybrid" : "rule-based",
      actions: sortActions(Array.from(mergedActions.values())),
      llmDetail: `Skipped retry: ${llmError}${genNote}`
    }
  }

  // Attempt 2: retry with simpler prompt, still using structured output
  try {
    const retryPrompt = buildRetryPrompt(snapshot, context)
    const raw = await runWebLlmPrompt(
      "You fill form fields. Respond with a JSON object containing an actions array.",
      retryPrompt,
      ACTION_JSON_SCHEMA
    )
    const parsed = tryParseActions(raw)

    if (parsed && parsed.length > 0) {
      const llmCount = mergeLlmActions(parsed, snapshot, allowedSelectors, mergedActions)
      appendNavAction(snapshot, mergedActions)
      const genNote = generatedCount > 0 ? `, ${generatedCount} generated` : ""
      return {
        source: "hybrid",
        actions: sortActions(Array.from(mergedActions.values())),
        llmDetail: `LLM retry succeeded: refined ${llmCount}/${totalFields} fields${genNote} (first attempt: ${llmError})`
      }
    }
    llmError += "; retry also returned unparseable output"
  } catch (retryError: unknown) {
    llmError += `; retry failed: ${retryError instanceof Error ? retryError.message : "unknown"}`
  }

  // Fallback: rule-based + pre-resolved + generated content
  appendNavAction(snapshot, mergedActions)
  const genNote = generatedCount > 0 ? ` (${generatedCount} fields generated)` : ""
  return {
    source: generatedCount > 0 ? "hybrid" : "rule-based",
    actions: sortActions(Array.from(mergedActions.values())),
    llmDetail: `Fell back to rule-based${genNote}: ${llmError}`
  }
}
