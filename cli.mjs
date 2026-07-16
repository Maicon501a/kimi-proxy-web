import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const PROJECT_ROOT = resolve(import.meta.dirname)
const ACCOUNTS_FILE = resolve(PROJECT_ROOT, 'accounts.json')

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

function printHeader() {
  console.log('\n' + '='.repeat(60))
  console.log('  PROXY KIMI - OpenAI Compatible (Node.js + fetch)')
  console.log('='.repeat(60))
}

function printAccounts() {
  const accounts = loadAccounts()
  const now = Date.now()

  console.log('\n  Contas cadastradas:')

  if (accounts.length === 0) {
    console.log('    (nenhuma) - use [a] para adicionar\n')
    return
  }

  console.log('    ' + '-'.repeat(56))
  for (const acc of accounts) {
    const payload = decodeJwtPayload(acc.token.replace('Bearer ', ''))
    const expMs = payload?.exp ? payload.exp * 1000 : null
    const daysLeft = expMs ? Math.floor((expMs - now) / 86400000) : null

    let statusTag = '?'
    if (daysLeft === null) statusTag = 'SEM_DATA'
    else if (daysLeft < 0) statusTag = 'EXPIRADA'
    else if (daysLeft < 3) statusTag = 'CRITICA'
    else if (daysLeft < 7) statusTag = 'BAIXA'
    else statusTag = 'ATIVA'

    const exp = daysLeft !== null ? `${daysLeft}d restantes` : 'desconhecido'
    console.log(`    [${statusTag.padEnd(8)}] ${acc.id}`)
    if (acc.email && acc.email !== acc.id) {
      console.log(`             email:  ${acc.email}`)
    }
    console.log(`             expira: ${exp}`)
  }
  console.log('    ' + '-'.repeat(56))
  console.log(`    Total: ${accounts.length}\n`)
}

function printMenu() {
  console.log('  Menu:')
  console.log('    [s] Start server')
  console.log('    [a] Add account (via Playwright)')
  console.log('    [l] List, check & refresh accounts (Playwright)')
  console.log('    [r] Reload accounts from disk')
  console.log('    [q] Quit')
  console.log()
}

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve))
}

function startServer(port) {
  const env = { ...process.env }
  if (port) {
    env.PORT = String(port)
  }

  const child = spawn(process.execPath, [resolve(PROJECT_ROOT, 'src', 'server.mjs')], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    detached: false,
    env,
  })

  child.on('exit', (code) => {
    console.log(`\n[i] Server encerrado com código ${code}`)
  })

  process.on('SIGINT', () => {
    child.kill('SIGINT')
  })
}

async function main() {
  let rl = createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    printHeader()
    printAccounts()
    printMenu()

    const choice = (await ask(rl, '  > ')).trim().toLowerCase()

    if (choice === 's') {
      console.log('\n[?] Deseja especificar uma porta personalizada para o servidor? (Deixe em branco para usar a porta padrão)')
      const portInput = (await ask(rl, '  Porta (ex: 8080): ')).trim()
      const port = portInput ? parseInt(portInput, 10) : null
      
      if (portInput && (isNaN(port) || port <= 0 || port > 65535)) {
        console.log('[x] Porta inválida. Usando porta padrão.')
      }

      rl.close()
      console.log(`\n[+] Iniciando servidor...`)
      startServer(port || undefined)
      return
    }

    if (choice === 'a') {
      const { addAccount } = await import('./scripts/add-account.mjs')
      await addAccount(rl)
      continue
    }

    if (choice === 'l') {
      const { checkAccounts } = await import('./scripts/check-accounts.mjs')
      await checkAccounts()
      console.log('\n[i] Iniciando refresh completo via Playwright...')
      const { refreshAccounts } = await import('./scripts/refresh-accounts.mjs')
      await refreshAccounts(rl)
      await ask(rl, '\n  Pressione ENTER para voltar ao menu...')
      continue
    }

    if (choice === 'r') {
      const accounts = loadAccounts()
      console.log(`[+] ${accounts.length} conta(s) carregada(s) do disco.`)
      continue
    }

    if (choice === 'q' || choice === '') {
      rl.close()
      console.log('Bye!')
      return
    }

    console.log('[?] Opção inválida.')
  }
}

main().catch(e => {
  console.error('Erro:', e.message)
  process.exit(1)
})
