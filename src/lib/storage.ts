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
  city: "",
  state: "",
  country: "",
  zipCode: "",
  streetAddress: "",
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

interface LegacyProfile {
  location?: string
  city?: string
  state?: string
  country?: string
  zipCode?: string
  streetAddress?: string
}

const migrateProfile = (raw: Record<string, unknown>): UserProfile => {
  const legacy = raw as LegacyProfile & Record<string, unknown>
  if (legacy.location && !legacy.city && !legacy.state && !legacy.country) {
    const parts = String(legacy.location)
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean)
    const migrated: Partial<UserProfile> = {}
    if (parts.length === 1) {
      migrated.country = parts[0]
    } else if (parts.length === 2) {
      migrated.city = parts[0]
      migrated.country = parts[1]
    } else if (parts.length >= 3) {
      migrated.city = parts[0]
      migrated.state = parts[1]
      migrated.country = parts.slice(2).join(", ")
    }
    const { location: _dropped, ...rest } = legacy as Record<string, unknown>
    return { ...DEFAULT_PROFILE, ...rest, ...migrated } as UserProfile
  }
  const { location: _dropped, ...cleaned } = legacy as Record<string, unknown>
  return { ...DEFAULT_PROFILE, ...cleaned } as UserProfile
}

export const saveProfile = async (profile: UserProfile) => {
  await chrome.storage.local.set({ [STORAGE_KEYS.profile]: profile })
}

export const loadProfile = async (): Promise<UserProfile> => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.profile)
  const raw = stored[STORAGE_KEYS.profile]
  if (!raw || typeof raw !== "object") return DEFAULT_PROFILE
  const profile = migrateProfile(raw as Record<string, unknown>)
  if ((raw as LegacyProfile).location && !profile.city && !profile.state && !profile.country) {
    return profile
  }
  if ((raw as LegacyProfile).location) {
    await saveProfile(profile)
  }
  return profile
}

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
