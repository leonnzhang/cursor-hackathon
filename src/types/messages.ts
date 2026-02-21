import type { AgentAction, FormSnapshot } from "~src/types/agent"

export interface ExtractFormRequest {
  type: "agent.extractForm"
  whitelist: string[]
}

export interface ExecuteActionRequest {
  type: "agent.executeAction"
  whitelist: string[]
  action: AgentAction
}

export interface PingRequest {
  type: "agent.ping"
}

export type AgentRequest = ExtractFormRequest | ExecuteActionRequest | PingRequest

export type AgentResponse =
  | { ok: true; type: "agent.extractForm"; snapshot: FormSnapshot }
  | { ok: true; type: "agent.executeAction"; detail: string }
  | { ok: true; type: "agent.ping"; detail: string }
  | { ok: false; error: string }
