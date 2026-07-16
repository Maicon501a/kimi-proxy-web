import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildChatBody, resolveModel, sendChat } from '../src/kimi-client.mjs'
import { parseConnectStream, extractContent, isStreamEnd } from '../src/stream-parser.mjs'
import { AccountPool } from '../src/account-pool.mjs'
import { buildCompleteOpenAIResponse } from '../src/response-translator.mjs'

const dir = resolve(import.meta.dirname, '..', 'debug-requests')
const files = readdirSync(dir)
  .filter(f => f.startsWith('req-') && f.endsWith('.json'))
  .sort()
const target = process.argv[2]
  ? resolve(dir, process.argv[2])
  : resolve(dir, files[files.length - 1])

const req = JSON.parse(readFileSync(target, 'utf8'))
const bodyIn = req.body
const tools = bodyIn.tools || []
const messages = bodyIn.messages
const chatBody = buildChatBody(messages, resolveModel('k3'), {
  tools,
  toolChoice: bodyIn.tool_choice || 'auto',
})
const prompt = chatBody.message.blocks[0].text.content
writeFileSync(resolve(dir, 'built-prompt.txt'), prompt)

console.log('file', target)
console.log('prompt length', prompt.length)
console.log('tools in request', tools.length)
console.log('tool_choice', bodyIn.tool_choice)
console.log('has TOOLS AVAILABLE', prompt.includes('TOOLS AVAILABLE'))
console.log('has FINAL REMINDER', prompt.includes('FINAL REMINDER'))
console.log('has glob tool', prompt.includes('"name": "glob"') || prompt.includes('"name":"glob"'))
console.log('--- prompt tail ---')
console.log(prompt.slice(-900))
const i = prompt.indexOf('TOOLS AVAILABLE')
console.log('--- tools section head ---')
console.log(prompt.slice(i, i + 500))

const pool = new AccountPool()
const acc = pool.acquire()
console.log('account', acc?.id)
const res = await sendChat(acc, chatBody)
console.log('http', res.status)
let full = ''
for await (const frame of parseConnectStream(res)) {
  if (isStreamEnd(frame)) break
  if (frame.error) console.log('err', frame.error)
  const ex = extractContent(frame)
  if (ex) {
    if (ex.op === 'set') full = ex.content
    else full += ex.content
  }
}
console.log('FULL', JSON.stringify(full).slice(0, 1000))
const out = buildCompleteOpenAIResponse('t', 'k3', full, tools)
console.log('finish', out.choices[0].finish_reason)
console.log('tool_calls', JSON.stringify(out.choices[0].message.tool_calls || [], null, 2).slice(0, 800))
console.log('content', JSON.stringify(out.choices[0].message.content || '').slice(0, 500))
