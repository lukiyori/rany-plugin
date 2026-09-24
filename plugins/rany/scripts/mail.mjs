#!/usr/bin/env node
/**
 * RANY mail: your persona sends mail from YOUR mailbox, with an app password you already made.
 *
 * The owner, after fighting a shell prompt: "ya rany plugin app passwordu olan bir gmail accountdan mail
 * atabilecek yeteneklere sahip olamaz mi? … onu da bir kullanici emaili karsiliginda saklasin ve email
 * gonderecegi zaman nereden gonderecegini bilsin."
 *
 * So: a password is stored AGAINST AN ADDRESS, and a send always names the address it goes out from.
 *
 *   node mail.mjs --setup you@gmail.com     # asks for the app password once, proves it, stores it
 *   node mail.mjs --list                    # which addresses are set up, which is the default
 *   node mail.mjs --forget you@gmail.com
 *   node mail.mjs                           # stdio MCP server: send_email, list_email_accounts
 *
 * The password never leaves this computer: it is not sent to RANY, and the MCP tools run HERE (a local
 * stdio server) rather than on the server, precisely so the secret stays local. Zero dependencies — SMTP
 * over TLS is spoken directly.
 *
 * Gmail copies anything sent through its own SMTP into "Sent Mail" by itself, so this deliberately does
 * NOT append a second copy over IMAP — that is how you end up with every sent mail listed twice.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect } from 'node:tls'
import { connect as netConnect } from 'node:net'
import { createInterface } from 'node:readline'

const stateDir = join(homedir(), '.rany-plugin')
const mailFile = join(stateDir, 'mail.json')

/** Known providers, so an address is enough to know where to connect. Anything else: pass --host/--port. */
const PROVIDERS = [
  { match: /@(gmail\.com|googlemail\.com)$/i, host: 'smtp.gmail.com', port: 465 },
  { match: /@(outlook\.com|hotmail\.com|live\.com)$/i, host: 'smtp-mail.outlook.com', port: 587 },
  { match: /@yahoo\.(com|co\.uk)$/i, host: 'smtp.mail.yahoo.com', port: 465 },
  { match: /@icloud\.com$/i, host: 'smtp.mail.me.com', port: 587 },
]
const providerFor = (email) => PROVIDERS.find((p) => p.match.test(email)) ?? null

// ── the store: one entry per address ─────────────────────────────────────────────────────────────
function load() {
  try { return JSON.parse(readFileSync(mailFile, 'utf8')) } catch { return { accounts: {}, default: null } }
}
function save(cfg) {
  mkdirSync(dirname(mailFile), { recursive: true })
  writeFileSync(mailFile, JSON.stringify(cfg, null, 2))
  // Owner-only where the OS honours it. On Windows this is a no-op, and the file sits in the user's
  // own profile — say so in the setup output rather than pretending otherwise.
  try { chmodSync(mailFile, 0o600) } catch { /* best effort */ }
}
const accountsOf = (cfg) => Object.keys(cfg.accounts ?? {})

/** The address a send goes out from: what was asked for, else the default, else the only one there is. */
function resolveFrom(cfg, wanted) {
  const names = accountsOf(cfg)
  if (wanted) {
    const hit = names.find((n) => n.toLowerCase() === String(wanted).trim().toLowerCase())
    return hit ? { from: hit } : { error: `no app password stored for ${wanted}. Set it up with /rany-mail.` }
  }
  if (cfg.default && names.includes(cfg.default)) return { from: cfg.default }
  if (names.length === 1) return { from: names[0] }
  if (names.length === 0) return { error: 'no mail account is set up yet. Run /rany-mail to add one.' }
  return { error: `several accounts are set up (${names.join(', ')}) — say which one to send from.` }
}

// ── SMTP, spoken directly ────────────────────────────────────────────────────────────────────────
/**
 * One SMTP conversation. Port 465 is implicit TLS; anything else starts plain and upgrades with STARTTLS
 * — and the upgrade REPLACES the stream, which is why everything below writes through `stream` rather
 * than closing over the first socket.
 *
 * `verifyOnly` stops after AUTH: proving an app password must not send mail to anyone.
 */
