export const DEFAULT_WHITELIST = [
  "jobs.lever.co",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "myworkdayjobs.com"
]

export const FALLBACK_DEMO_WHITELIST = ["*"]

const normalizeHostname = (hostname: string) =>
  hostname.trim().toLowerCase().replace(/^\.+|\.+$/g, "")

export const isWhitelistedHost = (
  hostname: string,
  whitelist: string[] = DEFAULT_WHITELIST
) => {
  const normalizedHost = normalizeHostname(hostname)
  if (!normalizedHost) {
    return false
  }

  return whitelist.some((entry) => {
    const normalizedEntry = normalizeHostname(entry)
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
