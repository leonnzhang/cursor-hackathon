import type { PlasmoCSConfig } from "plasmo"

import { bootFormAgent } from "~src/contents/form-agent"

export const config: PlasmoCSConfig = {
  matches: ["<all_urls>"],
  run_at: "document_idle",
  all_frames: false
}

bootFormAgent()
