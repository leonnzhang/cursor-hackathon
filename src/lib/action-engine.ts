import { z } from "zod"

import type { AgentContext, AgentAction, ExtractedField, FormSnapshot, PlanResult } from "~src/types/agent"
import { runWebLlmPrompt } from "~src/lib/webllm"

// #region agent log
const _dbg = (msg: string, data: Record<string, unknown>, hyp: string) =>
  fetch("http://127.0.0.1:7444/ingest/5febb908-5112-4db3-9ca9-07c57ed4c177", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "030d0c" },
    body: JSON.stringify({ sessionId: "030d0c", location: "action-engine.ts", message: msg, data, hypothesisId: hyp, timestamp: Date.now() })
  }).catch(() => {})
// #endregion

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
  { key: "location", hints: ["location", "city", "country", "address"] },
  { key: "linkedin", hints: ["linkedin"] },
  { key: "github", hints: ["github"] },
  { key: "portfolio", hints: ["portfolio", "website", "personal site"] },
  { key: "currentTitle", hints: ["title", "current role", "position"] },
  { key: "yearsExperience", hints: ["years", "experience"] },
  { key: "workAuthorization", hints: ["work authorization", "authorized", "visa"] },
  { key: "needsSponsorship", hints: ["sponsorship", "sponsor"] },
  { key: "summary", hints: ["summary", "about", "cover letter"] }
]

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

const pickOptionValue = (field: ExtractedField, rawTarget: string) => {
  if (!rawTarget) {
    return ""
  }
  const target = normalize(rawTarget)
  const direct = field.options.find((option) => normalize(option.value) === target)
  if (direct) {
    return direct.value
  }
  const labelMatch = field.options.find((option) =>
    normalize(option.label).includes(target)
  )
  if (labelMatch) {
    return labelMatch.value
  }
  const fuzzy = field.options.find(
    (option) =>
      target.includes(normalize(option.label)) ||
      target.includes(normalize(option.value))
  )
  return fuzzy?.value ?? ""
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

  if (combined.includes("cover letter") && context.resume.rawText) {
    return context.resume.rawText.slice(0, 1200)
  }

  if (combined.includes("summary")) {
    return context.profile.summary || context.resume.parsedHighlights.join(" ")
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

const buildRuleBasedPlan = (snapshot: FormSnapshot, context: AgentContext): AgentAction[] => {
  const fieldActions = snapshot.fields
    .map((field) => {
      if (hasMeaningfulValue(field)) {
        return null
      }
      const rawValue = findProfileValueForField(field, context)
      return convertFieldToAction(field, rawValue, "rule-based", 0.62)
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
      confidence: 0.58
    })
  }

  return fieldActions
}

const systemPrompt = `You are a browser form automation planner.
You must output STRICT JSON only.
Return a JSON array where each item is:
{
  "selector": string,
  "type": "setValue" | "setSelect" | "setCheckbox" | "setRadio" | "clickNext",
  "fieldLabel": string,
  "value": string,
  "reasoning": string,
  "confidence": number
}
Rules:
- Only return selectors that already exist in provided fields/navigation.
- Keep confidence in [0,1].
- Skip risky or ambiguous actions.
- Output form-fill actions FIRST (setValue, setSelect, setCheckbox, setRadio), then clickNext LAST.
- Never include Apply or Submit buttons—they are final submission. Only include Next/Continue/Review for multi-step flows.`

export const buildActionPlan = async (
  snapshot: FormSnapshot,
  context: AgentContext
): Promise<PlanResult> => {
  const allowedSelectors = new Set<string>([
    ...snapshot.fields.map((field) => field.selector),
    ...snapshot.navigationTargets.map((target) => target.selector)
  ])

  const userPrompt = JSON.stringify(
    {
      profile: context.profile,
      resumeHighlights: context.resume.parsedHighlights,
      fields: snapshot.fields.map((field) => ({
        selector: field.selector,
        kind: field.kind,
        label: field.label,
        name: field.name,
        placeholder: field.placeholder,
        required: field.required,
        options: field.options
      })),
      navigationTargets: snapshot.navigationTargets
    },
    null,
    2
  )

  // #region agent log
  _dbg("buildActionPlan entry", {
    fieldCount: snapshot.fields.length,
    userPromptLength: userPrompt.length,
    allowedSelectorCount: allowedSelectors.size
  }, "H0_context")
  // #endregion

  try {
    const raw = await runWebLlmPrompt(systemPrompt, userPrompt)

    // #region agent log
    const extracted = extractLikelyJson(raw)
    _dbg("after runWebLlmPrompt", {
      rawLength: raw.length,
      extractedLength: extracted.length,
      rawEndsWithBracket: raw.trimEnd().endsWith("]"),
      extractedEndsWithBracket: extracted.trimEnd().endsWith("]"),
      rawLast150: raw.slice(-150),
      extractedLast150: extracted.slice(-150)
    }, "H1_truncation")
    // #endregion

    let parsed: z.infer<typeof llmActionListSchema>
    try {
      parsed = JSON.parse(extracted)
    } catch (err) {
      // #region agent log
      _dbg("JSON.parse failed", {
        error: err instanceof Error ? err.message : String(err),
        extractedSample: extracted.slice(0, 500)
      }, "H2_json_parse")
      // #endregion
      throw err
    }

    try {
      parsed = llmActionListSchema.parse(parsed)
    } catch (err) {
      // #region agent log
      _dbg("schema parse failed", {
        error: err instanceof Error ? err.message : String(err),
        parsedSample: JSON.stringify(parsed).slice(0, 500)
      }, "H3_schema")
      // #endregion
      throw err
    }

    const beforeFilter = parsed.length
    const filteredBySelector = parsed.filter((a) => !allowedSelectors.has(a.selector))
    const actions: AgentAction[] = parsed
      .filter((action) => allowedSelectors.has(action.selector))
      .map((action) => ({
        id: crypto.randomUUID(),
        ...action
      }))
      .filter((action) => action.type !== "clickNext" || Boolean(action.selector))

    // #region agent log
    _dbg("after filter", {
      parsedCount: beforeFilter,
      actionsCount: actions.length,
      filteredBySelectorCount: filteredBySelector.length,
      filteredSelectors: filteredBySelector.slice(0, 10).map((a) => a.selector)
    }, "H4_H5_selector_filter")
    // #endregion

    if (actions.length > 0) {
      return { source: "webllm", actions: sortActions(actions) }
    }

    // #region agent log
    _dbg("fallback: actions.length===0 after filter", { parsedCount: beforeFilter }, "H5_empty")
    // #endregion
  } catch (err) {
    // #region agent log
    _dbg("catch fallback", {
      error: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : ""
    }, "H0_catch")
    // #endregion
    // Rule-based fallback keeps MVP usable if model output is malformed.
  }

  return {
    source: "rule-based",
    actions: sortActions(buildRuleBasedPlan(snapshot, context))
  }
}
