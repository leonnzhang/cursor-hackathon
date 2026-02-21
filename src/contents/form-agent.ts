import { getHostnameFromUrl, isWhitelistedHost } from "~src/config/whitelist"
import { extractFormSnapshot } from "~src/lib/form-extractor"
import type { AgentAction } from "~src/types/agent"
import type { AgentRequest, AgentResponse } from "~src/types/messages"

declare global {
  interface Window {
    __agenticAutofillInitialized?: boolean
  }
}

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

const ensureWhitelisted = (whitelist: string[]) => {
  const hostname = getHostnameFromUrl(window.location.href)
  if (!isWhitelistedHost(hostname, whitelist)) {
    throw new Error(`Domain is not in whitelist: ${hostname}`)
  }
}

const queryElement = (selector: string) => {
  const element = document.querySelector(selector) as HTMLElement | null
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
    document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${safeName}"]`)
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

const executeAction = (action: AgentAction) => {
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
      if (!(element instanceof HTMLInputElement) || element.type !== "radio") {
        throw new Error("setRadio action needs a radio target")
      }
      const target = findRadioOptionByText(element.name, action.value) ?? element
      target.checked = true
      dispatchInputEvents(target)
      return `Set ${action.fieldLabel}`
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

const handleMessage = async (message: AgentRequest): Promise<AgentResponse> => {
  switch (message.type) {
    case "agent.ping":
      return { ok: true, type: "agent.ping", detail: "form-agent-ready" }
    case "agent.extractForm":
      ensureWhitelisted(message.whitelist)
      return {
        ok: true,
        type: "agent.extractForm",
        snapshot: extractFormSnapshot()
      }
    case "agent.executeAction":
      ensureWhitelisted(message.whitelist)
      return {
        ok: true,
        type: "agent.executeAction",
        detail: executeAction(message.action)
      }
    default:
      return { ok: false, error: "Unknown message type" }
  }
}

export const bootFormAgent = () => {
  if (window.__agenticAutofillInitialized) {
    return
  }
  window.__agenticAutofillInitialized = true

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message as AgentRequest)
      .then((response) => sendResponse(response))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown content error"
        } satisfies AgentResponse)
      )
    return true
  })
}

bootFormAgent()
