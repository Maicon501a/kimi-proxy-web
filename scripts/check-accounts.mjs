import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ACCOUNTS_FILE = resolve(import.meta.dirname, '..', 'accounts.json')

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return []
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.')
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload)
  } catch {
    return null
  }
}

async function validateAccount(account) {
  const url = 'https://www.kimi.com/apiv2/kimi.chat.v1.ChatService/ListChats'
  const headers = {
    'authorization': account.token,
    'content-type': 'application/json',
    'connect-protocol-version': '1',
    'x-msh-device-id': account.deviceId || '0',
    'x-msh-session-id': account.sessionId || '0',
    'x-msh-platform': 'web',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'origin': 'https://www.kimi.com',
    'referer': 'https://www.kimi.com/',
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ page_size: 1, query: '' }),
      signal: AbortSignal.timeout(15000),
    })

    const text = await res.text()
    return { status: res.status, ok: res.ok, preview: text.slice(0, 100) }
  } catch (e) {
    return { status: 0, ok: false, preview: e.message }
  }
}

export async function checkAccounts() {
  const accounts = loadAccounts()

  if (accounts.length === 0) {
    console.log('[x] Nenhuma conta cadastrada.')
    return []
  }

  const now = Date.now()
  const results = []

  console.log(`\n[+] Verificando ${accounts.length} conta(s)...\n`)

  for (const acc of accounts) {
    const payload = decodeJwtPayload(acc.token.replace('Bearer ', ''))
    const expMs = payload?.exp ? payload.exp * 1000 : null
    const expired = expMs ? expMs < now : null
    const daysLeft = expMs ? Math.floor((expMs - now) / 86400000) : null

    let status = 'UNKNOWN'
    let color = ''

    if (expired === true) {
      status = 'EXPIRADA'
      color = 'RED'
    } else {
      const result = await validateAccount(acc)
      if (result.status === 200) {
        status = 'OK'
        color = 'GREEN'
      } else if (result.status === 401 || result.status === 403) {
        status = `AUTH_FAIL (${result.status})`
        color = 'RED'
      } else {
        status = `ERROR ${result.status || 'net'}`
        color = 'YELLOW'
      }
    }

    const expInfo = daysLeft !== null ? ` | exp: ${daysLeft}d` : ''
    const emailInfo = acc.email ? ` | ${acc.email}` : ''
    console.log(`  [${status.padEnd(15)}] ${acc.id}${emailInfo}${expInfo}`)

    results.push({ id: acc.id, status, daysLeft, expired })
  }

  const ok = results.filter(r => r.status === 'OK').length
  const expired = results.filter(r => r.expired === true).length
  const failed = results.length - ok - expired

  console.log(`\n  Total: ${results.length} | OK: ${ok} | Expiradas: ${expired} | Falhas: ${failed}\n`)

  return results
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || '')) {
  checkAccounts().catch(e => {
    console.error('Erro:', e.message)
    process.exit(1)
  })
}
