import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dir = resolve(import.meta.dirname, '..', 'debug-requests')
const files = readdirSync(dir).filter(f => f.startsWith('req-') && f.endsWith('.json')).sort()
const target = resolve(dir, files[files.length - 1])
const req = JSON.parse(readFileSync(target, 'utf8'))
const body = { ...req.body, stream: true }

console.log('replaying', target)
console.log('tools', body.tools?.length, 'stream', body.stream)

const res = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
console.log('http', res.status)
const text = await res.text()
const lines = text.split('\n').filter(l => l.startsWith('data: '))
console.log('sse lines', lines.length)

let sawTool = false
let finish = null
let content = ''
const toolBits = []
for (const line of lines) {
  const p = line.slice(6).trim()
  if (p === '[DONE]') continue
  let obj
  try { obj = JSON.parse(p) } catch { continue }
  const d = obj.choices?.[0]?.delta || {}
  if (d.content) content += d.content
  if (d.tool_calls) {
    sawTool = true
    toolBits.push(d.tool_calls)
  }
  if (obj.choices?.[0]?.finish_reason) finish = obj.choices[0].finish_reason
  if (obj.error) console.log('error chunk', obj.error)
}
console.log('finish', finish)
console.log('sawTool', sawTool)
console.log('toolBits', JSON.stringify(toolBits).slice(0, 800))
console.log('content', JSON.stringify(content).slice(0, 800))
console.log('sample lines', lines.filter(l => l.includes('tool_calls') || l.includes('finish_reason') || l.includes('content')).slice(0, 8).join('\n').slice(0, 1200))
