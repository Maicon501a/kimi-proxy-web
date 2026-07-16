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

function isValidEmail(str) {
  return typeof str === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
}

export async function addAccount(existingRl) {
  const rl = existingRl || createInterface({ input: process.stdin, output: process.stdout })
  const ownsRl = !existingRl

  console.log('\n[+] Abrindo Chrome limpo (contexto efêmero)...')
  console.log('[+] Faça login na sua conta do Kimi no navegador que abrir.')
  console.log('[+] Quando logar, volte aqui e pressione ENTER para capturar.\n')

  chromium.use(stealth())

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ]
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  })

  const page = await context.newPage()

  const captured = {
    token: null,
    deviceId: null,
    sessionId: null,
    shieldData: null,
    trafficId: null,
    payload: null,
  }

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

    if (!captured.token) {
      captured.token = rawToken
      captured.payload = payload
      captured.deviceId = headers['x-msh-device-id'] || ''
      captured.sessionId = headers['x-msh-session-id'] || payload.ssid || ''
      captured.shieldData = headers['x-msh-shield-data'] || ''
      captured.trafficId = headers['x-traffic-id'] || payload.sub || ''
      console.log(`[!] JWT completo interceptado! sub=${payload.sub} Aguardando ENTER para salvar...`)
    }
  })

  try {
    await page.goto('https://www.kimi.com/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (e) {
    console.log('[!] Timeout na navegação inicial, continuando mesmo assim...')
  }

  await ask(rl, '\n>> Pressione ENTER após fazer login no Kimi: ')

  if (!captured.token) {
    console.log('[x] Nenhum JWT completo capturado. Navegue pelo Kimi (clique em chats, envie mensagens) para forçar requests autenticados com token completo.')
    await ask(rl, '>> Pressione ENTER após interagir com o Kimi: ')
  }

  if (!captured.token) {
    await browser.close()
    console.log('[x] Falha: nenhum JWT completo capturado. O token precisa ter claims "sub" e "ssid". Conta não adicionada.')
    if (ownsRl) rl.close()
    return false
  }

  const payload = captured.payload

  await browser.close()

  console.log('[*] JWT capturado. Email detectado automaticamente.\n')
  const email = payload.email || payload.sub || `user-${payload.sub}`
  const id = String(email).trim()

  const accounts = loadAccounts()
  const existingIdx = accounts.findIndex(a => a.id === id)

  const newAccount = {
    id,
    email: id,
    token: `Bearer ${captured.token}`,
    deviceId: captured.deviceId,
    sessionId: captured.sessionId,
    shieldData: captured.shieldData,
    trafficId: captured.trafficId,
    timezone: payload.region === 'overseas' || !payload.region ? 'America/Sao_Paulo' : 'UTC',
    jwtSub: payload.sub || null,
    createdAt: new Date().toISOString(),
    jwtExpiresAt: new Date(payload.exp * 1000).toISOString(),
  }

  if (existingIdx >= 0) {
    accounts[existingIdx] = newAccount
    console.log(`[+] Conta "${id}" atualizada.`)
  } else {
    accounts.push(newAccount)
    console.log(`[+] Conta "${id}" adicionada.`)
  }

  saveAccounts(accounts)
  console.log(`[+] Expira em: ${newAccount.jwtExpiresAt}`)

  if (ownsRl) rl.close()
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename || '')) {
  addAccount().catch(e => {
    console.error('Erro:', e.message)
    process.exit(1)
  })
}
