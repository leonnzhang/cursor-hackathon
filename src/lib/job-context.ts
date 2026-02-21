import type { JobContext } from "~src/types/agent"

const JOB_BOARD_COMPANY_PATTERNS: Array<{
  hostPattern: RegExp
  extract: (url: URL) => string
}> = [
  {
    hostPattern: /\.greenhouse\.io$/,
    extract: (url) => {
      const match = url.pathname.match(/^\/([^/]+)/)
      return match?.[1]?.replace(/[-_]/g, " ") ?? ""
    }
  },
  {
    hostPattern: /\.lever\.co$/,
    extract: (url) => {
      const match = url.hostname.match(/^([^.]+)\.lever\.co$/)
      return match?.[1]?.replace(/[-_]/g, " ") ?? ""
    }
  },
  {
    hostPattern: /\.myworkdayjobs\.com$/,
    extract: (url) => {
      const match = url.hostname.match(/^([^.]+)\.myworkdayjobs\.com$/)
      return match?.[1]?.replace(/[-_]/g, " ") ?? ""
    }
  },
  {
    hostPattern: /\.ashbyhq\.com$/,
    extract: (url) => {
      const match = url.pathname.match(/^\/([^/]+)/)
      return match?.[1]?.replace(/[-_]/g, " ") ?? ""
    }
  },
  {
    hostPattern: /\.icims\.com$/,
    extract: () => ""
  },
  {
    hostPattern: /boards\.eu\.greenhouse\.io$/,
    extract: (url) => {
      const match = url.pathname.match(/^\/([^/]+)/)
      return match?.[1]?.replace(/[-_]/g, " ") ?? ""
    }
  }
]

const TITLE_AT_COMPANY_RE =
  /^(.+?)\s+(?:at|@|-)\s+(.+?)(?:\s*[|\-–—].*)?$/i

const titleCase = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ")

const extractCompanyFromUrl = (url: URL): string => {
  for (const { hostPattern, extract } of JOB_BOARD_COMPANY_PATTERNS) {
    if (hostPattern.test(url.hostname)) {
      const name = extract(url)
      return name ? titleCase(name) : ""
    }
  }
  return ""
}

const extractFromTitle = (
  title: string
): { jobTitle: string; companyName: string } => {
  const match = title.match(TITLE_AT_COMPANY_RE)
  if (match) {
    return { jobTitle: match[1].trim(), companyName: match[2].trim() }
  }

  const dashParts = title.split(/\s*[|\-–—]\s*/).filter(Boolean)
  if (dashParts.length >= 2) {
    return { jobTitle: dashParts[0].trim(), companyName: dashParts[1].trim() }
  }

  return { jobTitle: title.trim(), companyName: "" }
}

const extractJobTitleFromHeadings = (): string => {
  for (const tag of ["h1", "h2"]) {
    const headings = document.querySelectorAll<HTMLElement>(tag)
    for (const heading of headings) {
      const text = heading.textContent?.trim() ?? ""
      if (text.length > 5 && text.length < 120) {
        return text
      }
    }
  }
  return ""
}

const extractDescriptionSnippet = (): string => {
  const metaDesc =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.content?.trim() ?? ""
  if (metaDesc.length > 30) {
    return metaDesc.slice(0, 500)
  }

  const ogDesc =
    document.querySelector<HTMLMetaElement>('meta[property="og:description"]')
      ?.content?.trim() ?? ""
  if (ogDesc.length > 30) {
    return ogDesc.slice(0, 500)
  }

  const selectors = [
    '[data-testid="job-description"]',
    ".job-description",
    "#job-description",
    '[class*="jobDescription"]',
    '[class*="job-description"]',
    '[class*="posting-description"]',
    "article",
    '[role="main"]'
  ]
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel)
    if (el) {
      const text = el.textContent?.trim() ?? ""
      if (text.length > 50) {
        return text.slice(0, 500)
      }
    }
  }

  return ""
}

const extractCompanyFromPage = (): string => {
  const ogSite =
    document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')
      ?.content?.trim() ?? ""
  if (ogSite) return ogSite

  const schemaScripts = document.querySelectorAll<HTMLScriptElement>(
    'script[type="application/ld+json"]'
  )
  for (const script of schemaScripts) {
    try {
      const data = JSON.parse(script.textContent ?? "")
      const org =
        data?.hiringOrganization?.name ??
        data?.employerOverview?.name ??
        data?.organization?.name
      if (typeof org === "string" && org) return org
    } catch {
      /* skip malformed JSON-LD */
    }
  }

  return ""
}

export const extractJobContext = (): JobContext => {
  let url: URL
  try {
    url = new URL(window.location.href)
  } catch {
    return { jobTitle: "", companyName: "", descriptionSnippet: "" }
  }

  const fromTitle = extractFromTitle(document.title)
  const headingTitle = extractJobTitleFromHeadings()
  const urlCompany = extractCompanyFromUrl(url)
  const pageCompany = extractCompanyFromPage()

  const jobTitle = headingTitle || fromTitle.jobTitle
  const companyName = urlCompany || pageCompany || fromTitle.companyName
  const descriptionSnippet = extractDescriptionSnippet()

  return { jobTitle, companyName, descriptionSnippet }
}
