# Proxy Tool Calling Rules

This repository exists to proxy and translate model tool calls for OpenAI-compatible clients.

## Real Actions Only

- Never claim that files were created, edited, inspected, or verified unless the corresponding tool was actually invoked and succeeded.
- Never narrate an intended internal workflow as if it already happened.
- If tool access is unavailable, denied, or missing, say that explicitly instead of simulating the result.

## Tool-First Behavior

- For requests that require reading files, searching code, editing files, running commands, or fetching URLs, use real tool calls before giving a completion summary.
- Prefer immediate tool usage over explanatory preambles when the user is asking for action rather than discussion.
- When tool results are required before continuing, stop after issuing the needed tool calls and continue only from actual results.

## Proxy-Specific Goal

- Favor behavior that makes external tool use visible and machine-readable to the client.
- Do not replace real tool calls with prose such as "vou verificar", "criei os arquivos", or similar statements unless those actions were actually executed.
