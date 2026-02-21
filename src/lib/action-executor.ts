import { getHostnameFromUrl, isWhitelistedHost } from "~src/config/whitelist"
import type { AgentAction } from "~src/types/agent"

const isVisible = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== "none" &&
    style.visibility !== "hidden"
  )
}

const queryElement = (selector: string) => {
  let element: HTMLElement | null = null
  try {
    element = document.querySelector(selector) as HTMLElement | null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (selector.startsWith("#") && selector.length > 1) {
      const rawId = selector.slice(1)
      element = document.getElementById(rawId)
    }
    if (!element) {
      throw new Error(`Invalid selector or element not found: ${msg}. Selector: ${selector}`)
    }
  }
  if (!element) {
    throw new Error(`Element not found for selector: ${selector}`)
  }
  if (!isVisible(element)) {
    throw new Error("Target element is not visible")
  }
  if ("disabled" in element && (element as HTMLInputElement).disabled) {
    throw new Error("Target element is disabled")
  }
  return element
}

const dispatchInputEvents = (element: HTMLElement) => {
  element.dispatchEvent(new Event("input", { bubbles: true }))
  element.dispatchEvent(new Event("change", { bubbles: true }))
}

const findRadioOptionByText = (name: string, targetValue: string) => {
  const safeName = name.replace(/"/g, '\\"')
  const radios = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${safeName}"]`
    )
  )
  const normalizedTarget = targetValue.trim().toLowerCase()
  return radios.find((radio) => {
    const linkedLabel = radio.id
      ? document.querySelector(`label[for="${radio.id}"]`)?.textContent ?? ""
      : radio.closest("label")?.textContent ?? ""
    return (
      radio.value.trim().toLowerCase() === normalizedTarget ||
      linkedLabel.trim().toLowerCase().includes(normalizedTarget)
    )
  })
}

/** Find role="radio" or clickable Yes/No option inside container */
const findClickableOptionByText = (
  container: HTMLElement,
  targetValue: string
): HTMLElement | null => {
  const normalizedTarget = targetValue.trim().toLowerCase()
  const candidates = container.querySelectorAll<HTMLElement>(
    '[role="radio"], button, [role="button"], [tabindex="0"]'
  )
  for (const el of candidates) {
    const text =
      el.getAttribute("aria-label") ??
      el.textContent ??
      el.getAttribute("data-value") ??
      ""
    const normalized = text.trim().toLowerCase()
    if (
      normalized === normalizedTarget ||
      normalized.includes(normalizedTarget) ||
      normalizedTarget.includes(normalized)
    ) {
      return el
    }
  }
  return null
}

export const executeAction = (action: AgentAction): string => {
  const element = queryElement(action.selector)

  switch (action.type) {
    case "setValue": {
      if (
        !(
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        )
      ) {
        throw new Error("setValue action needs an input or textarea target")
      }
      element.focus()
      element.value = action.value
      dispatchInputEvents(element)
      return `Filled ${action.fieldLabel}`
    }
    case "setSelect": {
      if (!(element instanceof HTMLSelectElement)) {
        throw new Error("setSelect action needs a select target")
      }
      const exactMatch = Array.from(element.options).find(
        (option) => option.value === action.value
      )
      const partialMatch = Array.from(element.options).find((option) =>
        option.label.toLowerCase().includes(action.value.toLowerCase())
      )
      const finalValue = exactMatch?.value ?? partialMatch?.value ?? ""
      if (!finalValue) {
        throw new Error("No matching option found for select")
      }
      element.value = finalValue
      dispatchInputEvents(element)
      return `Selected ${action.fieldLabel}`
    }
    case "setCheckbox": {
      if (!(element instanceof HTMLInputElement) || element.type !== "checkbox") {
        throw new Error("setCheckbox action needs a checkbox target")
      }
      const nextChecked = action.value === "true"
      element.checked = nextChecked
      dispatchInputEvents(element)
      return `${nextChecked ? "Checked" : "Unchecked"} ${action.fieldLabel}`
    }
    case "setRadio": {
      const isNativeRadio =
        element instanceof HTMLInputElement && element.type === "radio"

      if (isNativeRadio) {
        const target =
          findRadioOptionByText(element.name, action.value) ?? element
        target.checked = true
        dispatchInputEvents(target)
        return `Set ${action.fieldLabel}`
      }

      const container =
        element.getAttribute("role") === "radio"
          ? element.closest('[role="radiogroup"]') ?? element
          : element
      const clickableOption = findClickableOptionByText(
        container as HTMLElement,
        action.value
      )
      if (clickableOption) {
        clickableOption.click()
        dispatchInputEvents(clickableOption)
        return `Set ${action.fieldLabel} to ${action.value}`
      }

      throw new Error(
        "setRadio action needs a radio, radiogroup, or Yes/No button target"
      )
    }
    case "clickNext": {
      element.scrollIntoView({ block: "center", inline: "nearest" })
      element.click()
      return `Clicked ${action.fieldLabel || "Next"}`
    }
    default: {
      throw new Error("Unsupported action type")
    }
  }
}

export const ensureWhitelisted = (whitelist: string[], hostname?: string) => {
  const host = hostname ?? getHostnameFromUrl(window.location.href)
  if (!isWhitelistedHost(host, whitelist)) {
    throw new Error(`Domain is not in whitelist: ${host}`)
  }
}
