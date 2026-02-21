import type { AgentContext, ResumeData, UserProfile } from "~src/types/agent"

export const STORAGE_KEYS = {
  profile: "agenticAutofill.profile",
  resume: "agenticAutofill.resume",
  whitelist: "agenticAutofill.whitelist"
} as const

export const DEFAULT_PROFILE: UserProfile = {
  fullName: "",
  email: "",
  phone: "",
  location: "",
  linkedin: "",
  github: "",
  portfolio: "",
  currentTitle: "",
  yearsExperience: "",
  workAuthorization: "",
  needsSponsorship: "",
  summary: ""
}

export const DEFAULT_RESUME: ResumeData = {
  rawText: "",
  parsedHighlights: []
}

const getLocal = async <T>(key: string, fallback: T): Promise<T> => {
  const stored = await chrome.storage.local.get(key)
  return (stored[key] as T) ?? fallback
}

export const saveProfile = async (profile: UserProfile) => {
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: profile })
}

export const loadProfile = async () =>
  getLocal<UserProfile>(STORAGE_KEYS.profile, DEFAULT_PROFILE)

export const parseResumeHighlights = (rawText: string) => {
  return rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12)
    .slice(0, 8)
}

export const saveResumeRawText = async (rawText: string) => {
  const resume: ResumeData = {
    rawText,
    parsedHighlights: parseResumeHighlights(rawText)
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.resume]: resume })
}

export const loadResume = async () =>
  getLocal<ResumeData>(STORAGE_KEYS.resume, DEFAULT_RESUME)

export const loadAgentContext = async (): Promise<AgentContext> => {
  const [profile, resume] = await Promise.all([loadProfile(), loadResume()])
  return { profile, resume }
}

export const saveWhitelist = async (whitelist: string[]) => {
  await chrome.storage.local.set({ [STORAGE_KEYS.whitelist]: whitelist })
}

export const loadWhitelist = async (fallback: string[]) =>
  getLocal<string[]>(STORAGE_KEYS.whitelist, fallback)
