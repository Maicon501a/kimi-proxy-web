import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const PROJECT_ROOT = resolve(import.meta.dirname, '..')
const ACCOUNTS_FILE = resolve(PROJECT_ROOT, 'accounts.json')

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve))
}

function loadAccounts() {
  if (!existsSync(ACCOUNTS_FILE)) return []
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8'))
  } catch {
    return []
  }
}

function saveAccounts(list) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(list, null, 2))
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload)
  } catch {
    return null
  }
}

async function refreshOneAccount(account, browser, rl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  })

  const page = await context.newPage()
  const captured = {}

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  page.on('request', req => {
    const url = req.url()
    if (!url.includes('kimi.com/apiv2/')) return
    const headers = req.headers()
    const auth = headers['authorization'] || ''
    if (!auth.startsWith('Bearer ')) return

    const rawToken = auth.substring(7)
    const payload = decodeJwtPayload(rawToken)
    if (!payload || !payload.sub || !payload.ssid) return

    captured.token = rawToken
    captured.payload = payload
    captured.deviceId = headers['x-msh-device-id'] || captured.deviceId || ''
    captured.sessionId = headers['x-msh-session-id'] || payload.ssid || captured.sessionId || ''
    captured.shieldData = headers['x-msh-shield-data'] || captured.shieldData || ''
    captured.trafficId = headers['x-traffic-id'] || payload.sub || captured.trafficId || ''
  })

  try {
    await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch {}

  console.log(`\n  [REFRESH] ${account.id}`)
  console.log(`  >> Faça login com a conta "${account.email || account.id}" no navegador.`)
  console.log(`  >> Após logar e ver o chat carregado, pressione ENTER aqui.`)
  await ask(rl, '  >> ENTER quando pronto: ')

  if (!captured.token) {
    console.log(`  [x] Nenhum JWT completo capturado. Navegue pelo Kimi e pressione ENTER novamente.`)
    await ask(rl, '  >> ENTER: ')
  }

  await context.close()

  if (!captured.token) {
    console.log(`  [!] Falha ao capturar token para ${account.id}`)
    return null
  }

  const payload = captured.payload
  return {
    id: account.id,
    email: account.email || account.id,
    token: `Bearer ${captured.token}`,
    deviceId: captured.deviceId || account.deviceId,
    sessionId: captured.sessionId || payload.ssid || account.sessionId,
    shieldData: captured.shieldData || account.shieldData || '',
    trafficId: captured.trafficId || payload.sub || account.trafficId,
    timezone: payload.region === 'overseas' || !payload.region ? 'America/Sao_Paulo' : (account.timezone || 'UTC'),
    jwtSub: payload.sub || account.jwtSub || null,
    createdAt: account.createdAt || new Date().toISOString(),
    jwtExpiresAt: new Date(payload.exp * 1000).toISOString(),
  }
}

export async function refreshAccounts(existingRl) {
  const rl = existingRl || createInterface({ input: process.stdin, output: process.stdout })
  const ownsRl = !existingRl

  const accounts = loadAccounts()
  if (accounts.length === 0) {
    console.log('[x] Nenhuma conta cadastrada.')
    if (ownsRl) rl.close()
    return []
  }

  console.log(`\n[+] Refresh completo de ${accounts.length} conta(s) via Playwright...`)
  console.log('[+] Para cada conta, um navegador abrirá. Faça login e pressione ENTER.\n')

  chromium.use(stealth())

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ]
  })

  const results = []

  for (const acc of accounts) {
    const refreshed = await refreshOneAccount(acc, browser, rl)
    if (refreshed) {
      const idx = accounts.findIndex(a => a.id === acc.id)
      if (idx >= 0) accounts[idx] = refreshed
      results.push({ id: acc.id, status: 'REFRESHED' })
      console.log(`  [+] ${acc.id} atualizada com sucesso.`)
    } else {
      results.push({ id: acc.id, status: 'FAILED' })
    }
  }

  await browser.close()
  saveAccounts(accounts)

  const ok = results.filter(r => r.status === 'REFRESHED').length
  const failed = results.length - ok
  console.log(`\n  Resumo: ${results.length} conta(s) | Renovadas: ${ok} | Falhas: ${failed}\n`)

  if (ownsRl) rl.close()
  return results
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || '')) {
  refreshAccounts().catch(e => {
    console.error('Erro:', e.message)
    process.exit(1)
  })
}
