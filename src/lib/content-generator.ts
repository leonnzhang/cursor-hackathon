import type {
  AgentContext,
  JobContext,
  ResumeData,
  ResumeSection,
  UserProfile
} from "~src/types/agent"
import { runWebLlmTextGeneration } from "~src/lib/webllm"

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "is", "am", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "it",
  "its", "they", "them", "their", "what", "which", "who", "whom",
  "how", "when", "where", "why", "not", "no", "so", "if", "as", "from"
])

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))

export const findRelevantSnippets = (
  sections: ResumeSection[],
  query: string,
  maxSnippets = 3,
  maxChars = 600
): string => {
  if (sections.length === 0) return ""

  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) {
    return sections
      .slice(0, maxSnippets)
      .map((s) => s.content)
      .join("\n")
      .slice(0, maxChars)
  }

  const scored = sections.map((section) => {
    const sectionTokens = tokenize(section.heading + " " + section.content)
    let overlap = 0
    for (const token of sectionTokens) {
      if (queryTokens.has(token)) overlap++
    }
    const score = sectionTokens.length > 0
      ? overlap / Math.sqrt(sectionTokens.length)
      : 0
    return { section, score }
  })

  scored.sort((a, b) => b.score - a.score)

  let result = ""
  let count = 0
  for (const { section } of scored) {
    if (count >= maxSnippets || result.length >= maxChars) break
    const chunk = `[${section.heading}]\n${section.content}`
    result += (result ? "\n\n" : "") + chunk
    count++
  }
  return result.slice(0, maxChars)
}

const buildJobLine = (jobContext: JobContext): string => {
  const parts: string[] = []
  if (jobContext.jobTitle) parts.push(`Role: ${jobContext.jobTitle}`)
  if (jobContext.companyName) parts.push(`Company: ${jobContext.companyName}`)
  return parts.join(". ")
}

const buildApplicantLine = (profile: UserProfile): string => {
  const parts: string[] = []
  if (profile.fullName) parts.push(profile.fullName)
  if (profile.currentTitle) parts.push(profile.currentTitle)
  if (profile.yearsExperience) {
    parts.push(`${profile.yearsExperience} years experience`)
  }
  return parts.join(", ")
}

const composeFallbackCoverLetter = (
  profile: UserProfile,
  resume: ResumeData,
  jobContext: JobContext
): string => {
  const name = profile.fullName || "the applicant"
  const title = profile.currentTitle || "professional"
  const company = jobContext.companyName || "your organization"
  const role = jobContext.jobTitle || "this position"

  const experienceSection = resume.sections.find((s) =>
    /experience|work|history/i.test(s.heading)
  )
  const skillsSection = resume.sections.find((s) =>
    /skills|competenc|technical/i.test(s.heading)
  )

  const highlights = experienceSection
    ? experienceSection.content.split("\n").filter((l) => l.trim().length > 10).slice(0, 3).join(". ")
    : resume.parsedHighlights.slice(0, 3).join(". ")

  const skills = skillsSection
    ? skillsSection.content.slice(0, 150)
    : ""

  let letter = `Dear Hiring Manager,\n\nI am writing to express my interest in the ${role} position at ${company}. As a ${title}, I bring a strong background that aligns well with this opportunity.`
  if (highlights) {
    letter += `\n\n${highlights}.`
  }
  if (skills) {
    letter += ` My key skills include ${skills}.`
  }
  letter += `\n\nI would welcome the opportunity to discuss how my experience can contribute to ${company}'s success.\n\nSincerely,\n${name}`
  return letter
}

const composeFallbackSummary = (
  profile: UserProfile,
  resume: ResumeData,
  jobContext: JobContext
): string => {
  const title = profile.currentTitle || "professional"
  const experience = profile.yearsExperience
    ? `with ${profile.yearsExperience} years of experience`
    : ""
  const role = jobContext.jobTitle ? ` seeking a ${jobContext.jobTitle} role` : ""

  const skillsSection = resume.sections.find((s) =>
    /skills|competenc|technical/i.test(s.heading)
  )
  const skillBrief = skillsSection
    ? `, skilled in ${skillsSection.content.split("\n").filter(Boolean).slice(0, 2).join(", ").slice(0, 100)}`
    : ""

  return `${profile.fullName || "Experienced"} ${title} ${experience}${role}${skillBrief}.`.replace(/\s+/g, " ")
}

const composeFallbackAnswer = (
  question: string,
  profile: UserProfile,
  resume: ResumeData,
  jobContext: JobContext
): string => {
  const snippets = findRelevantSnippets(resume.sections, question, 2, 300)
  const role = jobContext.jobTitle || "this role"
  const company = jobContext.companyName || "this company"

  if (/why .*(want|interested|apply|join)/i.test(question)) {
    return `I am drawn to ${role} at ${company} because it aligns with my background as a ${profile.currentTitle || "professional"}. ${snippets ? snippets.split("\n").filter((l) => l.trim().length > 10).slice(0, 2).join(". ") + "." : ""}`
  }

  if (snippets) {
    return snippets
      .split("\n")
      .filter((l) => l.trim().length > 10 && !l.startsWith("["))
      .slice(0, 4)
      .join(". ")
      .slice(0, 500)
  }

  return profile.summary || resume.parsedHighlights.join(". ")
}

