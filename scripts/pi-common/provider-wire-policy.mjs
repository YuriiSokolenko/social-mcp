// Pure outbound provider request and error-status policy for Main and coding sessions.
// Kept independent of runtime state, hooks, agent registration and provider IO.
// pi-agent-runtime.mjs re-exports these helpers to preserve its existing public API.
import { providerToolNames } from './session-state.mjs';

// Laguna (llama-server, openai-completions) reasons by default once tools are present, and pi's
// "off" level sends no reasoning field for this provider's compat. This pure wire
// policy keeps normal/creation requests off, while the first request after an
// authoritative validation failure may opt into bounded reasoning before returning to low overhead.
export function applyCodingThinkingPolicy(payload, { enableThinking = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages)) return payload;
  return {
    ...payload,
    chat_template_kwargs: { ...(payload.chat_template_kwargs ?? {}), enable_thinking: enableThinking === true },
  };
}

export function disableThinkingInPayload(payload) {
  return applyCodingThinkingPolicy(payload, { enableThinking: false });
}

// The action-required invariant is derived at the final provider wire boundary. A valid tool
// call never disarms it: only authoritative state, the actually serialized tool surface, or a
// bounded provider 400/422 compatibility fallback can change the effective choice.
export function requireToolChoiceInPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.tools) || payload.tools.length === 0) {
    return payload;
  }
  return { ...payload, tool_choice: 'required' };
}

// An empty Pi executor surface must never emit tool_choice alongside missing/empty tools:
// OpenAI-compatible providers may reject that shape before the local safety gates run.
export function withoutProviderTools(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const { tools, tool_choice, ...rest } = payload;
  return rest;
}

// Pure wire policy, shared by Main and delegated coding sessions. Never infer executability
// from getActiveTools(): only definitions actually serialized in payload.tools can be called.
export function implementerToolChoiceDecision(payload, {
  productiveState,
  correctionSource = null,
  exemption = null,
} = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tools)) {
    return { payload, toolChoice: payload?.tool_choice ?? null, source: null, exemption: 'no_serialized_tool_surface' };
  }
  const executableTools = providerToolNames(payload);
  if (executableTools.length === 0) {
    return {
      payload: withoutProviderTools(payload),
      toolChoice: null, source: null, exemption: 'zero_executable_tools',
    };
  }
  // Preserve a stronger explicit named-tool constraint, but reject a stale constraint rather
  // than advertising a tool that is absent from the serialized Pi executor snapshot.
  const namedTool = payload.tool_choice && typeof payload.tool_choice === 'object'
    ? payload.tool_choice.function?.name ?? payload.tool_choice.name ?? null
    : null;
  if (namedTool) {
    if (!executableTools.includes(namedTool)) {
      return {
        payload: withoutProviderTools(payload),
        toolChoice: null, source: null, exemption: 'named_tool_not_executable',
      };
    }
    return { payload, toolChoice: payload.tool_choice, source: 'named_tool', exemption: null };
  }
  if (exemption) {
    // An HTTP 400/422 compatibility continuation gets exactly one auto-choice request;
    // it does not change the productive state or make later requests optional.
    const next = { ...payload, tool_choice: 'auto' };
    return { payload: next, toolChoice: 'auto', source: null, exemption };
  }
  const source = correctionSource ??
    (productiveState === 'action_required' ? 'productive_action' : null);
  if (source) {
    const next = requireToolChoiceInPayload(payload);
    return { payload: next, toolChoice: next.tool_choice, source, exemption: null };
  }
  return { payload, toolChoice: payload.tool_choice ?? 'auto', source: null, exemption: productiveState === 'evidence_allowed' ? 'evidence_allowed' : 'non_action_state' };
}

export function retryableProviderErrorStatus(status) {
  return status == null || status === 408 || status === 429 || status >= 500;
}

export function providerErrorStatus(message) {
  if (message?.stopReason !== 'error') return null;

  const structuredCandidates = [
    message?.status,
    message?.statusCode,
    message?.error?.status,
    message?.error?.statusCode,
  ];
  for (const candidate of structuredCandidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }

  const text = String(message?.errorMessage ?? '').trim();
  // openai-completions surfaces OpenAI SDK Error.message strings such as
  // "400: <body>", "400 <json-body>", "400 status code (no body)", or
  // "BadRequestError: 422 ...". Keep this intentionally narrow: arbitrary prose such as
  // "Maximum context: 400 tokens" or "500 tokens exceeded" is not an HTTP status.
  const sdkMatch =
    /^(?:([45]\d{2})(?::(?:\s|$)|\s+(?=(?:status code\b|[\[{])))|[A-Za-z_$][\w.$]*Error:\s*([45]\d{2})(?=[:\s]|$))/.exec(text);
  if (sdkMatch) return Number(sdkMatch[1] ?? sdkMatch[2]);

  // openai-responses / azure-openai-responses / mistral use Pi's explicit API-error prefix.
  const apiMatch = /\bAPI error \((\d{3})\):/.exec(text);
  if (apiMatch) return Number(apiMatch[1]);

  return null;
}
