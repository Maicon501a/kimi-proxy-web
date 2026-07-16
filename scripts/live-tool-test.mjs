import { readFileSync } from 'node:fs'
import { createProxyServer } from '../src/server.mjs'
import { AccountPool } from '../src/account-pool.mjs'

const ROO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace. Use this to inspect source files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path from workspace root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory of the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace root' },
          recursive: { type: 'boolean', description: 'Whether to list recursively' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute a shell command in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to run' },
        },
        required: ['command'],
      },
    },
  },
]

const FAKE_TOOL_RESULTS = {
  list_files: {
    path: '.',
    files: ['package.json', 'src/kimi-client.mjs', 'src/server.mjs', 'AGENTS.md', 'cli.mjs'],
  },
  read_file: {
    path: 'package.json',
    content: readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  },
  execute_command: {
    command: 'node -e "console.log(1+1)"',
    stdout: '2\n',
    exit_code: 0,
  },
}

function summarizeTools(toolCalls) {
  return (toolCalls || []).map(tc => {
    let args = tc.function?.arguments
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {}
    return {
      id: tc.id,
      name: tc.function?.name,
      arguments: args,
    }
  })
}

function mockToolResult(tc) {
  const name = tc.function.name
  let args = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}')
  } catch {}

  let result
  if (name === 'list_files') result = FAKE_TOOL_RESULTS.list_files
  else if (name === 'read_file') {
    if (String(args.path || '').includes('package.json')) result = FAKE_TOOL_RESULTS.read_file
    else result = { path: args.path, content: 'file not found in mock' }
  } else if (name === 'execute_command') result = FAKE_TOOL_RESULTS.execute_command
  else result = { error: 'unknown tool' }

  return {
    role: 'tool',
    tool_call_id: tc.id,
    name,
    content: JSON.stringify(result),
  }
}

