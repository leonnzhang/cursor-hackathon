import type {
  ExtractedField,
  FieldKind,
  FieldOption,
  FormSnapshot,
  NavigationTarget
} from "~src/types/agent"
import { extractJobContext } from "~src/lib/job-context"

const NAVIGATION_REGEX = /(next|continue|review|save and continue)/i

const escapeCss = (value: string) =>
  value.replace(/([ #;?%&,.+*~':"!^$[\]()=>|/@])/g, "\\$1")

const isVisible = (element: Element) => {
  const htmlElement = element as HTMLElement
  const style = window.getComputedStyle(htmlElement)
  const rect = htmlElement.getBoundingClientRect()
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.opacity !== "0" &&
    rect.width > 0 &&
    rect.height > 0
  )
}

const buildFallbackSelector = (element: Element) => {
  const path: string[] = []
  let current: Element | null = element
  while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 5) {
    const tag = current.tagName.toLowerCase()
    const parentEl: Element | null = current.parentElement
    if (!parentEl) {
      path.unshift(tag)
      break
    }
    const siblings = Array.from(parentEl.children).filter(
      (candidate) => candidate.tagName.toLowerCase() === tag
    )
    const index = siblings.indexOf(current) + 1
    path.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`)
    current = parentEl
  }
  return path.join(" > ")
}

const getSelector = (element: HTMLElement) => {
  if (element.id) {
    const escapedId =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(element.id)
        : escapeCss(element.id)
    return `#${escapedId}`
  }

  const name = element.getAttribute("name")
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`
  }

  const dataTestId = element.getAttribute("data-testid")
  if (dataTestId) {
    return `${element.tagName.toLowerCase()}[data-testid="${dataTestId.replace(/"/g, '\\"')}"]`
  }

  return buildFallbackSelector(element)
}

const normalizeLabel = (value: string) => value.replace(/\s+/g, " ").trim()

const extractLabel = (element: HTMLElement) => {
  if (element.id) {
    const idValue = element.id.replace(/"/g, '\\"')
    const explicitLabel = document.querySelector<HTMLLabelElement>(
      `label[for="${idValue}"]`
    )
    if (explicitLabel?.textContent) {
      return normalizeLabel(explicitLabel.textContent)
    }
  }

  const wrappingLabel = element.closest("label")
  if (wrappingLabel?.textContent) {
    return normalizeLabel(wrappingLabel.textContent)
  }

  const ariaLabel = element.getAttribute("aria-label")
  if (ariaLabel) {
    return normalizeLabel(ariaLabel)
  }

  const parentLabel = element
    .closest("div, section, td, li, p, fieldset")
    ?.querySelector("label, legend, strong, span")
  if (parentLabel?.textContent) {
    return normalizeLabel(parentLabel.textContent)
  }

  return ""
}

const getFieldKind = (element: HTMLElement): FieldKind => {
  if (element instanceof HTMLTextAreaElement) {
    return "textarea"
  }
  if (element instanceof HTMLSelectElement) {
    return "select"
  }
  if (!(element instanceof HTMLInputElement)) {
    return "unknown"
  }
  switch (element.type) {
    case "email":
      return "email"
    case "tel":
      return "tel"
    case "url":
      return "url"
    case "number":
      return "number"
    case "checkbox":
      return "checkbox"
    case "radio":
      return "radio"
    case "date":
      return "date"
    case "text":
    case "search":
    case "password":
      return "text"
    default:
      return "unknown"
  }
}

const getFieldOptions = (element: HTMLElement): FieldOption[] => {
  if (element instanceof HTMLSelectElement) {
    return Array.from(element.options).map((option) => ({
      label: normalizeLabel(option.textContent ?? option.label ?? ""),
      value: option.value
    }))
  }

  if (element instanceof HTMLInputElement && element.type === "radio") {
    const radioName = element.name
    if (!radioName) {
      return []
    }
    const safeName = radioName.replace(/"/g, '\\"')
    const group = Array.from(
      document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${safeName}"]`)
    )
    return group.map((radio) => {
      const label = extractLabel(radio) || radio.value
      return { label, value: radio.value }
    })
  }

  return []
}

const getCurrentValue = (element: HTMLElement) => {
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox" || element.type === "radio") {
      return String(element.checked)
    }
    return element.value ?? ""
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    return element.value ?? ""
  }
  return ""
}

const shouldSkipField = (element: HTMLElement) => {
  if (!(element instanceof HTMLInputElement)) {
    return false
  }
  return ["hidden", "submit", "reset", "button", "image", "file"].includes(
    element.type
  )
}

export const extractFormSnapshot = (): FormSnapshot => {
  const rawFields = Array.from(
    document.querySelectorAll<HTMLElement>("input, textarea, select")
  )
  const fields: ExtractedField[] = rawFields
    .filter((field) => !shouldSkipField(field))
    .filter((field) => !field.hasAttribute("disabled"))
    .filter((field) => isVisible(field))
    .map((field, index) => {
      const label = extractLabel(field)
      const placeholder =
        field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
          ? field.placeholder ?? ""
          : ""
      return {
        id: `field-${index}`,
        selector: getSelector(field),
        kind: getFieldKind(field),
        label,
        name: field.getAttribute("name") ?? "",
        placeholder,
        required: field.hasAttribute("required"),
        options: getFieldOptions(field),
        currentValue: getCurrentValue(field)
      }
    })

  const navigationCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button, input[type='button'], input[type='submit'], a[role='button']"
    )
  )
  const navigationTargets: NavigationTarget[] = navigationCandidates
    .filter((button) => isVisible(button))
    .map((button, index) => {
      const buttonText =
        normalizeLabel(button.textContent ?? "") ||
        normalizeLabel(button.getAttribute("value") ?? "") ||
        normalizeLabel(button.getAttribute("aria-label") ?? "")
      return {
        id: `nav-${index}`,
        selector: getSelector(button),
        text: buttonText
      }
    })
    .filter((button) => NAVIGATION_REGEX.test(button.text))

  return {
    url: window.location.href,
    title: document.title,
    capturedAt: Date.now(),
    fields,
    navigationTargets,
    jobContext: extractJobContext()
  }
}
