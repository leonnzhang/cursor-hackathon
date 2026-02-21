import { z } from "zod"

import type { AgentContext, AgentAction, ExtractedField, FormSnapshot, PlanResult } from "~src/types/agent"
import { runWebLlmPrompt } from "~src/lib/webllm"

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

const systemPrompt = `You plan form-fill actions. Output ONLY a JSON array of ACTION objects. No other text.

Each action: {"selector":"...","type":"setValue"|"setSelect"|"setCheckbox"|"setRadio"|"clickNext","fieldLabel":"...","value":"...","reasoning":"...","confidence":0.8}

Example for one field:
[{"selector":"#first_name","type":"setValue","fieldLabel":"First Name","value":"John Doe","reasoning":"From profile fullName","confidence":0.9}]

Rules: Copy selectors exactly from input. Use profile/resume for value. setValue/setSelect/setCheckbox/setRadio first; clickNext last. No Apply/Submit.`

export const buildActionPlan = async (
  snapshot: FormSnapshot,
  context: AgentContext
): Promise<PlanResult> => {
  const allowedSelectors = new Set<string>([
    ...snapshot.fields.map((field) => field.selector),
    ...snapshot.navigationTargets.map((target) => target.selector)
  ])

  const fieldsText = snapshot.fields
    .map(
      (f) =>
        `${f.selector} | ${f.label || f.name || "?"} | ${f.kind}` +
        (f.options.length ? ` | options: ${f.options.slice(0, 8).map((o) => o.label || o.value).join(", ")}` : "")
    )
    .join("\n")
  const navText = snapshot.navigationTargets.map((n) => `${n.selector} | ${n.text}`).join("\n")
  const userPrompt = `PROFILE: ${JSON.stringify(context.profile)}
RESUME HIGHLIGHTS: ${context.resume.parsedHighlights.slice(0, 3).join("; ")}

FIELDS (use selector exactly):
${fieldsText}

NAV (for clickNext only): ${navText || "none"}

Output JSON array of actions:`

  try {
    const raw = await runWebLlmPrompt(systemPrompt, userPrompt)
    const parsed = llmActionListSchema.parse(JSON.parse(extractLikelyJson(raw)))

    const actions: AgentAction[] = parsed
      .filter((action) => allowedSelectors.has(action.selector))
      .map((action) => ({
        id: crypto.randomUUID(),
        ...action
      }))
      .filter((action) => action.type !== "clickNext" || Boolean(action.selector))

    if (actions.length > 0) {
      return { source: "webllm", actions: sortActions(actions) }
    }
  } catch {
    // Rule-based fallback keeps MVP usable if model output is malformed.
  }

  return {
    source: "rule-based",
    actions: sortActions(buildRuleBasedPlan(snapshot, context))
  }
}
