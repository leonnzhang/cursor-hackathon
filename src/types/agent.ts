export type FieldKind =
  | "text"
  | "textarea"
  | "email"
  | "tel"
  | "url"
  | "number"
  | "checkbox"
  | "radio"
  | "select"
  | "date"
  | "unknown"

export interface FieldOption {
  label: string
  value: string
}

export interface ExtractedField {
  id: string
  selector: string
  kind: FieldKind
  label: string
  name: string
  placeholder: string
  required: boolean
  options: FieldOption[]
  currentValue: string
}

export interface NavigationTarget {
  id: string
  selector: string
  text: string
}

export interface FormSnapshot {
  url: string
  title: string
  capturedAt: number
  fields: ExtractedField[]
  navigationTargets: NavigationTarget[]
}

export interface UserProfile {
  fullName: string
  email: string
  phone: string
  location: string
  linkedin: string
  github: string
  portfolio: string
  currentTitle: string
  yearsExperience: string
  workAuthorization: string
  needsSponsorship: string
  summary: string
}

export interface ResumeData {
  rawText: string
  parsedHighlights: string[]
}

export interface AgentContext {
  profile: UserProfile
  resume: ResumeData
}

export type ActionType =
  | "setValue"
  | "setSelect"
  | "setCheckbox"
  | "setRadio"
  | "clickNext"

export interface AgentAction {
  id: string
  type: ActionType
  selector: string
  fieldLabel: string
  value: string
  reasoning: string
  confidence: number
}

export interface PlanResult {
  source: "webllm" | "rule-based"
  actions: AgentAction[]
}

export interface ActionLogEntry {
  id: string
  actionId: string
  timestamp: number
  status: "approved" | "skipped" | "executed" | "failed" | "edited" | "stopped"
  detail: string
}