function smtpSend({ host, port, user, pass, from, to, cc, subject, body, replyTo, verifyOnly }) {
  return new Promise((resolve, reject) => {
    let stream = port === 465 ? connect({ host, port, servername: host }) : netConnect({ host, port })
    let upgraded = port === 465
    let buffer = ''
    const queue = []
    let done = false

    const finish = (err) => {
      if (done) return
      done = true
      try { stream.destroy() } catch { /* already gone */ }
      err ? reject(err) : resolve()
    }
    // A reply may span lines ("250-STARTTLS" … "250 SIZE"); only the last line of a code completes it.
    const pump = () => {
      let i
      while ((i = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        if (/^\d{3}-/.test(line)) continue
        const step = queue.shift()
        if (!step) continue
        const code = Number(line.slice(0, 3))
        if (step.codes.includes(code)) step.ok(line)
        else { step.bad(new Error(line.trim())); return finish(new Error(line.trim())) }
      }
    }
    const attach = (s2) => {
      s2.setEncoding('utf8')
      s2.setTimeout(30_000, () => finish(new Error('the mail server did not answer in time')))
      s2.on('data', (chunk) => { buffer += chunk; pump() })
      s2.on('error', finish)
    }
    attach(stream)

    const expect = (...codes) => new Promise((ok2, bad) => queue.push({ codes, ok: ok2, bad }))
    const say = (line) => stream.write(line + '\r\n')
    const b64 = (x) => Buffer.from(x, 'utf8').toString('base64')
    const ehlo = () => `EHLO ${hostnameOf(user)}`

    ;(async () => {
      try {
        await expect(220)
        say(ehlo())
        await expect(250)
        if (!upgraded) {
          say('STARTTLS')
          await expect(220)
          stream.removeAllListeners('data')
          stream.removeAllListeners('error')
          stream = await new Promise((ok2, bad) => {
            const secure = connect({ socket: stream, servername: host }, () => ok2(secure))
            secure.once('error', bad)
          })
          upgraded = true
          attach(stream)
          say(ehlo())
          await expect(250)
        }
        say('AUTH LOGIN')
        await expect(334)
        say(b64(user))
        await expect(334)
        say(b64(pass))
        await expect(235)
        if (verifyOnly) {
          say('QUIT')
          return finish(null)
        }
        say(`MAIL FROM:<${from}>`)
        await expect(250)
        for (const rcpt of [...to, ...(cc ?? [])]) {
          say(`RCPT TO:<${rcpt}>`)
          await expect(250, 251)
        }
        say('DATA')
        await expect(354)
        stream.write(message({ from, to, cc, subject, body, replyTo }))
        say('.')
        await expect(250)
        say('QUIT')
        finish(null)
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

const hostnameOf = (email) => email.split('@')[1] ?? 'localhost'
/** RFC 2047 for a header that is not plain ASCII — a Turkish subject is the normal case here. */
const headerWord = (s) => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`)

/** The message itself. Base64 body: no dot-stuffing, no line-length traps, UTF-8 intact. */
function message({ from, to, cc, subject, body, replyTo }) {
  const b64 = Buffer.from(body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')
  const lines = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(cc?.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${headerWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${hostnameOf(from)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
  ]
  return lines.join('\r\n') + '\r\n' + (b64.match(/.{1,76}/g) ?? []).join('\r\n') + '\r\n'
}

// ── setup / list / forget ────────────────────────────────────────────────────────────────────────
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s ?? '').trim())

/** The password is read from stdin (piped, or typed at the prompt) — never from argv, which would put it
 *  in shell history and in every process list on the machine. */
function askSecret(prompt) {
  if (!process.stdin.isTTY) {
    // Piped: take the first line.
    try {
      const fd = openSync('/dev/stdin', 'r')
      const buf = Buffer.alloc(4096)
      const n = readSync(fd, buf, 0, buf.length, null)
      closeSync(fd)
      return buf.toString('utf8', 0, n).split('\n')[0].trim()
    } catch {
      return readFileSync(0, 'utf8').split('\n')[0].trim()
    }
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    process.stdout.write(prompt)
    rl.question('', (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer.trim()) })
  })
}

async function setup(email, argv) {
  if (!isEmail(email)) {
    process.stdout.write('RANY mail: --setup needs the address the mail will come FROM (you@gmail.com)\n')
    return 1
  }
  const guess = providerFor(email)
  const host = argOf(argv, '--host') ?? guess?.host
  const port = Number(argOf(argv, '--port') ?? guess?.port ?? 0)
  if (!host || !port) {
    process.stdout.write(`RANY mail: I do not know the SMTP server for ${email} — pass --host and --port.\n`)
    return 1
  }
  const pass = (await askSecret(`App password for ${email} (it is not echoed): `)).replace(/\s+/g, '')
  if (!pass) { process.stdout.write('RANY mail: nothing entered, nothing stored.\n'); return 1 }

  // Prove it before storing it: a wrong app password must fail HERE, not in the middle of a conversation.
  try {
    await smtpVerify({ host, port, user: email, pass })
  } catch (e) {
    process.stdout.write(`RANY mail: ${host} refused that app password (${e.message}). Nothing stored.\n`)
    return 1
  }
  const cfg = load()
  cfg.accounts = cfg.accounts ?? {}
  cfg.accounts[email] = { password: pass, host, port, addedAt: new Date().toISOString() }
  if (!cfg.default || !cfg.accounts[cfg.default]) cfg.default = email
  save(cfg)
  process.stdout.write(
    `RANY mail: ${email} is set up (${host}:${port}) and is ${cfg.default === email ? 'the default sender' : 'available'}.\n`
    + `The app password is stored in ${mailFile}${process.platform === 'win32'
      ? ' (in your Windows profile; file permissions are not narrowed there)'
      : ' with owner-only permissions'} and never leaves this computer.\n`)
  return 0
}

/** AUTH and hang up: the shortest conversation that proves an app password, sending nothing. */
const smtpVerify = ({ host, port, user, pass }) =>
  smtpSend({ host, port, user, pass, from: user, to: [], verifyOnly: true })

const argOf = (argv, name) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null
}

// ── the MCP server ───────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'send_email',
    description: 'Send an email from the owner\'s own mailbox. `from` names which stored address it goes '
      + 'out from (omit it and the default is used). Gmail keeps its own copy in Sent. The app password '
      + 'lives on this computer and is never sent to RANY. Ask the owner before sending to anyone new.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses' },
        subject: { type: 'string', maxLength: 300 },
        body: { type: 'string', maxLength: 100000, description: 'Plain text' },
        cc: { type: 'array', items: { type: 'string' } },
        from: { type: 'string', description: 'Which stored address to send from; default when omitted' },
        replyTo: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_email_accounts',
    description: 'The addresses this computer can send mail from, and which is the default. No secrets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const ok = (id, text) => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
const toolError = (id, text) => write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } })

async function handle(msg) {
  const { id, method, params } = msg ?? {}
  if (method === 'initialize') {
    return write({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'rany-mail', version: '1.0.0' },
      },
    })
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method !== 'tools/call') {
    if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    return
  }

  const cfg = load()
  const args = params?.arguments ?? {}
  if (params?.name === 'list_email_accounts') {
    return ok(id, JSON.stringify({
      accounts: accountsOf(cfg).map((a) => ({ address: a, isDefault: a === cfg.default })),
    }))
  }
  if (params?.name !== 'send_email') return toolError(id, `unknown tool: ${params?.name}`)

  const { from, error } = resolveFrom(cfg, args.from)
  if (error) return toolError(id, error)
  const to = (Array.isArray(args.to) ? args.to : [args.to]).filter(isEmail)
  const cc = (Array.isArray(args.cc) ? args.cc : []).filter(isEmail)
  if (to.length === 0) return toolError(id, 'no valid recipient address')
  const subject = String(args.subject ?? '').slice(0, 300)
  const body = String(args.body ?? '')
  if (!body.trim()) return toolError(id, 'the message body is empty')

  const acct = cfg.accounts[from]
  try {
    await smtpSend({
      host: acct.host, port: acct.port, user: from, pass: acct.password,
      from, to, cc, subject, body, replyTo: isEmail(args.replyTo) ? args.replyTo : null,
    })
  } catch (e) {
    return toolError(id, `could not send from ${from}: ${e.message}`)
  }
  return ok(id, JSON.stringify({ sent: true, from, to, cc, subject }))
}

// ── entry ────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.includes('--setup')) {
  process.exit(await setup(argOf(argv, '--setup'), argv))
} else if (argv.includes('--list')) {
  const cfg = load()
  const names = accountsOf(cfg)
  process.stdout.write(names.length === 0
    ? 'RANY mail: no account set up yet. Run /rany-mail to add one.\n'
    : names.map((n) => `${n}${n === cfg.default ? '  (default sender)' : ''}`).join('\n') + '\n')
  process.exit(0)
} else if (argv.includes('--forget')) {
  const email = argOf(argv, '--forget')
  const cfg = load()
  if (!email || !cfg.accounts?.[email]) {
    process.stdout.write(`RANY mail: ${email ?? 'that address'} is not set up.\n`)
    process.exit(1)
  }
  delete cfg.accounts[email]
  if (cfg.default === email) cfg.default = accountsOf(cfg)[0] ?? null
  save(cfg)
  process.stdout.write(`RANY mail: ${email} removed. Revoke the app password in your mail account too.\n`)
  process.exit(0)
} else if (argv.includes('--default')) {
  const email = argOf(argv, '--default')
  const cfg = load()
  if (!email || !cfg.accounts?.[email]) { process.stdout.write('RANY mail: that address is not set up.\n'); process.exit(1) }
  cfg.default = email
  save(cfg)
  process.stdout.write(`RANY mail: mail now goes out from ${email} unless another one is named.\n`)
  process.exit(0)
} else {
  // stdio MCP server
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      void handle(msg)
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
