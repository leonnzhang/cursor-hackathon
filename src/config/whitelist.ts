export const DEFAULT_WHITELIST = [
  "jobs.lever.co",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "myworkdayjobs.com"
]

export const FALLBACK_DEMO_WHITELIST = ["*"]

const normalizeHostname = (hostname: string) =>
  hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "")

const normalizeWhitelistEntry = (entry: string) => {
  const normalized = normalizeHostname(entry)
  if (!normalized) {
    return ""
  }
  if (normalized === "*") {
    return "*"
  }

  // Accept users pasting full URLs or host/path values in the whitelist field.
  if (normalized.includes("://")) {
    try {
      return normalizeHostname(new URL(normalized).hostname)
    } catch {
      return ""
    }
  }

  const withoutWildcard = normalized.startsWith("*.")
    ? normalized.slice(2)
    : normalized
  const withoutPath = withoutWildcard.split("/")[0] ?? ""
  const withoutPort = withoutPath.split(":")[0] ?? ""
  return normalizeHostname(withoutPort)
}

export const isWhitelistedHost = (
  hostname: string,
  whitelist: string[] = DEFAULT_WHITELIST
) => {
  const normalizedHost = normalizeHostname(hostname)
  if (!normalizedHost) {
    return false
  }

  return whitelist.some((entry) => {
    const normalizedEntry = normalizeWhitelistEntry(entry)
    if (normalizedEntry === "*") {
      return true
    }
    return (
      normalizedHost === normalizedEntry ||
      normalizedHost.endsWith(`.${normalizedEntry}`)
    )
  })
}

export const getHostnameFromUrl = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}