async function callChat(baseUrl, body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

const pool = new AccountPool()
const { server } = createProxyServer({ port: 0, pool })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
const base = `http://127.0.0.1:${port}`
console.log('proxy on', base, 'accounts', pool.count)

try {
  console.log('\n========== TEST 1: non-stream tool call (list_files) ==========')
  const messages1 = [
    {
      role: 'system',
      content:
        'You are Roo, a coding agent. You MUST use tools to inspect the workspace. Never invent file contents. Prefer tools over guessing.',
    },
    {
      role: 'user',
      content:
        'List the files in the workspace root (path "."). Use the list_files tool. Do not answer without calling the tool first.',
    },
  ]

  const r1 = await callChat(base, {
    model: 'k3',
    stream: false,
    tools: ROO_TOOLS,
    tool_choice: 'required',
    messages: messages1,
  })
  console.log('status', r1.status)
  if (r1.json.error) {
    console.log('error', JSON.stringify(r1.json.error, null, 2))
  } else {
    const choice = r1.json.choices?.[0]
    console.log('finish_reason', choice?.finish_reason)
    console.log('content', JSON.stringify(choice?.message?.content || ''))
    console.log('tool_calls', JSON.stringify(summarizeTools(choice?.message?.tool_calls), null, 2))
  }

  console.log('\n========== TEST 2: full tool loop (list -> read package.json) ==========')
  const messages2 = [
    {
      role: 'system',
      content:
        'You are Roo Code agent. Always use tools for workspace inspection. When you have enough tool results, answer briefly with the package name and version from package.json.',
    },
    {
      role: 'user',
      content:
        'What is the name and version of this project? Use tools: first list_files on ".", then read_file on package.json. After tools return, give a one-line answer.',
    },
  ]

  const ra = await callChat(base, {
    model: 'k3',
    stream: false,
    tools: ROO_TOOLS,
    tool_choice: 'auto',
    messages: messages2,
  })
  console.log('turnA status', ra.status)
  if (ra.json.error) {
    console.log('turnA error', JSON.stringify(ra.json.error, null, 2))
  } else {
    const ca = ra.json.choices?.[0]
    console.log('turnA finish', ca?.finish_reason)
    console.log('turnA content', JSON.stringify(ca?.message?.content || '').slice(0, 300))
    const tcs = ca?.message?.tool_calls || []
    console.log('turnA tool_calls', JSON.stringify(summarizeTools(tcs), null, 2))

    if (tcs.length) {
      const assistantMsg = {
        role: 'assistant',
        content: ca.message.content || null,
        tool_calls: tcs,
      }
      const toolMsgs = tcs.map(mockToolResult)
      const messages2b = [...messages2, assistantMsg, ...toolMsgs]
      const onlyList = tcs.every(t => t.function.name === 'list_files')
      if (onlyList) {
        messages2b.push({
          role: 'user',
          content: 'Good. Now use read_file on package.json and then report name+version.',
        })
      }

      const rb = await callChat(base, {
        model: 'k3',
        stream: false,
        tools: ROO_TOOLS,
        tool_choice: 'auto',
        messages: messages2b,
      })
      console.log('turnB status', rb.status)
      if (rb.json.error) {
        console.log('turnB error', JSON.stringify(rb.json.error, null, 2))
      } else {
        const cb = rb.json.choices?.[0]
        console.log('turnB finish', cb?.finish_reason)
        console.log('turnB content', JSON.stringify(cb?.message?.content || '').slice(0, 500))
        console.log('turnB tool_calls', JSON.stringify(summarizeTools(cb?.message?.tool_calls), null, 2))

        const tcs2 = cb?.message?.tool_calls || []
        if (tcs2.length) {
          const assistantMsg2 = {
            role: 'assistant',
            content: cb.message.content || null,
            tool_calls: tcs2,
          }
          const toolMsgs2 = tcs2.map(mockToolResult)
          const rc = await callChat(base, {
            model: 'k3',
            stream: false,
            tools: ROO_TOOLS,
            tool_choice: 'auto',
            messages: [...messages2b, assistantMsg2, ...toolMsgs2],
          })
          console.log('turnC status', rc.status)
          if (rc.json.error) {
            console.log('turnC error', JSON.stringify(rc.json.error, null, 2))
          } else {
            const cc = rc.json.choices?.[0]
            console.log('turnC finish', cc?.finish_reason)
            console.log('turnC content', JSON.stringify(cc?.message?.content || '').slice(0, 500))
            console.log('turnC tool_calls', JSON.stringify(summarizeTools(cc?.message?.tool_calls), null, 2))
          }
        }
      }
    }
  }

  console.log('\n========== TEST 3: stream tool call (read_file) ==========')
  const resStream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'k3',
      stream: true,
      tools: ROO_TOOLS,
      tool_choice: 'required',
      messages: [
        { role: 'system', content: 'You are Roo. Always call tools; never invent file contents.' },
        { role: 'user', content: 'Read package.json using read_file tool. Call the tool now.' },
      ],
    }),
  })
  console.log('stream http', resStream.status)
  const sse = await resStream.text()
  const lines = sse.split('\n').filter(l => l.startsWith('data: '))
  let sawToolName = false
  let sawToolArgs = false
  let finish = null
  const toolNames = []
  for (const line of lines) {
    const payload = line.slice(6).trim()
    if (payload === '[DONE]') continue
    let obj
    try {
      obj = JSON.parse(payload)
    } catch {
      continue
    }
    const delta = obj.choices?.[0]?.delta || {}
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) {
          sawToolName = true
          toolNames.push(tc.function.name)
        }
        if (tc.function?.arguments) sawToolArgs = true
      }
    }
    if (obj.choices?.[0]?.finish_reason) finish = obj.choices[0].finish_reason
  }
  console.log('sse data lines', lines.length)
  console.log('stream tool names seen', toolNames)
  console.log('sawToolName', sawToolName, 'sawToolArgs', sawToolArgs, 'finish', finish)
  const interesting = lines
    .filter(l => l.includes('tool_calls') || l.includes('finish_reason'))
    .slice(0, 12)
  console.log('sample chunks:\n' + interesting.join('\n').slice(0, 1500))

  console.log('\n========== TEST 4: execute_command tool ==========')
  const r4 = await callChat(base, {
    model: 'k3',
    stream: false,
    tools: ROO_TOOLS,
    tool_choice: 'required',
    messages: [
      { role: 'system', content: 'You are Roo. Use execute_command for shell tasks.' },
      {
        role: 'user',
        content: 'Run this command with the execute_command tool: node -e "console.log(1+1)"',
      },
    ],
  })
  console.log('status', r4.status)
  if (r4.json.error) {
    console.log('error', JSON.stringify(r4.json.error))
  } else {
    const c4 = r4.json.choices?.[0]
    console.log('finish', c4?.finish_reason)
    console.log('content', JSON.stringify(c4?.message?.content || ''))
    console.log('tool_calls', JSON.stringify(summarizeTools(c4?.message?.tool_calls), null, 2))
  }
} finally {
  await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}