export const generateCoverLetter = async (
  context: AgentContext
): Promise<string> => {
  const { profile, resume, jobContext } = context
  const snippets = findRelevantSnippets(
    resume.sections,
    `${jobContext.jobTitle} ${jobContext.descriptionSnippet}`,
    4,
    800
  )

  if (!snippets && !resume.rawText) {
    return composeFallbackCoverLetter(profile, resume, jobContext)
  }

  const systemPrompt = `You write concise, professional cover letters. Output ONLY the letter text, no commentary. Keep it to 3 short paragraphs. Be specific and authentic, not generic.`

  const userPrompt = `Write a cover letter.
${buildJobLine(jobContext)}
Applicant: ${buildApplicantLine(profile)}
${jobContext.descriptionSnippet ? `Job details: ${jobContext.descriptionSnippet.slice(0, 300)}` : ""}

Resume highlights:
${snippets || resume.rawText.slice(0, 600)}

Write a 3-paragraph cover letter. Paragraph 1: express interest and fit. Paragraph 2: highlight 2-3 specific qualifications from the resume. Paragraph 3: enthusiasm and call to action. Start with "Dear Hiring Manager," and end with "Sincerely, ${profile.fullName || "the applicant"}".`

  try {
    const result = await runWebLlmTextGeneration(systemPrompt, userPrompt)
    if (result && result.length > 50) return result.trim()
  } catch {
    /* fall through to fallback */
  }

  return composeFallbackCoverLetter(profile, resume, jobContext)
}

export const generateSummary = async (
  context: AgentContext
): Promise<string> => {
  const { profile, resume, jobContext } = context
  const snippets = findRelevantSnippets(
    resume.sections,
    `${jobContext.jobTitle} summary skills experience`,
    3,
    400
  )

  if (!snippets && !resume.rawText) {
    return composeFallbackSummary(profile, resume, jobContext)
  }

  const systemPrompt = `You write professional summaries for job applications. Output ONLY the summary text, 2-3 sentences. Be specific and compelling.`

  const userPrompt = `Write a professional summary.
${buildJobLine(jobContext)}
Applicant: ${buildApplicantLine(profile)}

Resume context:
${snippets || resume.rawText.slice(0, 400)}

Write a 2-3 sentence professional summary highlighting relevant skills and experience for this role.`

  try {
    const result = await runWebLlmTextGeneration(systemPrompt, userPrompt)
    if (result && result.length > 20) return result.trim()
  } catch {
    /* fall through to fallback */
  }

  return composeFallbackSummary(profile, resume, jobContext)
}

export const generateOpenEndedAnswer = async (
  question: string,
  context: AgentContext
): Promise<string> => {
  const { profile, resume, jobContext } = context
  const snippets = findRelevantSnippets(
    resume.sections,
    `${question} ${jobContext.jobTitle}`,
    3,
    500
  )

  if (!snippets && !resume.rawText) {
    return composeFallbackAnswer(question, profile, resume, jobContext)
  }

  const systemPrompt = `You answer job application questions on behalf of the applicant. Write in first person. Be specific, drawing on the resume details provided. Output ONLY the answer, 2-4 sentences. Do not include the question in your response.`

  const userPrompt = `Answer this application question: "${question}"
${buildJobLine(jobContext)}
Applicant: ${buildApplicantLine(profile)}

Resume context:
${snippets || resume.rawText.slice(0, 500)}

Answer in 2-4 sentences, first person, drawing on specific details from the resume.`

  try {
    const result = await runWebLlmTextGeneration(systemPrompt, userPrompt)
    if (result && result.length > 15) return result.trim()
  } catch {
    /* fall through to fallback */
  }

  return composeFallbackAnswer(question, profile, resume, jobContext)
}

const GENERATIVE_PATTERNS = [
  /cover\s*letter/i,
  /why\s+(?:do\s+)?(?:you|are\s+you)\s+(?:want|interested|apply|looking)/i,
  /why\s+(?:this|our|the)\s+(?:company|role|position|team|job)/i,
  /describe\s+(?:your|a\s+time|a\s+situation|yourself)/i,
  /tell\s+us\s+(?:about|why)/i,
  /what\s+makes\s+you/i,
  /about\s+(?:you|yourself)/i,
  /motivation/i,
  /interest\s+in\s+(?:this|the|our)/i,
  /additional\s+(?:information|comments|notes)/i,
  /anything\s+(?:else|you.*(?:like|want).*(?:share|add|mention))/i,
  /how\s+did\s+you\s+hear/i,
  /what\s+(?:excites|interests|attracts)\s+you/i
]

export const isGenerativeField = (
  label: string,
  kind: string
): boolean => {
  if (!label) return false
  const combined = label.toLowerCase()

  if (GENERATIVE_PATTERNS.some((re) => re.test(combined))) return true

  if (kind === "textarea" && combined.length > 15) return true

  return false
}

export type GenerativeFieldType = "cover-letter" | "summary" | "open-ended"

export const classifyGenerativeField = (label: string): GenerativeFieldType => {
  const lower = label.toLowerCase()
  if (/cover\s*letter/i.test(lower)) return "cover-letter"
  if (/\b(?:summary|about\s+(?:you|yourself)|professional\s+summary|objective)\b/i.test(lower)) {
    return "summary"
  }
  return "open-ended"
}

export const generateFieldContent = async (
  label: string,
  context: AgentContext
): Promise<string> => {
  const fieldType = classifyGenerativeField(label)
  switch (fieldType) {
    case "cover-letter":
      return generateCoverLetter(context)
    case "summary":
      return generateSummary(context)
    case "open-ended":
      return generateOpenEndedAnswer(label, context)
  }
}
