#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { unlinkSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const HOME_DIR = join(homedir(), '.ttyfm')
const JSON_PATH = resolve(process.argv[2] ?? join(HOME_DIR, 'streams.json'))
const MEDIAKEYS_LUA = join(here, 'mediakeys.lua')

const WIN_MPV_PATHS = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MPV Player', 'mpv.exe'),
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'mpv', 'mpv.exe'),
  join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'mpv', 'mpv.exe'),
  join(process.env.LOCALAPPDATA ?? homedir(), 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
  join(homedir(), 'scoop', 'shims', 'mpv.exe'),
  join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'mpv.exe'),
]
let MPV_BIN = 'mpv'

let socketSeq = 0
const nextSocketPath = () =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\ttyfm-mpv-${process.pid}-${++socketSeq}`
    : join(tmpdir(), `ttyfm-mpv-${process.pid}-${++socketSeq}.sock`)

const MIN_POLL = 10_000
const MAX_POLL = 45_000
const POLL_SLACK = 2_000
const STALE_POLL = 6_000
const BREAK_GRACE = 25

const SLEEP_GAP = 5_000

const STALL_MS = 8_000
const STANDBY_TIMEOUT = 12_000
const LIVE_TARGET = 2
const LIVE_TRIM_ABOVE = 4
const SWAP_FADE_MS = 300
const PAUSE_FADE_MS = 350
const BACKOFF_BASE = 500
const BACKOFF_MAX = 15_000
const NOTE_MS = 6_000

const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? '')
const rgb = (r, g, b) => (truecolor ? `\x1b[38;2;${r};${g};${b}m` : '')
const C = {
  accent: truecolor ? rgb(215, 119, 86) : '\x1b[33m',
  accentDim: truecolor ? rgb(160, 88, 64) : '\x1b[33m',
  text: truecolor ? rgb(235, 231, 225) : '',
  dim: truecolor ? rgb(154, 153, 153) : '\x1b[2m',
  bold: '\x1b[1m',
  italic: '\x1b[3m',
  yellow: truecolor ? rgb(255, 192, 2) : '\x1b[33m',
  select: truecolor ? rgb(177, 184, 249) : '\x1b[36m',
  purple: truecolor ? rgb(175, 135, 254) : '\x1b[35m',
  green: truecolor ? rgb(75, 187, 101) : '\x1b[32m',
  red: truecolor ? rgb(255, 108, 128) : '\x1b[31m',
  reset: '\x1b[0m',
}

const EQ_AF = '@eq:lavfi=[astats=metadata=1:reset=1,aspectralstats=win_size=2048]'

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const spinnerFrame = () => SPINNER[Math.floor(Date.now() / 120) % SPINNER.length]

const AUDIO_MODES = [
  { name: 'normal', af: null },
  { name: 'bass', af: '@mode:lavfi=[bass=g=8:f=110,alimiter=limit=0.95]' },
  { name: 'rave', af: '@mode:lavfi=[bass=g=16:f=90:w=0.7,treble=g=8:f=6000,acompressor=ratio=12:attack=2:release=80:makeup=10dB,acrusher=bits=8:mode=log:mix=0.35,volume=6dB,alimiter=limit=0.95]' },
  { name: 'night', af: '@mode:lavfi=[acompressor=ratio=4:attack=200:release=1000:makeup=4dB,alimiter=limit=0.95]' },
]

const EQ_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
const EQ_BARS = 14
const eqLevels = new Array(EQ_BARS).fill(0)
let eqPos = EQ_BARS / 2
let eqSig = 2.5
function eqFrame() {
  const t = Date.now() / 1000
  const fresh = primary && !state.paused && Date.now() - primary.levelAt < 600
  const rms = fresh ? Math.max(0, Math.min(1, (primary.rmsDb + 45) / 45)) : 0
  const peak = fresh ? Math.max(0, Math.min(1, (primary.peakDb + 45) / 45)) : 0
  const energy = Math.max(rms, peak * 0.7)
  const spectral = fresh && primary.centroid
  if (spectral) {
    const logPos = Math.log(Math.max(80, Math.min(8000, primary.centroid)) / 80) / Math.log(100)
    eqPos += (logPos * (EQ_BARS - 1) - eqPos) * 0.25
    const spread = primary.spreadHz ? Math.max(1.4, Math.min(5.5, Math.log1p(primary.spreadHz / 90))) : 2.5
    eqSig += (spread - eqSig) * 0.2
  }
  let s = ''
  for (let i = 0; i < EQ_BARS; i++) {
    let target
    if (spectral) {
      const shape = Math.exp(-((i - eqPos) ** 2) / (2 * eqSig * eqSig))
      const shimmer = 0.85 + 0.15 * Math.sin(t * (5.3 + i * 0.37) + i * 2.11)
      target = energy * (0.25 + 0.75 * shape) * shimmer
    } else {
      const wave =
        0.5 +
        0.3 * Math.sin(t * (1.1 + i * 0.41) + i * 2.39) +
        0.2 * Math.sin(t * (2.3 + i * 0.19) + i * 1.07)
      target = energy * wave
    }
    eqLevels[i] += (target - eqLevels[i]) * (target > eqLevels[i] ? 0.75 : 0.3)
    s += EQ_GLYPHS[Math.max(0, Math.min(7, Math.round(eqLevels[i] * 7)))]
  }
  return s
}

const VERBS = [
  'Tuning', 'Bopping', 'Riffing', 'Syncopating', 'Vibing',
  'Warming the valves', 'Chasing the signal', 'Untangling airwaves',
  'Aligning antennae', 'Coaxing electrons',
]
const pickVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)]

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'" }
const decode = (s = '') =>
  s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .trim()

const mmss = (secs) => {
  const s = Math.max(0, Math.round(secs))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const clip = (s, width) => (s.length <= width ? s : `${s.slice(0, Math.max(0, width - 1))}…`)

const hostOf = (url = '') => url.replace(/^https?:\/\//, '').split('/')[0].split('.')[0]

const mpvVol = (v) => Math.round(v * 1.3)

const fmtAgo = (iso) => {
  const ms = Date.now() - new Date(iso)
  if (ms < 3_600_000) return `${Math.max(1, Math.floor(ms / 60000))}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

const fmtDur = (ms) => {
  const m = Math.floor(ms / 60000)
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`
}

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length

const rowFit = (left, rights, width) => {
  for (const r of rights) {
    const gap = width - visible(left) - visible(r)
    if (gap >= 1) return left + ' '.repeat(gap) + r
  }
  return left
}

class Mpv {
  #proc = null
  #sock = null
  #onExit = null
  #onProperty = null
  #rx = ''
  #socketPath = null
  #onReady = null

  #onMessage = null

  constructor({ onExit, onProperty, onReady, onMessage }) {
    this.#onExit = onExit
    this.#onProperty = onProperty
    this.#onReady = onReady
    this.#onMessage = onMessage
  }

  get connected() {
    return Boolean(this.#sock?.writable)
  }

  send(command) {
    return this.#send(command)
  }

  start(url, { volume = 100, paused = false, modeAf = null, analyze = true } = {}) {
    this.#socketPath = nextSocketPath()
    this.#proc = spawn(
      MPV_BIN,
      [
        '--no-video',
        '--really-quiet',
        '--no-terminal',
        '--idle=no',
        `--input-ipc-server=${this.#socketPath}`,
        '--cache=yes',
        '--cache-secs=20',
        `--volume=${volume}`,
        ...(paused ? ['--pause'] : []),
        ...(analyze ? [`--af=${EQ_AF}${modeAf ? `,${modeAf}` : ''}`] : []),
        `--script=${MEDIAKEYS_LUA}`,
        '--network-timeout=8',
        url,
      ],
      { stdio: 'ignore' },
    )
    this.#proc.on('error', () => {
      this.#proc = null
      this.#cleanSocket()
      this.#onExit?.('spawn-failed')
    })
    this.#proc.on('exit', (code) => {
      this.#sock?.destroy()
      this.#sock = null
      this.#proc = null
      this.#cleanSocket()
      this.#onExit?.(code)
    })
    this.#connect()
  }

  #cleanSocket() {
    if (!this.#socketPath) return
    try {
      unlinkSync(this.#socketPath)
    } catch {}
    this.#socketPath = null
  }

  #connect(attempt = 0) {
    if (!this.#proc || !this.#socketPath) return
    const sock = createConnection(this.#socketPath)
    sock.on('connect', () => {
      this.#sock = sock
      this.#send(['observe_property', 1, 'demuxer-cache-duration'])
      this.#send(['observe_property', 2, 'paused-for-cache'])
      this.#send(['observe_property', 3, 'time-pos'])
      this.#send(['observe_property', 4, 'af-metadata/eq'])
      this.#send(['observe_property', 5, 'pause'])
      this.#send(['observe_property', 6, 'metadata'])
      this.#onReady?.(true)
    })
    sock.on('error', () => {
      sock.destroy()
      if (attempt < 25 && this.#proc) setTimeout(() => this.#connect(attempt + 1), 120)
      else if (this.#proc) this.#onReady?.(false)
    })
    sock.on('data', (chunk) => this.#ingest(chunk))
  }

  #ingest(chunk) {
    this.#rx += chunk.toString()
    const lines = this.#rx.split('\n')
    this.#rx = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.event === 'property-change') this.#onProperty?.(msg.name, msg.data)
      else if (msg.event === 'client-message' && msg.args?.[0] === 'ttyfm-station') {
        this.#onMessage?.(msg.args[1])
      }
    }
  }

  #send(command) {
    if (!this.#sock?.writable) return false
    this.#sock.write(`${JSON.stringify({ command })}\n`)
    return true
  }

  setPause(paused) {
    return this.#send(['set_property', 'pause', paused])
  }

  setVolume(vol) {
    return this.#send(['set_property', 'volume', vol])
  }

  seek(secs) {
    return this.#send(['seek', secs, 'relative'])
  }

  stop() {
    this.#onExit = null
    this.#onReady = null
    this.#onProperty = null
    this.#onMessage = null
    this.#sock?.destroy()
    this.#sock = null
    this.#proc?.kill('SIGTERM')
    this.#proc = null
    this.#cleanSocket()
  }
}

function spawnPlayer(url, { volume, paused, station, analyze = true }) {
  const p = {
    url,
    station: station ?? state.station,
    mpv: null,
    ipcReady: false,
    dead: false,
    pausedProp: paused,
    cacheSeconds: 0,
    buffering: false,
    bufferingSince: 0,
    pos: null,
    firstPos: null,
    progressed: false,
    ipcFailed: false,
    lastProgressAt: Date.now(),
    lastTrimAt: 0,
    rmsDb: -90,
    peakDb: -90,
    centroid: null,
    spreadHz: null,
    levelAt: 0,
    icyTitle: null,
    icyName: null,
    icyAt: 0,
    onDeath: null,
    onProgress: null,
  }
  p.mpv = new Mpv({
    onExit: (code) => {
      p.dead = true
      p.onDeath?.(code)
    },
    onProperty: (name, value) => {
      if (name === 'demuxer-cache-duration' && typeof value === 'number') {
        p.cacheSeconds = value
      } else if (name === 'paused-for-cache') {
        p.buffering = Boolean(value)
        p.bufferingSince = p.buffering ? Date.now() : 0
      } else if (name === 'time-pos' && typeof value === 'number') {
        if (p.firstPos === null || value < p.firstPos) p.firstPos = value
        if (p.pos !== null && value > p.pos) p.lastProgressAt = Date.now()
        if (value - p.firstPos >= 0.5 && !p.progressed) {
          p.progressed = true
          p.onProgress?.()
        }
        p.pos = value
      } else if (name === 'af-metadata/eq' && value && typeof value === 'object') {
        const num = (k) => {
          const v = parseFloat(value[k])
          return Number.isFinite(v) ? v : null
        }
        p.rmsDb = num('lavfi.astats.Overall.RMS_level') ?? -90
        p.peakDb = num('lavfi.astats.Overall.Peak_level') ?? -90
        const cs = [num('lavfi.aspectralstats.1.centroid'), num('lavfi.aspectralstats.2.centroid')].filter(
          (x) => x !== null && x > 0,
        )
        if (cs.length) p.centroid = cs.reduce((a, b) => a + b) / cs.length
        const sp = [num('lavfi.aspectralstats.1.spread'), num('lavfi.aspectralstats.2.spread')].filter(
          (x) => x !== null && x > 0,
        )
        if (sp.length) p.spreadHz = sp.reduce((a, b) => a + b) / sp.length
        p.levelAt = Date.now()
      } else if (name === 'metadata' && value && typeof value === 'object') {
        const pick = (k) => {
          const hit = Object.keys(value).find((n) => n.toLowerCase() === k)
          return hit ? String(value[hit]) : null
        }
        const title = pick('icy-title')
        p.icyName = pick('icy-name') ?? p.icyName
        if (title !== null && title !== p.icyTitle) {
          p.icyTitle = title
          p.icyAt = Date.now()
          onIcyMeta(p)
        }
      } else if (name === 'pause' && typeof value === 'boolean') {
        p.pausedProp = value
        if (p === primary) {
          const now = Date.now()
          while (expectedPause.length && now - expectedPause[0].at > 1000) expectedPause.shift()
          if (expectedPause.length && expectedPause[0].v === value) {
            expectedPause.shift()
          } else if (value !== state.paused) {
            externalPauseSync(value)
          } else if (value && now < danceUntil) {
            externalPauseSync(false)
          }
        }
      }
    },
    onReady: (ok) => {
      p.ipcReady = ok
      p.ipcFailed = !ok
      render()
    },
    onMessage: (dir) => mediaStation(dir),
  })
  p.mpv.start(url, { volume: mpvVol(volume), paused, modeAf: currentModeAf(), analyze })
  return p
}

const isHealthy = (p) =>
  Boolean(p) && !p.dead && p.ipcReady && (state.paused ? p.cacheSeconds >= 2 : p.progressed && p.cacheSeconds >= 1)

const book = {
  entries: [],

  load(urls) {
    this.entries = urls.map((url) => ({ url, fails: 0, lastUsedAt: 0, latency: Infinity }))
  },

  fail(url) {
    const e = this.entries.find((e) => e.url === url)
    if (e) e.fails++
  },

  ok(url) {
    const e = this.entries.find((e) => e.url === url)
    if (e) e.fails = 0
  },

  pick(excludeUrl) {
    const pool = this.entries.filter((e) => e.url !== excludeUrl)
    const from = pool.length ? pool : this.entries
    const best = [...from].sort(
      (a, b) => a.fails - b.fails || a.latency - b.latency || a.lastUsedAt - b.lastUsedAt,
    )[0]
    best.lastUsedAt = Date.now()
    return best.url
  },
}

function probeMirrors() {
  for (const e of book.entries) {
    ;(async () => {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 5000)
      const t0 = Date.now()
      try {
        const res = await fetch(e.url, { signal: ac.signal, headers: { 'User-Agent': 'ttyfm' } })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await res.body.getReader().read()
        e.latency = Date.now() - t0
      } catch {
        e.latency = Infinity
      } finally {
        clearTimeout(timer)
        ac.abort()
      }
    })()
  }
}

const state = {
  paused: false,
  muted: false,
  volume: 80,
  tracks: [],
  fetchedAt: 0,
  error: null,
  verb: pickVerb(),
  note: null,
  noteAt: 0,
  swapping: false,
  rejoining: false,
  warming: null,
  swapStartedAt: 0,
  failStreak: 0,
  hops: 0,
  showHelp: false,
  showFavs: false,
  favScroll: 0,
  favCursor: 0,
  showWrapped: false,
  wrapScroll: 0,
  showHistory: false,
  histCursor: 0,
  histScroll: 0,
  showRadios: false,
  radioCursor: 0,
  station: null,
  ducked: false,
  duckApplied: null,
  showSettings: false,
  settingsCursor: 0,
  showDiscover: false,
  discQuery: '',
  discResults: [],
  discCursor: 0,
  discScroll: 0,
  discBusy: false,
  discError: null,
  discRan: false,
  pausedSince: 0,
  pausedAt: 0,
  pausedTotal: 0,
  pausedCacheSnap: 0,
}

let stations = []
let primary = null
let standby = null

const parkMs = () => ({ '2m': 120_000, '10m': 600_000, forever: Infinity })[settings.keepWarm] ?? 120_000
const PARK_SLOTS = 3
let parkedList = []

function unparkEntry(entry, { stop = true } = {}) {
  clearTimeout(entry.timer)
  parkedList = parkedList.filter((e) => e !== entry)
  if (stop) entry.player.mpv.stop()
}

function dropParked() {
  for (const e of [...parkedList]) unparkEntry(e)
}

function parkedFor(st) {
  return parkedList.find((e) => e.player.station === st && !e.player.dead) ?? null
}

function parkPlayer(p, { evict = true } = {}) {
  const existing = parkedList.find((e) => e.player.station === p.station)
  if (existing) unparkEntry(existing)
  if (evict) {
    const organic = () => parkedList.filter((e) => e.kind === 'organic')
    while (organic().length >= PARK_SLOTS) unparkEntry(organic()[0])
  }
  p.onDeath = null
  p.mpv.send(['af', 'remove', '@eq'])
  p.mpv.send(['af', 'remove', '@mode'])
  const ms = parkMs()
  const entry = { player: p, until: Date.now() + ms, timer: null, kind: evict ? 'organic' : 'warm' }
  if (Number.isFinite(ms)) entry.timer = setTimeout(() => unparkEntry(entry), ms)
  parkedList.push(entry)
}

const stationNow = new Map()
let stationNowAt = 0
let stationNowBusy = false

function refreshStationNow() {
  if (stationNowBusy) return
  stationNowBusy = true
  stationNowAt = Date.now()
  Promise.all(
    stations.map(async (st) => {
      const res = await fetchPlaylistFor(st)
      if (res.error || res.icy) return
      const cur = res.tracks.find((t) => t.order === 0)
      const onBreak = Boolean(cur && (isJingle(cur) || cur.uptime < -BREAK_GRACE))
      let resumeAt = null
      if (onBreak) {
        const nxt = res.tracks.find((t) => t.order > 0 && !isJingle(t))
        if (nxt) resumeAt = Date.now() + (nxt.uptime - (Number(nxt.lenght) || 0)) * 1000
      }
      stationNow.set(st.uid, {
        track: cur && !onBreak ? { title: cur.title, author: cur.author } : null,
        onBreak,
        resumeAt,
        at: Date.now(),
      })
    }),
  ).finally(() => {
    stationNowBusy = false
    render()
  })
}

function warmHealthy(st) {
  const e = parkedFor(st)
  return Boolean(e && Date.now() - e.player.lastProgressAt < 10_000)
}

const warmRetry = new Map()

function parkedSweep() {
  const now = Date.now()
  let spawned = 0
  for (const e of [...parkedList]) {
    const p = e.player
    if (!p.dead && now - p.lastProgressAt < 15_000) continue
    const st = p.station
    if (e.kind !== 'warm' || shuttingDown || st === state.station || !st.mirrors.length) {
      unparkEntry(e)
      continue
    }
    const r = warmRetry.get(st.uid) ?? { at: 0, n: 0 }
    if (now - r.at < 30_000 || spawned >= 2) continue
    spawned++
    warmRetry.set(st.uid, { at: now, n: r.n + 1 })
    unparkEntry(e)
    const np = spawnPlayer(st.mirrors[r.n % st.mirrors.length], {
      volume: 0,
      paused: false,
      station: st,
      analyze: false,
    })
    parkPlayer(np, { evict: false })
  }
}

function warmAll(onlyFavs = false) {
  const targets = radioSorted().filter(
    (st) =>
      st !== state.station && !warmHealthy(st) && st.mirrors.length && (!onlyFavs || isFavStation(st)),
  )
  targets.forEach((st, i) => {
    setTimeout(() => {
      if (shuttingDown || st === state.station || warmHealthy(st)) return
      const p = spawnPlayer(st.mirrors[0], { volume: 0, paused: false, station: st, analyze: false })
      parkPlayer(p, { evict: false })
    }, i * 400)
  })
  const n = targets.length
  setNote(n ? `warming ${n} station${n === 1 ? '' : 's'} ${Number.isFinite(parkMs()) ? `for ${Math.round(parkMs() / 60000)}m` : 'until quit'}` : 'everything already warm')
}

const isDeleteKey = (key) => key === '\x7f' || key === '\x08' || /^\x1b\[3(;\d+)?~$/.test(key)

const setNote = (text) => {
  state.note = text
  state.noteAt = Date.now()
}

const duckLevel = () =>
  settings.breakAudio === 'mute' ? 0 : Math.min(state.volume, Math.max(5, Math.round(state.volume * 0.3)))

const effVol = () => (state.muted ? 0 : state.ducked ? duckLevel() : state.volume)

function driftSeconds() {
  const pausedNow = state.paused && state.pausedSince ? Date.now() - state.pausedSince : 0
  return Math.max(0, Date.now() - state.fetchedAt - state.pausedTotal - pausedNow) / 1000
}

function elapsedOf(track) {
  if (!track) return 0
  const len = Number(track.lenght) || 0
  const atLiveEdge = len - track.uptime + driftSeconds()
  const cache = state.paused ? state.pausedCacheSnap : (primary?.cacheSeconds ?? 0)
  return Math.min(len, Math.max(0, atLiveEdge - cache))
}

const currentTrack = () =>
  state.tracks.find((t) => t.order === 0) ??
  state.tracks.filter((t) => t.uptime > 0).sort((a, b) => a.uptime - b.uptime)[0] ??
  null

let breakLatch = false
function inBreak() {
  if (state.station?.playlistId == null) return false
  const cur = currentTrack()
  if (!cur) {
    breakLatch = false
    return false
  }
  const next = state.tracks.find((t) => t.order > 0 && !isJingle(t))
  const resume = next
    ? next.uptime - (Number(next.lenght) || 0) - driftSeconds() + (primary?.cacheSeconds ?? 0)
    : Infinity
  if (isJingle(cur)) return true
  if (resume < -10) {
    breakLatch = false
    return false
  }
  const len = Number(cur.lenght) || 0
  const overshoot = len - cur.uptime + driftSeconds() - (primary?.cacheSeconds ?? 0) - len
  if (breakLatch) {
    if (overshoot < BREAK_GRACE - 8) breakLatch = false
  } else if (overshoot > BREAK_GRACE) {
    breakLatch = true
  }
  return breakLatch
}

function stationInfo(st) {
  if (!st) return null
  if (st === state.station && state.tracksFor === st && state.tracks.length) {
    const cur = currentTrack()
    const brk = inBreak()
    let resumeAt = null
    if (brk) {
      const nxt = state.tracks.find((t) => t.order > 0 && !isJingle(t))
      if (nxt) resumeAt = state.fetchedAt + (nxt.uptime - (Number(nxt.lenght) || 0)) * 1000
    }
    return {
      track: cur && !brk && !isJingle(cur) ? cur : null,
      onBreak: brk,
      resumeAt,
      at: Date.now(),
      live: true,
    }
  }
  const n = stationNow.get(st.uid)
  if (n && Date.now() - n.at < 90_000) return { ...n, live: false }
  return null
}

const FAVS_PATH = join(HOME_DIR, 'favorites.json')
const HISTORY_PATH = join(HOME_DIR, 'history.json')
const SETTINGS_PATH = join(HOME_DIR, 'settings.json')
const FAV_ROWS = 8
let favorites = []
let history = []
const sessionStart = Date.now()

const settings = {
  breakAudio: 'off',
  audioMode: 'normal',
  startupStation: 'last',
  startupVolume: 'last',
  keepWarm: '2m',
  warmOnStartup: 'off',
  favStations: [],
}

const isFavStation = (st) => Boolean(st) && settings.favStations.includes(st.uid)
const radioSorted = () => [...stations.filter(isFavStation), ...stations.filter((s) => !isFavStation(s))]

const SETTING_DEFS = [
  {
    key: 'volume',
    label: 'Current volume',
    values: [],
    labels: {},
  },
  {
    key: 'audioMode',
    label: 'Audio mode',
    values: ['normal', 'bass', 'rave', 'night'],
    labels: { normal: 'Normal', bass: 'Bass boost', rave: 'Rave (loud + distorted)', night: 'Night (even loudness)' },
  },
  {
    key: 'breakAudio',
    label: 'During breaks',
    values: ['off', 'hop', 'duck', 'mute'],
    labels: { off: 'Do nothing', duck: 'Lower volume', mute: 'Mute', hop: 'Hop to another station' },
  },
  {
    key: 'keepWarm',
    label: 'Keep stations warm',
    values: ['2m', '10m', 'forever'],
    labels: { '2m': 'Default (2 minutes)', '10m': '10 minutes', forever: 'Until quit' },
  },
  {
    key: 'warmOnStartup',
    label: 'Warm on startup',
    values: ['off', 'favs', 'all'],
    labels: { off: 'Default (off)', favs: 'Pinned stations', all: 'All stations' },
  },
  {
    key: 'startupStation',
    label: 'Startup station',
    values: ['last', 'default'],
    labels: { last: 'Last played', default: 'Default' },
  },
  {
    key: 'startupVolume',
    label: 'Startup volume',
    values: ['last', 'default', '20', '40', '60', '100'],
    labels: { last: 'Last used', default: 'Default (80)' },
  },
]

const settingsSnapshot = () => ({
  ...settings,
  lastStationId: state.station?.uid ?? settings.lastStationId,
  volume: state.volume,
})

function saveSettings() {
  writeFile(SETTINGS_PATH, JSON.stringify(settingsSnapshot(), null, 2)).catch(() => {})
}

const currentModeAf = () => AUDIO_MODES.find((m) => m.name === settings.audioMode)?.af ?? null

function applyAudioMode() {
  const af = currentModeAf()
  for (const p of [primary, standby]) {
    if (!p || p.dead) continue
    p.mpv.send(['af', 'remove', '@mode'])
    if (af) p.mpv.send(['af', 'add', af])
  }
}

let breakModeArmAt = 0
let appliedBreakAudio = 'off'

function onSettingChanged(key) {
  if (key === 'audioMode') {
    applyAudioMode()
    setNote(`audio mode: ${settings.audioMode}`)
  } else if (key === 'breakAudio') {
    breakModeArmAt = settings.breakAudio === appliedBreakAudio ? 0 : Date.now() + 3000
  }
}

async function loadJson(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function ensureHome() {
  try {
    mkdirSync(HOME_DIR, { recursive: true })
  } catch {}
  for (const name of ['favorites.json', 'history.json', 'settings.json', 'streams.json']) {
    const dest = join(HOME_DIR, name)
    const legacy = join(here, name)
    if (existsSync(dest) || !existsSync(legacy)) continue
    try {
      copyFileSync(legacy, dest)
    } catch {}
  }
}

const RB_HOSTS = ['https://all.api.radio-browser.info', 'https://de1.api.radio-browser.info']
let rbHost = RB_HOSTS[0]

const FLAGS = {}
const flagFor = (cc) => {
  const k = String(cc ?? '').toUpperCase()
  if (!/^[A-Z]{2}$/.test(k)) return ''
  return (FLAGS[k] ??= String.fromCodePoint(...[...k].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)))
}

const RMF_HOSTS = [
  'rs101-krk',
  'rs102-krk',
  'rs103-krk',
  'rs201-krk',
  'rs202-krk',
  'rs203-krk',
  'rs101-krk-cyfronet',
  'rs102-krk-cyfronet',
  'rs103-krk-cyfronet',
  'rs201-krk-cyfronet',
  'rs202-krk-cyfronet',
  'rs203-krk-cyfronet',
]

const RMF_CATALOG = `
5|rmf_fm|RMF FM
6|rmf_maxxx|RMF MAXX
7|rmf_classic|RMF Classic
190|rmf_24|RMF24
94|rmf_2|RMF 2 Pop
97|rmf_5|RMF 5 Łagodne przeboje
25|rmf_80s|RMF 80s
2|rmf_classic_rock|RMF Classic rock
3|rmf_dance|RMF Dance
110|rmf_disco_polo|RMF Disco polo
15|rmf_gold|RMF Gold
156|rmf_gamemusic|RMF K-pop
9|rmf_polskie_przeboje|RMF Polskie przeboje
116|rmf_relaks|RMF Relaks
115|rmf_w_pracy|RMF W pracy
81|rmf_2000|RMF 2000
27|rmf_hot_new|RMF Hot new
242|rmf_top8|RMF Jesienny vibe
161|rmf_latino|RMF Latino
173|rmf_top4|RMF Przeboje lata 2026
244|rmf_top10|RMF Top 1000
266|rmf_true_crime|RMF True Crime
168|rmf_top|RMF Świąteczne nowości 2025
148|sizeer_fm|Sizeer FM
82|rmf_20lat|36 lat RMF FM
268|rmf_top17|FRESH Dance
269|rmf_top18|FRESH Polski Hip Hop
267|rmf_top16|FRESH Pop
159|rmf_2010|RMF 10s
236|rmf_20s|RMF 20s
48|rmf_50s|RMF 50s
44|rmf_60s|RMF 60s
45|rmf_70s|RMF 70s
46|rmf_90s|RMF 90s
245|rmf_top11|RMF Classic Filmowy Przebój Wszech Czasów
22|rmf_hop_bec|RMF MAXX Hop Bęc
274|rmf_maxx_new_hits|RMF MAXX New Hits
127|npp_rmf_on|RMF Największe polskie przeboje
111|rmf_niezapomniane_melodie|RMF Niezapomniane melodie
38|rmf_prl|RMF PRL
8|rmf_poplista|RMF Poplista
19|rmf_przeboj_roku|RMF Przebój roku 2025
128|rmf_top_30_swieta|RMF Top 30 święta
271|rmf_top20|FRESH Polskie
28|rmf_alternatywa|RMF Alternatywa
39|rmf_blues|RMF Blues
32|rmf_hard_heavy|RMF Hard & Heavy
37|rmf_hip_hop|RMF Hip hop
52|rmf_ziom|RMF Klasyka polskiego hip hopu
29|rmf_club|RMF MAXX Club
272|rmf_maxx_dance|RMF MAXX Dance
273|rmf_maxx_rap|RMF MAXX Rap
65|rmf_piosenka_literacka|RMF Piosenka literacka
235|rmf_polska_alternatywa|RMF Polska alternatywa
164|rmf_polska_prywatka|RMF Polska prywatka
158|rmf_trend_sounds|RMF Polski hip hop
36|rmf_polski_rock|RMF Polski rock
1|rmf_rock|RMF Rock
84|rmf_rock_progresywny|RMF Rock progresywny
16|rmf_smooth_jazz|RMF Smooth jazz
49|rmf_szanty|RMF Szanty
234|rmf_vibe|RMF Vibe
261|rmf_classic_fmf|FMF CLASSIC
95|rmf_3|RMF 3 Pop-Rock
96|rmf_4|RMF 4 Dance & RNB
109|rmf_80s_disco|RMF 80s disco
130|rmf_90s_dance|RMF 90s dance
93|rmf_nostalgia|RMF Ballady
163|rmf_studencka_impreza|RMF Cafe
11|rmf_chillout|RMF Chillout
255|rmf_classicplus_sku|RMF Classic Czas skupienia
251|rmf_classicplus_zim|RMF Classic Hans Zimmer
252|rmf_classicplus_wil|RMF Classic John Williams
253|rmf_classicplus_wer|RMF Classic Klasyka z werwą
227|rmf_classicplus_min|RMF Classic Mindfulness
226|rmf_classicplus_wes|RMF Classic Morricone Westerny
250|rmf_classicplus_osc|RMF Classic Muzyka Oscarowa
225|rmf_classicplus_pir|RMF Classic Na pirackich wodach
247|rmf_top13|RMF Classic Oscary 2025
254|rmf_classicplus_tar|RMF Classic Tarantino
222|rmf_classicplus_tho|RMF Classic Thor
223|rmf_classicplus_srd|RMF Classic Śródziemie
224|rmf_classicplus_cza|RMF Classic Świat Czarodziejów
243|rmf_top9|RMF Crush
43|rmf_baby|RMF Dla dzieci
117|rmf_fitness|RMF Fitness
118|rmf_fitness_rock|RMF Fitness rock
80|rmf_koledy|RMF Kolędy
239|rmf_ladies|RMF Ladies
237|rmf_leniwa_niedziela|RMF Leniwa niedziela
14|rmf_love|RMF Love
194|rmf_maxxx_byd|RMF MAXX Bydgoszcz
196|rmf_maxxx_cze|RMF MAXX Częstochowa
212|rmf_maxxx_wal|RMF MAXX Dolny Śląsk
198|rmf_maxxx_ino|RMF MAXX Inowrocław
200|rmf_maxxx_knn|RMF MAXX Konin
201|rmf_maxxx_kra|RMF MAXX Kraków
202|rmf_maxxx_ksn|RMF MAXX Krosno
215|rmf_maxxx_zgr|RMF MAXX Lubuskie
195|rmf_maxxx_cie|RMF MAXX Mazowsze
204|rmf_maxxx_nsa|RMF MAXX Nowy Sącz
205|rmf_maxxx_ole|RMF MAXX Oleśnica
206|rmf_maxxx_opo|RMF MAXX Opole
207|rmf_maxxx_pil|RMF MAXX Piła
203|rmf_maxxx_lom|RMF MAXX Podlasie
210|rmf_maxxx_slu|RMF MAXX Pomorze
208|rmf_maxxx_poz|RMF MAXX Poznań
211|rmf_maxxx_szc|RMF MAXX Szczecin
262|rmf_maxxx_tmz|RMF MAXX Tomaszów Mazowiecki
197|rmf_maxxx_gda|RMF MAXX Trójmiasto
213|rmf_maxxx_waw|RMF MAXX Warszawa
214|rmf_maxxx_wlc|RMF MAXX Włocławek
209|rmf_maxxx_slk|RMF MAXX Śląsk
199|rmf_maxxx_kie|RMF MAXX Świętokrzyskie
33|rmf_muzyka_filmowa|RMF Muzyka filmowa
86|rmf_muzyka_klasyczna|RMF Muzyka klasyczna
248|rmf_top14|RMF Na wiosnę
23|rmf_party|RMF Party
166|rmf_piosenka_filmowa|RMF Piosenka filmowa
165|rmf_pobudka|RMF Pobudka
79|rmf_styl|RMF Styl
10|rmf_sloneczne_przeboje|RMF Słoneczne przeboje
171|rmf_top2|RMF Top 2026 disco polo
12|rmf_bravo|RMF Viral
238|rmf_w_kuchni|RMF W kuchni
17|rmf_swieta|RMF Święta
162|rmf_24_wroc|RMF24 WROCŁAW
152|radio_gra|Radio Gra Toruń
`

const RP_CATALOG = `
0|mp3-192,mp3-128,aac-320|Radio Paradise
1|mellow-192,mellow-128|Radio Paradise Mellow
2|rock-192,rock-128|Radio Paradise Rock
3|global-192,global-128|Radio Paradise Global
5|eclectic-192,eclectic-128|Radio Paradise Beyond
42|serenity|Radio Paradise Serenity
945|kfat-192,kfat-128|Radio Paradise KFAT
`

const RF_CATALOG = `
7|fip|FIP
64|fiprock|FIP Rock
65|fipjazz|FIP Jazz
66|fipgroove|FIP Groove
69|fipworld|FIP Monde
70|fipnouveautes|FIP Nouveautés
71|fipreggae|FIP Reggae
74|fipelectro|FIP Electro
77|fipmetal|FIP Metal
`

const SOURCES = [
  {
    src: 'rmf',
    country: 'PL',
    bitrate: 128,
    catalog: RMF_CATALOG,
    mirrors: (mount) => RMF_HOSTS.map((h) => `https://${h}.rmfstream.pl/${mount}`),
  },
  {
    src: 'rp',
    country: 'US',
    bitrate: 192,
    catalog: RP_CATALOG,
    mirrors: (keys) => keys.split(',').map((k) => `https://stream.radioparadise.com/${k}`),
  },
  {
    src: 'rf',
    country: 'FR',
    bitrate: 128,
    catalog: RF_CATALOG,
    mirrors: (slug) => [
      `https://icecast.radiofrance.fr/${slug}-midfi.mp3`,
      `https://icecast.radiofrance.fr/${slug}-hifi.aac`,
    ],
  },
]

let builtinHits = null
function builtinStations() {
  return (builtinHits ??= SOURCES.flatMap((s) =>
    s.catalog
      .trim()
      .split('\n')
      .map((line) => {
        const [id, stream, ...rest] = line.split('|')
        return {
          uuid: null,
          src: s.src,
          playlistId: Number(id),
          name: rest.join('|'),
          countrycode: s.country,
          codec: 'MP3',
          bitrate: s.bitrate,
          hls: false,
          votes: 0,
          mirrors: s.mirrors(stream),
        }
      }),
  ))
}

const squash = (s) => s.replace(/(.)\1+/g, '$1')

function builtinSearch(query) {
  const q = query.trim().toLowerCase()
  if (!q) return builtinStations()
  const sq = squash(q)
  const scored = []
  builtinStations().forEach((st, i) => {
    const name = st.name.toLowerCase()
    const at = name.indexOf(q)
    if (at < 0) {
      if (sq.length < 3 || !squash(name).includes(sq)) return
      scored.push({ st, rank: 3, i })
      return
    }
    const rank = at === 0 ? 0 : /\s/.test(name[at - 1]) ? 1 : 2
    scored.push({ st, rank, i })
  })
  return scored.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.st)
}

const builtinHosts = /(^|\.)(rmfstream\.pl|radioparadise\.com|radiofrance\.fr)$/i

let builtinNames = null
const isBuiltinName = (name) => {
  builtinNames ??= new Set(builtinStations().map((s) => s.name.toLowerCase()))
  return builtinNames.has(name.toLowerCase())
}

async function rbSearch(query) {
  const q = query.trim()
  if (!q) return []
  const path = `/json/stations/search?name=${encodeURIComponent(q)}&limit=60&hidebroken=true&order=votes&reverse=true`
  let lastErr = null
  for (const host of [rbHost, ...RB_HOSTS.filter((h) => h !== rbHost)]) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    try {
      const res = await fetch(host + path, { signal: ac.signal, headers: { 'User-Agent': 'ttyfm' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('unexpected payload')
      rbHost = host
      return groupResults(data)
    } catch (err) {
      lastErr = err.name === 'AbortError' ? new Error('search timed out') : err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr ?? new Error('search failed')
}

function groupResults(rows) {
  const byName = new Map()
  for (const r of rows) {
    const url = r.url_resolved || r.url
    const name = decode(r.name ?? '').replace(/\s+/g, ' ').trim()
    if (!url || !/^https?:\/\//i.test(url) || !name) continue
    if (builtinHosts.test(url.replace(/^https?:\/\//, '').split('/')[0].split(':')[0])) continue
    if (isBuiltinName(name)) continue
    const key = `${name.toLowerCase()}::${r.countrycode ?? ''}`
    const hit = byName.get(key)
    if (hit) {
      if (!hit.mirrors.includes(url)) hit.mirrors.push(url)
      hit.votes = Math.max(hit.votes, r.votes ?? 0)
      continue
    }
    byName.set(key, {
      uuid: r.stationuuid,
      name,
      countrycode: r.countrycode ?? '',
      codec: (r.codec ?? '').toUpperCase(),
      bitrate: r.bitrate ?? 0,
      hls: Boolean(r.hls),
      votes: r.votes ?? 0,
      mirrors: [url],
    })
  }
  return [...byName.values()].sort((a, b) => a.hls - b.hls || b.votes - a.votes).slice(0, 40)
}

function addStation(hit) {
  const uid = hit.src ? `${hit.src}:${hit.playlistId}` : hit.uuid ? `rb:${hit.uuid}` : `url:${hit.mirrors[0]}`
  const dupe = stations.find((s) => s.uid === uid || s.mirrors.some((m) => hit.mirrors.includes(m)))
  if (dupe) {
    setNote(`already added: ${dupe.name}`)
    return dupe
  }
  const st = {
    uid,
    name: hit.name,
    flag: flagFor(hit.countrycode),
    src: hit.src ?? null,
    playlistId: hit.playlistId ?? null,
    mirrors: [...new Set(hit.mirrors)],
  }
  stations.push(st)
  saveStations()
  refreshStationDefs()
  refreshJingleRe()
  setNote(`added ${st.name}`)
  return st
}

function removeStation(st) {
  const i = stations.indexOf(st)
  if (i < 0) return
  stations.splice(i, 1)
  refreshJingleRe()
  const f = settings.favStations.indexOf(st.uid)
  if (f >= 0) settings.favStations.splice(f, 1)
  const parked = parkedFor(st)
  if (parked) unparkEntry(parked)
  stationNow.delete(st.uid)
  saveStations()
  saveSettings()
  refreshStationDefs()
  setNote(`removed ${st.name}`)
  if (state.station === st) {
    state.station = null
    state.tracks = []
    if (stations.length) tuneTo(0)
    else {
      cancelSwap()
      primary?.mpv.stop()
      primary = null
      state.showDiscover = true
    }
  }
}

function refreshStationDefs() {
  const d = SETTING_DEFS.find((x) => x.key === 'startupStation')
  d.values = ['last', 'default']
  d.labels = { last: 'Last played', default: `Default (${stations[0]?.name ?? 'none'})` }
  for (const s of stations) {
    d.values.push(s.uid)
    d.labels[s.uid] = s.name
  }
  if (!d.values.includes(settings.startupStation)) settings.startupStation = 'last'
}

function saveStations() {
  const out = stations.map((s) => ({
    uid: s.uid,
    name: s.name,
    ...(s.flag ? { flag: s.flag } : {}),
    ...(s.playlistId != null ? { id: s.playlistId } : {}),
    ...(s.src && s.src !== 'rmf' ? { src: s.src } : {}),
    mirrors: s.mirrors,
  }))
  writeFile(JSON_PATH, JSON.stringify({ stations: out }, null, 4)).catch(() => {})
}

let firstRun = false

async function loadPersisted() {
  favorites = await loadJson(FAVS_PATH)
  history = await loadJson(HISTORY_PATH)
  try {
    const s = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
    if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(settings, s)
  } catch {
    firstRun = true
  }
  const toUid = (v) => (/^\d+$/.test(String(v)) ? `rmf:${v}` : String(v))
  settings.favStations = [...new Set((settings.favStations ?? []).map(toUid))]
  if (settings.lastStationId != null) settings.lastStationId = toUid(settings.lastStationId)
  if (!['last', 'default'].includes(settings.startupStation)) {
    settings.startupStation = toUid(settings.startupStation)
  }
}

function logPlay(cur) {
  if (isJingle(cur)) return
  const last = history.at(-1)
  if (last && favKey(last) === favKey(cur)) return
  history.push({
    title: cur.title,
    author: cur.author,
    station: state.station.name,
    at: new Date().toISOString(),
    l: Number(cur.lenght) || 180,
  })
  writeFile(HISTORY_PATH, JSON.stringify(history)).catch(() => {})
}

function wrappedStats() {
  const byArtist = new Map()
  const bySong = new Map()
  const byMonth = new Map()
  const byStation = new Map()
  const byDate = new Map()
  const byHour = new Array(24).fill(0)
  const byBlock = [0, 0, 0, 0]
  let secs = 0
  for (const h of history) {
    const l = Number(h.l) || 180
    secs += l
    byArtist.set(h.author, (byArtist.get(h.author) ?? 0) + 1)
    const k = `${h.title} — ${h.author}`
    bySong.set(k, (bySong.get(k) ?? 0) + 1)
    byMonth.set(h.at.slice(0, 7), (byMonth.get(h.at.slice(0, 7)) ?? 0) + l)
    byStation.set(h.station ?? '?', (byStation.get(h.station ?? '?') ?? 0) + l)
    byDate.set(h.at.slice(0, 10), (byDate.get(h.at.slice(0, 10)) ?? 0) + l)
    const hr = new Date(h.at).getHours()
    byHour[hr] += l
    byBlock[hr >= 5 && hr < 12 ? 0 : hr < 17 ? 1 : hr < 22 ? 2 : 3] += l
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  const dates = [...byDate.keys()].sort()
  let streak = dates.length ? 1 : 0
  for (let i = dates.length - 1; i > 0; i--) {
    const gap = (new Date(dates[i]) - new Date(dates[i - 1])) / 86_400_000
    if (gap === 1) streak++
    else break
  }
  const biggestDay = top(byDate, 1)[0]
  const peakHour = byHour.indexOf(Math.max(...byHour))
  const blocks = ['Early Bird', 'Daytime', 'Evening', 'Night Owl']
  const peakBlock = blocks[byBlock.indexOf(Math.max(...byBlock))]
  const unique = bySong.size
  const repeatPct = history.length ? Math.round(100 * (1 - unique / history.length)) : 0
  const favSet = new Set(favorites.map(favKey))
  const byFavSong = new Map()
  let favHits = 0
  for (const h of history) {
    if (favSet.has(favKey(h))) {
      favHits++
      const k = `${h.title} — ${h.author}`
      byFavSong.set(k, (byFavSong.get(k) ?? 0) + 1)
    }
  }
  const favHitPct = history.length ? Math.round((100 * favHits) / history.length) : 0
  const since = history.length
    ? new Date(history[0].at).toLocaleDateString('en', { month: 'short', day: 'numeric' })
    : null
  return {
    songs: history.length,
    artists: byArtist.size,
    secs,
    topSongs: top(bySong, 10),
    topArtists: top(byArtist, 5),
    months: [...byMonth.entries()].sort(),
    stations: top(byStation, 4),
    favsOnAir: top(byFavSong, 5),
    favHitPct,
    streak,
    biggestDay,
    peakHour,
    vibe: `${peakBlock} ${repeatPct >= 40 ? 'Loyalist' : 'Explorer'}`,
    repeatPct,
    since,
  }
}

let jingleRe = null
const isJingle = (t) => Boolean(t && jingleRe && jingleRe.test(t.author ?? ''))

const favKey = (t) => `${t.title}::${t.author}`
const isFavorite = (t) => Boolean(t) && favorites.some((f) => favKey(f) === favKey(t))

let confirmPending = null
function confirmTwice(kind, id, label) {
  if (
    confirmPending &&
    confirmPending.kind === kind &&
    confirmPending.id === id &&
    Date.now() - confirmPending.at < NOTE_MS
  ) {
    confirmPending = null
    return true
  }
  confirmPending = { kind, id, at: Date.now() }
  setNote(`⚠ press again to ${label}`)
  return false
}

function toggleFavoriteTrack(t) {
  const i = favorites.findIndex((f) => favKey(f) === favKey(t))
  if (i >= 0) {
    if (!confirmTwice('fav', favKey(t), `remove "${t.title}" from favorites`)) return
    favorites.splice(i, 1)
    setNote(`removed from favorites: ${t.title}`)
  } else {
    favorites.push({ title: t.title, author: t.author, at: new Date().toISOString() })
    setNote(`♥ saved: ${t.title} — ${t.author}`)
  }
  writeFile(FAVS_PATH, JSON.stringify(favorites, null, 2)).catch(() => {})
}

function toggleFavorite() {
  const cur = currentTrack()
  if (!cur || inBreak()) {
    setNote("⚠ can't favorite — no song data right now")
    return
  }
  toggleFavoriteTrack(cur)
}

const ICY_JUNK = /^(unknown|n\/a|null|advert(isement)?|commercial|reklama|jingle|live stream|no title)$/i

function parseIcy(raw, st) {
  const s = decode(String(raw ?? '')).replace(/\s+/g, ' ').trim()
  if (!s || s.length > 200 || ICY_JUNK.test(s)) return null
  const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase()
  if (same(s, st?.name) || same(s, playerFor(st)?.icyName)) return null
  const cut = s.indexOf(' - ')
  if (cut < 1) return { title: s, author: st?.name ?? 'unknown', lenght: 0, uptime: 0, order: 0 }
  return { author: s.slice(0, cut).trim(), title: s.slice(cut + 3).trim(), lenght: 0, uptime: 0, order: 0 }
}

function playerFor(st) {
  if (!st) return null
  if (primary?.station === st && !primary.dead) return primary
  return parkedFor(st)?.player ?? null
}

const icyTrackFor = (st) => (st?.playlistId != null ? null : parseIcy(playerFor(st)?.icyTitle, st))

function onIcyMeta(p) {
  const st = p.station
  if (!st || st.playlistId != null) return
  const t = parseIcy(p.icyTitle, st)
  stationNow.set(st.uid, {
    track: t ? { title: t.title, author: t.author } : null,
    onBreak: false,
    resumeAt: null,
    at: Date.now(),
  })
  if (p !== primary) return
  state.tracksFor = st
  state.fetchedAt = Date.now()
  state.pausedTotal = 0
  state.pausedSince = state.paused ? Date.now() : 0
  state.error = null
  if (!t) {
    state.tracks = state.tracks.filter((x) => x.order < 0)
  } else {
    const prev = state.tracks.filter((x) => x.order === 0).map((x) => ({ ...x, order: -1 }))
    state.tracks = [...state.tracks.filter((x) => x.order < 0), ...prev, t].slice(-4)
    if (!state.paused) logPlay(t)
  }
  render()
}

async function fetchJson(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'ttyfm' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const PLAYLISTS = {
  async rmf(id) {
    const data = await fetchJson(`https://api.rmfon.pl/stations/${id}/playlist`)
    if (!Array.isArray(data)) throw new Error('unexpected payload')
    return data.map((t) => ({
      ...t,
      author: decode(t.author),
      title: decode(t.title),
      recordTitle: decode(t.recordTitle),
    }))
  },

  async rp(chan) {
    const d = await fetchJson(`https://api.radioparadise.com/api/get_block?chan=${chan}&bitrate=4&info=true`)
    const songs = Object.keys(d.song ?? {})
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => d.song[k])
    if (!songs.length) return []
    const total = songs.reduce((n, s) => n + (Number(s.duration) || 0), 0)
    const elapsed = total - (Number(d.length) * 1000 - Number(d.cue))
    let end = -elapsed
    return songs.map((s, i) => {
      const len = (Number(s.duration) || 0) / 1000
      end += Number(s.duration) || 0
      return {
        order: i,
        author: decode(s.artist ?? ''),
        title: decode(s.title ?? ''),
        recordTitle: decode(s.album ?? ''),
        lenght: Math.round(len),
        uptime: Math.round(end / 1000),
      }
    })
  },

  async rf(id) {
    const d = await fetchJson(`https://api.radiofrance.fr/livemeta/pull/${id}`)
    const now = Date.now() / 1000
    const steps = Object.values(d.steps ?? {})
      .filter((s) => s.start && s.end && s.title && s.authors)
      .sort((a, b) => a.start - b.start)
    const playing = steps.findIndex((s) => s.start <= now && now <= s.end)
    const ahead = steps.findIndex((s) => s.start > now)
    const at = playing < 0 ? (ahead < 0 ? steps.length : ahead) : playing
    return steps.map((s, i) => ({
      order: playing < 0 && i >= at ? i - at + 1 : i - at,
      author: decode(s.authors),
      title: decode(s.title),
      recordTitle: decode(s.albumTitle ?? ''),
      lenght: Math.round(s.end - s.start),
      uptime: Math.round(s.end - now),
    }))
  },
}

async function fetchPlaylistFor(st) {
  const ask = st?.src && PLAYLISTS[st.src]
  if (!ask || st.playlistId == null) return { icy: true }
  try {
    return { tracks: await ask(st.playlistId), fetchedAt: Date.now() }
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'playlist timeout' : err.message }
  }
}

function applyPlaylist(res) {
  if (res.icy) {
    state.error = null
    return
  }
  if (res.error) {
    state.error = res.error
    return
  }
  if (state.tracksFor !== state.station) breakLatch = false
  state.tracks = res.tracks
  state.tracksFor = state.station
  state.fetchedAt = res.fetchedAt
  state.pausedTotal = 0
  state.pausedSince = state.paused ? Date.now() : 0
  state.error = null
  const info = stationInfo(state.station)
  if (info?.live) {
    stationNow.set(state.station.uid, {
      track: info.track ? { title: info.track.title, author: info.track.author } : null,
      onBreak: info.onBreak,
      resumeAt: info.resumeAt,
      at: Date.now(),
    })
  }
  const cur = currentTrack()
  if (cur && !state.paused && !inBreak()) logPlay(cur)
  duckCheck()
  fleeCheck()
}

async function fetchPlaylist() {
  const st = state.station
  const res = await fetchPlaylistFor(st)
  if (st !== state.station || primary?.station !== st) return
  applyPlaylist(res)
}

let pollTimer = null
function schedulePoll() {
  clearTimeout(pollTimer)
  if (state.station?.playlistId == null) return
  const cur = currentTrack()
  const remainingMs = cur ? (cur.uptime - (Date.now() - state.fetchedAt) / 1000) * 1000 : 0
  const delay =
    !cur || remainingMs <= 0
      ? STALE_POLL
      : Math.min(MAX_POLL, Math.max(MIN_POLL, remainingMs + POLL_SLACK))
  pollTimer = setTimeout(async () => {
    await fetchPlaylist()
    schedulePoll()
  }, delay)
}

const expectedPause = []
let danceUntil = 0

function cmdPause(p, want) {
  if (!p) return false
  if (p.pausedProp === want) return true
  if (!p.mpv.setPause(want)) return false
  if (p === primary) expectedPause.push({ v: want, at: Date.now() })
  return true
}

function externalPauseSync(want) {
  state.paused = want
  if (want) {
    state.pausedSince = Date.now()
    state.pausedAt = Date.now()
    state.pausedCacheSnap = primary?.cacheSeconds ?? 0
    standby?.mpv.setPause(true)
    if (primary && !primary.dead && primary.mpv.connected) {
      danceUntil = Date.now() + PAUSE_FADE_MS + 250
      cmdPause(primary, false)
      fadeVolume(effVol(), 0, PAUSE_FADE_MS, () => {
        cmdPause(primary, true)
      })
    }
  } else {
    primary?.mpv.setVolume(0)
    cmdPause(primary, false)
    const pausedFor = Date.now() - (state.pausedAt || Date.now())
    state.pausedSince = 0
    state.pausedAt = 0
    if (pausedFor > 60_000) {
      if (primary) primary.stale = true
      state.rejoining = true
      failover('rejoining live', { blame: false })
    } else {
      const backlog = primary?.cacheSeconds ?? 0
      if (backlog > LIVE_TARGET + 1) primary?.mpv.seek(backlog - LIVE_TARGET)
      else state.pausedTotal += pausedFor
      if (primary) primary.lastProgressAt = Date.now()
      standby?.mpv.setPause(false)
      fadeVolume(0, effVol(), PAUSE_FADE_MS)
    }
  }
  render()
}

function cancelSwap() {
  if (!state.swapping) return
  swapEpoch++
  standby?.mpv.stop()
  standby = null
  state.swapping = false
  state.rejoining = false
  state.warming = null
}

function stepStation(dir) {
  const order = radioSorted()
  if (!order.length) return
  const i = Math.max(0, order.indexOf(state.station))
  lastFleeAt = 0
  tuneTo(stations.indexOf(order[(i + dir + order.length) % order.length]))
}

let lastMediaAt = 0
function mediaStation(dir) {
  if (Date.now() - lastMediaAt < 800 || shuttingDown) return
  lastMediaAt = Date.now()
  stepStation(dir === 'prev' ? -1 : 1)
  render()
}

let pendingPlaylist = null

function applyPendingPlaylist() {
  if (!pendingPlaylist) return
  applyPlaylist(pendingPlaylist)
  pendingPlaylist = null
  breakLatch = false
  schedulePoll()
  render()
}

function tuneTo(index) {
  const st = stations[index]
  if (!st) return
  if (st === state.station) return
  state.station = st
  saveSettings()
  cancelSwap()
  pendingPlaylist = null
  book.load(st.mirrors)
  if (primary?.station !== st) {
    state.tracks = []
    state.error = null
  }
  const glance = stationNow.get(st.uid)
  if (
    (settings.breakAudio === 'duck' || settings.breakAudio === 'mute') &&
    Date.now() >= breakModeArmAt &&
    !state.paused &&
    !state.muted &&
    glance?.onBreak &&
    Date.now() - glance.at < 30_000
  ) {
    state.ducked = true
    state.duckApplied = duckLevel()
  }
  if (primary && !primary.dead && primary.station === st) {
    fetchPlaylistFor(st).then((res) => {
      if (state.station !== st || primary?.station !== st) return
      applyPlaylist(res)
      schedulePoll()
      render()
    })
    setNote(`staying on ${st.name}`)
    return
  }
  const warmEntry = parkedFor(st)
  const warmReady =
    warmEntry &&
    warmEntry.player.progressed &&
    Date.now() - warmEntry.player.lastProgressAt < 10_000
  if (warmEntry && !warmReady) {
    unparkEntry(warmEntry)
    setNote(
      warmEntry.player.progressed
        ? `${st.name} went cold — connecting fresh`
        : `${st.name} was still warming — connecting fresh`,
    )
  }
  if (warmReady) {
    const revived = warmEntry.player
    unparkEntry(warmEntry, { stop: false })
    revived.mpv.send(['af', 'add', EQ_AF])
    const old = primary
    primary = revived
    primary.onDeath = () => failover('mirror dropped')
    if (primary.icyTitle !== null) onIcyMeta(primary)
    applyAudioMode()
    primary.lastProgressAt = Date.now()
    if (primary.cacheSeconds > LIVE_TARGET + 1) {
      primary.lastTrimAt = Date.now()
      primary.mpv.seek(primary.cacheSeconds - LIVE_TARGET)
    }
    const parkable = old && !old.dead && !old.stale
    if (state.paused) {
      cmdPause(primary, true)
      primary.mpv.setVolume(mpvVol(effVol()))
      if (parkable) old.mpv.setVolume(0)
      else old?.mpv.stop()
    } else {
      crossfade(old, primary, { keepOld: parkable })
    }
    if (parkable) parkPlayer(old, { evict: !parkedList.some((e) => e.kind === 'warm') })
    fetchPlaylistFor(st).then((res) => {
      if (state.station !== st || primary?.station !== st) return
      applyPlaylist(res)
      schedulePoll()
      render()
    })
    setNote(`back on ${st.name} — still warm`)
    render()
    return
  }
  probeMirrors()
  fetchPlaylistFor(st).then((res) => {
    if (state.station !== st) return
    pendingPlaylist = res
    if (primary?.station === st) applyPendingPlaylist()
  })
  failover(`tuned to ${st.name}`, { blame: false })
}

let fadeTimer = null
function fadeVolume(from, to, ms, done) {
  clearInterval(fadeTimer)
  const steps = Math.max(6, Math.round(ms / 15))
  let i = 0
  fadeTimer = setInterval(() => {
    i++
    primary?.mpv.setVolume(mpvVol(from + ((to - from) * i) / steps))
    if (i >= steps) {
      clearInterval(fadeTimer)
      primary?.mpv.setVolume(mpvVol(to === 0 ? 0 : effVol()))
      done?.()
    }
  }, ms / steps)
}

function crossfade(oldP, newP, { keepOld = false } = {}) {
  const steps = Math.max(6, Math.round(SWAP_FADE_MS / 15))
  let i = 0
  const iv = setInterval(() => {
    i++
    const k = i / steps
    newP?.mpv.setVolume(mpvVol(effVol() * k))
    if (!oldP?.stale) oldP?.mpv.setVolume(mpvVol(effVol() * (1 - k)))
    if (i >= steps) {
      clearInterval(iv)
      newP?.mpv.setVolume(mpvVol(effVol()))
      if (keepOld) oldP?.mpv.setVolume(0)
      else oldP?.mpv.stop()
    }
  }, SWAP_FADE_MS / steps)
}

function startPrimary() {
  primary = spawnPlayer(book.pick(), { volume: 0, paused: false })
  primary.onProgress = () => {
    if (primary.cacheSeconds > LIVE_TARGET + 1) {
      primary.lastTrimAt = Date.now()
      primary.mpv.seek(primary.cacheSeconds - LIVE_TARGET)
    }
    fadeVolume(0, effVol(), 400)
  }
  primary.onDeath = (code) => {
    if (code === 'spawn-failed') {
      cleanup()
      console.error('ttyfm needs mpv to play audio, and it is not on your PATH.')
      console.error(`install it with:  ${MPV_HINT}`)
      process.exit(1)
    }
    failover('mirror dropped')
  }
}

let swapEpoch = 0
function failover(reason, { blame = true } = {}) {
  if (state.swapping || shuttingDown) return
  state.swapping = true
  state.swapStartedAt = Date.now()
  state.verb = pickVerb()
  if (blame && primary) book.fail(primary.url)
  const epoch = ++swapEpoch

  const attempt = () => {
    if (shuttingDown || epoch !== swapEpoch) return
    const url = book.pick(primary?.url)
    state.warming = url
    render()
    standby = spawnPlayer(url, {
      volume: state.paused ? effVol() : 0,
      paused: state.paused,
    })

    const abandon = () => {
      if (epoch !== swapEpoch) return
      standby?.mpv.stop()
      standby = null
      book.fail(url)
      state.failStreak++
      const backoff = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** Math.min(state.failStreak, 5))
      setTimeout(attempt, backoff)
    }

    standby.onDeath = abandon
    const deadline = Date.now() + STANDBY_TIMEOUT
    const watch = setInterval(() => {
      if (shuttingDown || epoch !== swapEpoch || !standby) return clearInterval(watch)
      if (isHealthy(standby)) {
        clearInterval(watch)
        const old = primary
        primary = standby
        standby = null
        state.swapping = false
        state.rejoining = false
        state.warming = null
        state.failStreak = 0
        state.hops++
        book.ok(primary.url)
        primary.onDeath = () => failover('mirror dropped')
        if (primary.icyTitle !== null) onIcyMeta(primary)
        if (primary.cacheSeconds > LIVE_TARGET + 1) {
          primary.lastTrimAt = Date.now()
          primary.mpv.seek(primary.cacheSeconds - LIVE_TARGET)
        }
        const parkable = old && !old.dead && !old.stale && old.station !== primary.station
        if (state.paused) {
          if (parkable) old.mpv.setVolume(0)
          else old?.mpv.stop()
          primary.mpv.setVolume(mpvVol(effVol()))
        } else {
          crossfade(old, primary, { keepOld: parkable })
        }
        if (parkable) parkPlayer(old, { evict: !parkedList.some((e) => e.kind === 'warm') })
        if (primary.station === state.station && pendingPlaylist) applyPendingPlaylist()
        setNote(
          old
            ? `hopped ${hostOf(old.url)} → ${hostOf(primary.url)} (${reason})`
            : `${reason} · ${hostOf(primary.url)}`,
        )
        render()
      } else if (Date.now() > deadline) {
        clearInterval(watch)
        standby.onDeath = null
        abandon()
      }
    }, 200)
  }

  attempt()
}

function duckCheck() {
  if (Date.now() < breakModeArmAt) return
  if (state.tracksFor !== state.station) return
  const shouldDuck =
    (settings.breakAudio === 'duck' || settings.breakAudio === 'mute') &&
    inBreak() &&
    !isJingle(currentTrack())
  const target = shouldDuck ? duckLevel() : null
  if (shouldDuck === state.ducked && (!shouldDuck || target === state.duckApplied)) return
  const entering = shouldDuck !== state.ducked
  const from = effVol()
  state.ducked = shouldDuck
  state.duckApplied = target
  if (primary && !primary.dead && primary.ipcReady && !state.paused) fadeVolume(from, effVol(), 600)
  if ((entering || shouldDuck) && primary?.progressed && !state.paused && !state.muted) {
    if (shouldDuck) {
      setNote(
        settings.breakAudio === 'mute'
          ? 'break — muted until music returns'
          : 'break — volume lowered',
      )
    } else if (
      (settings.breakAudio === 'duck' || settings.breakAudio === 'mute') &&
      !inBreak()
    ) {
      setNote('music back — volume restored')
    }
  }
}

async function stationLooksClean(st) {
  if (st.playlistId == null) {
    const p = playerFor(st)
    return Boolean(p && Date.now() - p.icyAt < 300_000 && icyTrackFor(st))
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 4000)
  try {
    const res = await fetch(`https://api.rmfon.pl/stations/${st.playlistId}/playlist`, {
      signal: ac.signal,
      headers: { 'User-Agent': 'ttyfm' },
    })
    if (!res.ok) return false
    const data = await res.json()
    if (!Array.isArray(data)) return false
    const cur = data.find((x) => x.order === 0)
    if (!cur) return false
    if (jingleRe?.test(cur.author ?? '')) return false
    return cur.uptime > 15
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

let lastFleeAt = 0
let fleePending = false
async function fleeCheck() {
  if (Date.now() < breakModeArmAt) return
  if (state.tracksFor !== state.station) return
  if (settings.breakAudio !== 'hop' || stations.length < 2) return
  if (state.paused || state.swapping || fleePending || !primary?.progressed) return
  if (!inBreak()) return
  if (Date.now() - lastFleeAt < 25_000) return
  fleePending = true
  try {
    const fleeRank = (s) => {
      const n = stationNow.get(s.uid)
      const fresh = n && Date.now() - n.at < 30_000
      const e = parkedFor(s)
      const warm =
        e && e.player.progressed && Date.now() - e.player.lastProgressAt < 10_000 ? 1 : 0
      return (fresh && n.onBreak ? -4 : 0) + (fresh && n.track ? 2 : 0) + warm
    }
    const candidates = radioSorted()
      .filter((s) => s !== state.station)
      .sort((a, b) => fleeRank(b) - fleeRank(a))
    for (const st of candidates) {
      if (await stationLooksClean(st)) {
        if (!inBreak() || state.swapping || shuttingDown) return
        lastFleeAt = Date.now()
        tuneTo(stations.indexOf(st))
        setNote(`break — fleeing to ${state.station.name}`)
        return
      }
    }
    lastFleeAt = Date.now()
    setNote('breaks everywhere — staying put')
  } finally {
    fleePending = false
  }
}

function watchdog() {
  if (shuttingDown) return
  if (Date.now() >= breakModeArmAt) appliedBreakAudio = settings.breakAudio
  duckCheck()
  fleeCheck()
  parkedSweep()
  if (
    state.paused &&
    primary &&
    !primary.dead &&
    primary.pausedProp === false &&
    Date.now() > danceUntil
  ) {
    primary.mpv.setVolume(0)
    cmdPause(primary, true)
  }
  if (!primary || state.swapping || state.paused) return
  if (primary.dead) return
  if (!primary.ipcReady && !primary.mpv.connected) return
  const stalled = Date.now() - primary.lastProgressAt > STALL_MS
  const bufferStuck = primary.buffering && primary.bufferingSince && Date.now() - primary.bufferingSince > STALL_MS
  if (stalled || bufferStuck) {
    failover(stalled ? 'stream stalled' : 'buffer starved')
    return
  }
  if (
    primary.progressed &&
    !primary.buffering &&
    primary.cacheSeconds > LIVE_TRIM_ABOVE &&
    Date.now() - primary.lastTrimAt > 10_000
  ) {
    primary.lastTrimAt = Date.now()
    primary.mpv.seek(primary.cacheSeconds - LIVE_TARGET)
  }
}

const ALT_ON = '\x1b[?1049h\x1b[?25l'
const ALT_OFF = '\x1b[?25h\x1b[?1049l'

function bar(fraction, width) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return `${C.accent}${'━'.repeat(filled)}${C.dim}${'─'.repeat(width - filled)}${C.reset}`
}

let lastTermTitle = null
function setTermTitle(text) {
  const t = text.replace(/[\x00-\x1f\x07]/g, '')
  if (t === lastTermTitle) return
  lastTermTitle = t
  process.stdout.write(`\x1b]0;${t}\x07`)
}

let lastMediaTitle = null
let lastMediaPlayer = null
function setMediaTitle(text) {
  if (text === lastMediaTitle && primary === lastMediaPlayer) return
  if (!primary?.mpv.connected) return
  lastMediaTitle = text
  lastMediaPlayer = primary
  primary.mpv.send(['set_property', 'force-media-title', text])
}

let frozenElapsed = null

let lastRenderAt = 0
function checkForSleep() {
  const now = Date.now()
  const gap = now - lastRenderAt
  lastRenderAt = now
  if (gap > SLEEP_GAP && state.fetchedAt) {
    if (primary) primary.lastProgressAt = now
    fetchPlaylist().then(() => {
      schedulePoll()
      render()
    })
  }
}

function render() {
  if (shuttingDown) return
  checkForSleep()
  const W = Math.max(40, Math.min(process.stdout.columns || 80, 92))
  const inner = W - 4
  const out = []
  const pad = '  '

  const cur = currentTrack()
  const prevs = state.tracks.filter((t) => t.order < 0 && !isJingle(t)).slice(-3)
  const next = state.tracks.find((t) => t.order > 0 && !isJingle(t))

  const playingNow = cur && !inBreak()
  setTermTitle(
    playingNow ? `${cur.title} — ${cur.author} · tty.fm` : `✳ tty.fm · ${state.station?.name ?? 'RMF'}`,
  )
  setMediaTitle(playingNow ? `${cur.title} — ${cur.author}` : `${state.station?.name ?? 'RMF'} · tty.fm`)

  const ready = state.paused || Boolean(primary?.progressed)
  const settling = primary && !primary.dead && !state.paused && !primary.progressed
  const stalledNow = Boolean(
    primary && !primary.dead && !state.paused && primary.progressed && Date.now() - primary.lastProgressAt > 2500,
  )
  const chip = !stations.length
    ? `${C.dim}○ empty${C.reset}`
    : !primary || primary.dead || state.rejoining
    ? state.swapping
      ? `${C.accent}${spinnerFrame()}${C.reset} ${C.dim}${C.italic}reconnecting…${C.reset}`
      : `${C.red}●${C.reset} ${C.dim}offline${C.reset}`
    : state.paused
      ? `${C.accentDim}⏸${C.reset} ${C.dim}paused${C.reset}`
      : settling || primary.buffering || stalledNow
        ? `${C.accent}${spinnerFrame()}${C.reset} ${C.dim}${C.italic}${state.verb}…${C.reset}`
        : `${C.green}●${C.reset} ${C.dim}live${C.reset}`

  const cache = primary?.cacheSeconds ?? 0
  const chipLive =
    primary && !primary.dead && !state.rejoining && !state.paused && !settling && !primary.buffering && !stalledNow
  const lag =
    chipLive && cache > LIVE_TRIM_ABOVE
      ? `${C.dim} · ${Math.round(cache)}s behind ·${C.reset} ${C.accentDim}${C.italic}catching up…${C.reset}`
      : ''

  out.push('')
  const anyView =
    state.showFavs ||
    state.showRadios ||
    state.showWrapped ||
    state.showHistory ||
    state.showSettings ||
    state.showDiscover
  let headSong = ''
  const headInfo = anyView ? stationInfo(state.station) : null
  if (headInfo?.track) {
    const hTrack = headInfo.track
    const len = headInfo.live ? Number(hTrack.lenght) || 0 : 0
    const mini = len
      ? `  ${bar(elapsedOf(hTrack) / len, 8)}  ${C.dim}${mmss(elapsedOf(hTrack))} / ${mmss(len)}${C.reset}`
      : ''
    const room = inner - 9 - visible(chip + lag) - (len ? 24 : 0) - 4
    if (room >= 10) {
      headSong = ` ${C.dim}· ${clip(`${hTrack.title} — ${hTrack.author}`, room)}${C.reset}${mini}`
    }
  }
  const rule = `${pad}${C.dim}${'─'.repeat(inner)}${C.reset}`
  out.push(pad + rowFit(`${C.accent}${C.bold}✳ tty.fm${C.reset}${headSong}`, [chip + lag, chip, ''], inner))
  out.push(rule)
  out.push('')

  if (state.showDiscover) {
    out.push(
      `${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}Discover${C.reset} ${C.dim}(type to search · ↑↓ + enter to add · esc to close)${C.reset}`,
    )
    const boxW = Math.min(inner, 60)
    const fieldW = boxW - 6
    const caret = `${C.dim}█${C.reset}`
    const typed = state.discQuery
      ? `${C.text}${clip(state.discQuery, fieldW - 1)}${C.reset}`
      : `${C.dim}${C.italic}${clip('station, genre or country…', fieldW - 1)}${C.reset}`
    const field = state.discQuery ? `${typed}${caret}` : `${caret}${typed}`
    const fill = ' '.repeat(Math.max(0, fieldW - visible(field)))
    out.push(`${pad}${C.select}╭${'─'.repeat(boxW - 2)}╮${C.reset}`)
    out.push(`${pad}${C.select}│${C.reset} ${C.dim}⌕${C.reset} ${field}${fill} ${C.select}│${C.reset}`)
    out.push(`${pad}${C.select}╰${'─'.repeat(boxW - 2)}╯${C.reset}`)
    const total = state.discResults.length
    if (state.discBusy) {
      out.push(`${pad}     ${C.accent}${spinnerFrame()}${C.reset} ${C.dim}${C.italic}searching…${C.reset}`)
    } else if (state.discError) {
      out.push(`${pad}     ${C.yellow}⚠${C.reset} ${C.dim}${clip(state.discError, inner - 8)}${C.reset}`)
    } else if (!state.discQuery.trim()) {
      out.push(
        `${pad}     ${C.dim}${C.italic}${total} stations with live playlists — or type to search 50k more${C.reset}`,
      )
    }
    if (!total) {
      if (!state.discBusy) {
        out.push(
          state.discRan
            ? `${pad}     ${C.dim}nothing found — try a shorter name${C.reset}`
            : `${pad}     ${C.dim}${C.italic}50k stations — try "kexp", "jazz" or "rmf"${C.reset}`,
        )
      }
    } else {
      const bottomEst = 5 + (state.showHelp ? 1 : 0) + (state.swapping ? 1 : 0)
      const noteEst =
        (state.note && Date.now() - state.noteAt < NOTE_MS ? 2 : 0) +
        (state.failStreak >= book.entries.length && book.entries.length ? 2 : 0)
      const listRows = Math.max(4, (process.stdout.rows || 24) - out.length - bottomEst - noteEst - 3)
      state.discCursor = Math.max(0, Math.min(state.discCursor, total - 1))
      if (state.discCursor < state.discScroll) state.discScroll = state.discCursor
      if (state.discCursor >= state.discScroll + listRows) state.discScroll = state.discCursor - listRows + 1
      out.push(state.discScroll > 0 ? `${pad}     ${C.dim}… ${state.discScroll} more ↑${C.reset}` : '')
      state.discResults.slice(state.discScroll, state.discScroll + listRows).forEach((r, i) => {
        const idx = state.discScroll + i
        const sel = idx === state.discCursor
        const have = stations.some((s) => s.mirrors.some((m) => r.mirrors.includes(m)))
        const flag = flagFor(r.countrycode)
        const meta = [r.bitrate ? `${r.bitrate}k` : '', r.codec, r.hls ? 'HLS' : ''].filter(Boolean).join(' · ')
        const tag = have
          ? `${C.green}●${C.reset} ${C.dim}added${C.reset}`
          : `${C.dim}${meta}${C.reset}`
        const label = clip(r.name, Math.max(10, inner - visible(meta) - 14))
        const name = sel
          ? `${C.select}❯ ${C.reset}${flag ? `${flag}  ` : ''}${C.select}${label}${C.reset}`
          : `${C.text}  ${C.reset}${flag ? `${flag}  ` : ''}${C.text}${label}${C.reset}`
        out.push(pad + rowFit(`  ${C.dim}${idx === 0 ? '⎿  ' : '   '}${C.reset}${name}`, [tag, ''], inner))
      })
      const below = total - state.discScroll - listRows
      out.push(below > 0 ? `${pad}     ${C.dim}… ${below} more ↓${C.reset}` : '')
    }
  } else if (state.showSettings) {
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}Settings${C.reset} ${C.dim}(↑↓ · ←→ or enter to change)${C.reset}`)
    SETTING_DEFS.forEach((d, i) => {
      const lead = i === 0 ? '⎿  ' : '   '
      const sel = i === state.settingsCursor
      const val = d.key === 'volume' ? String(state.volume) : (d.labels[settings[d.key]] ?? String(settings[d.key]))
      const line = sel
        ? `${C.select}❯ ${d.label.padEnd(20)}${val}${C.reset}`
        : `${C.text}  ${d.label.padEnd(20)}${val}${C.reset}`
      out.push(`${pad}  ${C.dim}${lead}${C.reset}${line}`)
    })
  } else if (state.showRadios) {
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}Stations${C.reset} ${C.dim}(↑↓ + enter · d add · x remove · p pin · w warm all · c cool)${C.reset}`)
    if (Date.now() - stationNowAt > 15_000) refreshStationNow()
    const namePad = Math.min(24, Math.max(...stations.map((s) => s.name.length)) + 2)
    radioSorted().forEach((st, i) => {
      const lead = i === 0 ? '⎿  ' : '   '
      const sel = i === state.radioCursor
      const warmEntry = parkedFor(st)
      const warmFresh = warmEntry && Date.now() - warmEntry.player.lastProgressAt < 10_000
      const warm = warmEntry && warmFresh
        ? warmEntry.player.progressed
          ? `${C.yellow}●${C.reset} ${C.dim}warm${Number.isFinite(warmEntry.until) ? ` ${mmss(Math.max(1, (warmEntry.until - Date.now()) / 1000))}` : ''}${C.reset}`
          : `${C.accentDim}${spinnerFrame()}${C.reset} ${C.dim}warming…${C.reset}`
        : ''
      const audible = primary?.station ?? state.station
      const tuned =
        st === audible
          ? `${C.green}●${C.reset} ${C.dim}tuned${C.reset}`
          : st === state.station
            ? `${C.accent}${spinnerFrame()}${C.reset} ${C.dim}tuning…${C.reset}`
            : warm
      const flag = st.flag ? `${st.flag}  ` : ''
      const pin = isFavStation(st) ? '\u{1F4CC}' : '  '
      const info = stationInfo(st)
      const rowBreak = Boolean(info?.onBreak)
      const rowTrack = info?.track ?? null
      const nowFav = rowTrack && isFavorite(rowTrack)
      const nowTxt = rowTrack
        ? `${C.dim}${clip(`${rowTrack.title} — ${rowTrack.author}`, Math.max(8, inner - namePad - 32 - (nowFav ? 2 : 0)))}${C.reset}${nowFav ? ` ${C.accent}♥${C.reset}` : ''}`
        : rowBreak
          ? `${C.dim}${C.italic}${
              info.resumeAt && info.resumeAt - Date.now() > 5000
                ? `break · music in ~${mmss((info.resumeAt - Date.now()) / 1000)}`
                : info.resumeAt
                  ? 'break · music any moment'
                  : 'break'
            }${C.reset}`
          : !info && stationNowBusy
            ? `${C.dim}${C.italic}loading…${C.reset}`
            : ''
      const name = sel
        ? `${C.select}❯ ${C.reset}${flag}${C.select}${st.name.padEnd(namePad)}${C.reset}`
        : `${C.text}  ${C.reset}${flag}${C.text}${st.name.padEnd(namePad)}${C.reset}`
      out.push(pad + rowFit(`  ${C.dim}${lead}${C.reset}${name}${pin} ${nowTxt}`, [tuned, ''], inner))
    })
  } else if (state.showWrapped) {
    const s = wrappedStats()
    const wl = []
    wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}tty.fm wrapped${C.reset} ${C.dim}(all time)${C.reset}`)
    if (!s.songs) {
      wl.push(`${pad}  ${C.dim}⎿  no history yet — keep listening${C.reset}`)
    } else {
      wl.push(`${pad}  ${C.dim}⎿  ${s.songs} songs · ${s.artists} artists · ${fmtDur(s.secs * 1000)} listened · since ${s.since}${C.reset}`)
      wl.push(`${pad}     ${C.dim}${s.streak}-day streak · biggest day ${new Date(s.biggestDay[0]).toLocaleDateString('en', { month: 'short', day: 'numeric' })} (${fmtDur(s.biggestDay[1] * 1000)})${C.reset}`)
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}Your vibe${C.reset}`)
      wl.push(`${pad}  ${C.dim}⎿  ${C.reset}${C.yellow}${s.vibe}${C.reset} ${C.dim}— ${s.repeatPct}% repeats, peak around ${String(s.peakHour).padStart(2, '0')}:00${C.reset}`)
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}Top songs${C.reset}`)
      s.topSongs.forEach(([k, n], i) => {
        const lead = i === 0 ? '⎿  ' : '   '
        wl.push(`${pad}  ${C.dim}${lead}${String(i + 1).padStart(2)}${C.reset}  ${clip(k, inner - 14)} ${C.dim}${n}×${C.reset}`)
      })
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}Top artists${C.reset}`)
      s.topArtists.forEach(([k, n], i) => {
        const lead = i === 0 ? '⎿  ' : '   '
        wl.push(`${pad}  ${C.dim}${lead}${String(i + 1).padStart(2)}${C.reset}  ${clip(k, inner - 14)} ${C.dim}${n}×${C.reset}`)
      })
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}Your favorites on air${C.reset}`)
      if (!s.favsOnAir.length) {
        wl.push(`${pad}  ${C.dim}⎿  none aired yet — the radio owes you one${C.reset}`)
      } else {
        wl.push(`${pad}  ${C.dim}⎿  ${s.favHitPct}% of what you heard was a favorite${C.reset}`)
        s.favsOnAir.forEach(([k, n]) => {
          wl.push(`${pad}     ${C.accent}♥${C.reset} ${clip(k, inner - 12)} ${C.dim}${n}×${C.reset}`)
        })
      }
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}Stations${C.reset}`)
      s.stations.forEach(([k, v], i) => {
        const lead = i === 0 ? '⎿  ' : '   '
        const pct = Math.round((v / s.secs) * 100)
        const filled = Math.max(1, Math.round((v / s.secs) * 10))
        wl.push(`${pad}  ${C.dim}${lead}${C.reset}${C.dim}${clip(k, 9).padEnd(9)}${C.reset} ${C.accentDim}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(10 - filled)}  ${pct}%${C.reset}`)
      })
      wl.push('')
      wl.push(`${pad}${C.accent}⏺${C.reset} ${C.text}By month${C.reset}`)
      const maxM = Math.max(...s.months.map(([, v]) => v))
      s.months.forEach(([m, v], i) => {
        const lead = i === 0 ? '⎿  ' : '   '
        const label = new Date(`${m}-01T00:00:00`).toLocaleDateString('en', { month: 'short', year: 'numeric' })
        const filled = Math.max(1, Math.round((v / maxM) * 10))
        wl.push(`${pad}  ${C.dim}${lead}${C.reset}${C.dim}${label.padEnd(9)}${C.reset} ${C.accentDim}${'█'.repeat(filled)}${C.reset}${C.dim}${'░'.repeat(10 - filled)}  ${fmtDur(v * 1000)}${C.reset}`)
      })
      wl.push('')
      wl.push(`${pad}  ${C.dim}favorites ${favorites.length} · this session ${fmtDur(Date.now() - sessionStart)}${state.hops ? ` · ${state.hops} hop${state.hops === 1 ? '' : 's'}` : ''}${C.reset}`)
    }
    const bottomEst = 5 + (state.showHelp ? 1 : 0) + (state.swapping ? 1 : 0)
    const noteEst =
      (state.note && Date.now() - state.noteAt < NOTE_MS ? 2 : 0) +
      (state.failStreak >= book.entries.length && book.entries.length ? 2 : 0)
    const rowsAvail = Math.max(6, (process.stdout.rows || 24) - out.length - bottomEst - noteEst - 2)
    const maxScroll = Math.max(0, wl.length - rowsAvail)
    if (state.wrapScroll > maxScroll) state.wrapScroll = maxScroll
    out.push(state.wrapScroll > 0 ? `${pad}${C.dim}… ↑${C.reset}` : '')
    out.push(...wl.slice(state.wrapScroll, state.wrapScroll + rowsAvail))
    out.push(wl.length - state.wrapScroll > rowsAvail ? `${pad}${C.dim}… ↓ scroll${C.reset}` : '')
  } else if (state.showHistory) {
    const list = [...history].reverse()
    const total = list.length
    out.push(
      `${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}History${C.reset} ${C.dim}(${total})${C.reset}${total ? ` ${C.dim}· ↑↓ + f to favorite${C.reset}` : ''}`,
    )
    if (!total) {
      out.push(`${pad}  ${C.dim}⎿  nothing yet — songs land here as they play${C.reset}`)
    } else {
      const bottomEst = 5 + (state.showHelp ? 1 : 0) + (state.swapping ? 1 : 0)
      const noteEst =
        (state.note && Date.now() - state.noteAt < NOTE_MS ? 2 : 0) +
        (state.failStreak >= book.entries.length && book.entries.length ? 2 : 0)
      const listRows = Math.max(4, (process.stdout.rows || 24) - out.length - bottomEst - noteEst - 2)
      state.histCursor = Math.min(state.histCursor, total - 1)
      if (state.histCursor < state.histScroll) state.histScroll = state.histCursor
      if (state.histCursor >= state.histScroll + listRows) state.histScroll = state.histCursor - listRows + 1
      out.push(state.histScroll > 0 ? `${pad}     ${C.dim}… ${state.histScroll} more ↑${C.reset}` : '')
      list.slice(state.histScroll, state.histScroll + listRows).forEach((t, i) => {
        const idx = state.histScroll + i
        const lead = idx === state.histScroll && !state.histScroll ? '⎿  ' : '   '
        const sel = idx === state.histCursor
        const heart = isFavorite(t) ? `${C.accent}♥${C.reset} ` : ''
        const name = sel
          ? `${C.select}❯ ${C.reset}${heart}${C.select}${clip(`${t.title} — ${t.author}`, inner - 16)}${C.reset}`
          : `${C.text}  ${C.reset}${heart}${C.text}${clip(`${t.title} — ${t.author}`, inner - 16)}${C.reset}`
        out.push(pad + rowFit(`  ${C.dim}${lead}${C.reset}${name}`, [`${C.dim}${fmtAgo(t.at)}${C.reset}`, ''], inner))
      })
      const below = total - state.histScroll - listRows
      out.push(below > 0 ? `${pad}     ${C.dim}… ${below} more ↓${C.reset}` : '')
    }
  } else if (state.showFavs) {
    const list = [...favorites].reverse()
    const total = list.length
    out.push(
      `${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}Favorites${C.reset} ${C.dim}(${total})${C.reset}${total ? ` ${C.dim}· ↑↓ + f to remove${C.reset}` : ''}`,
    )
    if (!total) {
      out.push(`${pad}  ${C.dim}⎿  none yet — press f while a song plays${C.reset}`)
    } else {
      const bottomEst = 5 + (state.showHelp ? 1 : 0) + (state.swapping ? 1 : 0)
      const noteEst =
        (state.note && Date.now() - state.noteAt < NOTE_MS ? 2 : 0) +
        (state.failStreak >= book.entries.length && book.entries.length ? 2 : 0)
      const listRows = Math.max(4, (process.stdout.rows || 24) - out.length - bottomEst - noteEst - 2)
      state.favCursor = Math.min(state.favCursor, total - 1)
      if (state.favCursor < state.favScroll) state.favScroll = state.favCursor
      if (state.favCursor >= state.favScroll + listRows) state.favScroll = state.favCursor - listRows + 1
      out.push(state.favScroll > 0 ? `${pad}     ${C.dim}… ${state.favScroll} more ↑${C.reset}` : '')
      list.slice(state.favScroll, state.favScroll + listRows).forEach((f, i) => {
        const idx = state.favScroll + i
        const lead = idx === state.favScroll && !state.favScroll ? '⎿  ' : '   '
        const sel = idx === state.favCursor
        const name = sel
          ? `${C.select}❯ ${C.reset}${C.accent}♥${C.reset} ${C.select}${clip(`${f.title} — ${f.author}`, inner - 16)}${C.reset}`
          : `${C.text}  ${C.reset}${C.accent}♥${C.reset} ${C.text}${clip(`${f.title} — ${f.author}`, inner - 16)}${C.reset}`
        out.push(pad + rowFit(`  ${C.dim}${lead}${C.reset}${name}`, [`${C.dim}${fmtAgo(f.at)}${C.reset}`, ''], inner))
      })
      const below = total - state.favScroll - listRows
      out.push(below > 0 ? `${pad}     ${C.dim}… ${below} more ↓${C.reset}` : '')
    }
  } else if (!state.station) {
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}no stations yet${C.reset}`)
    out.push(`${pad}  ${C.dim}⎿  press ${C.bold}d${C.reset}${C.dim} to search and add one${C.reset}`)
    out.push(`${pad}     ${C.dim}or hand-write them into ${clip(JSON_PATH, Math.max(12, inner - 8))}${C.reset}`)
  } else if (state.error && !cur) {
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}playlist unavailable${C.reset} ${C.dim}(${state.error})${C.reset}`)
    out.push(`${pad}  ${C.dim}⎿  audio keeps playing — titles will return${C.reset}`)
  } else if (!ready) {
    out.push(
      `${pad}${C.accent}${spinnerFrame()}${C.reset} ${C.dim}${C.italic}${state.verb}…${C.reset} ${C.dim}(tuning to ${state.station?.name ?? ''})${C.reset}`,
    )
  } else if (inBreak()) {
    if (prevs.length) {
      for (const p of prevs) {
        const h = isFavorite(p) ? ` ${C.accent}♥${C.reset}` : ''
        out.push(`${pad}${C.dim}⏺ ${clip(`${p.title} — ${p.author}`, inner - 4)}${C.reset}${h}`)
      }
      out.push('')
    }
    const resume = next
      ? next.uptime - (Number(next.lenght) || 0) - driftSeconds() + (primary?.cacheSeconds ?? 0)
      : -999
    const duckTag = state.ducked
      ? ` ${C.accentDim}· ${settings.breakAudio === 'mute' ? 'muted' : 'volume lowered'} until music returns${C.reset}`
      : ''
    const blockKind = isJingle(cur) ? 'station block — mix, ads or promos' : 'break — ads, jingles or talk'
    const [kindHead, kindTail] = blockKind.split(' — ')
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${kindHead}${C.reset} ${C.dim}— ${clip(kindTail, Math.max(8, inner - kindHead.length - 4))}${C.reset}${duckTag}`)
    const eta = state.paused
      ? 'resume to rejoin live'
      : resume > 5
        ? `listed songs back in ~${mmss(resume)}`
        : resume > -10
          ? 'listed songs back any moment now'
          : "their playlist is lagging — song data soon"
    out.push(`${pad}  ${C.dim}⎿  ${clip(`not tracked in RMF's playlist — ${eta}`, Math.max(8, inner - 5))}${C.reset}`)
    if (next) {
      out.push('')
      const h = isFavorite(next) ? ` ${C.accent}♥${C.reset}` : ''
      out.push(`${pad}${C.dim}○ ${clip(`${next.title} — ${next.author}`, inner - 14)} (up next)${C.reset}${h}`)
    }
    if (isJingle(cur) || resume < -10) {
      out.push('')
      out.push(`${pad}${C.yellow}⚠${C.reset} ${C.dim}${clip('some features unavailable — no song data', Math.max(8, inner - 3))}${C.reset}`)
    }
  } else if (cur) {
    const len = Number(cur.lenght) || 0
    let elapsed = elapsedOf(cur)
    const flowing = !state.paused && primary && !primary.dead && !primary.buffering && !stalledNow
    if (!state.paused) {
      if (!flowing) {
        if (frozenElapsed === null) frozenElapsed = elapsed
        elapsed = Math.min(elapsed, frozenElapsed)
      } else {
        frozenElapsed = null
      }
    }
    if (prevs.length) {
      for (const p of prevs) {
        const h = isFavorite(p) ? ` ${C.accent}♥${C.reset}` : ''
        out.push(`${pad}${C.dim}⏺ ${clip(`${p.title} — ${p.author}`, inner - 4)}${C.reset}${h}`)
      }
      out.push('')
    }
    const title = clip(cur.title, Math.max(8, inner - 5 - cur.author.length))
    const heart = isFavorite(cur) ? ` ${C.accent}♥${C.reset}` : ''
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}${title}${C.reset} ${C.dim}— ${clip(cur.author, inner - 12)}${C.reset}${heart}`)
    const stallTag = !flowing && !state.paused ? ` ${C.accentDim}${spinnerFrame()}${C.reset}` : ''
    out.push(
      len
        ? `${pad}  ${C.dim}⎿${C.reset}  ${bar(elapsed / len, Math.min(40, Math.max(4, inner - 20)))} ${C.dim}${mmss(elapsed)} / ${mmss(len)}${C.reset}${stallTag}`
        : `${pad}  ${C.dim}⎿  live — no timing from this stream${C.reset}${stallTag}`,
    )
    if (next) {
      out.push('')
      const h = isFavorite(next) ? ` ${C.accent}♥${C.reset}` : ''
      out.push(`${pad}${C.dim}○ ${clip(`${next.title} — ${next.author}`, inner - 14)} (up next)${C.reset}${h}`)
    }
  } else if (state.station?.playlistId == null) {
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${state.station?.name ?? 'live'}${C.reset} ${C.dim}— playing${C.reset}`)
    out.push(`${pad}  ${C.dim}⎿  no song title yet — this stream only announces one at each track change${C.reset}`)
  } else {
    out.push(`${pad}${C.accent}${spinnerFrame()}${C.reset} ${C.dim}${C.italic}${state.verb}…${C.reset} ${C.dim}(fetching playlist)${C.reset}`)
  }

  if (firstRun && !anyView) {
    out.push('')
    out.push(`${pad}${C.accent}⏺${C.reset} ${C.text}${C.bold}welcome to tty.fm${C.reset}`)
    out.push(`${pad}  ${C.dim}⎿  music is already playing — that was the whole setup${C.reset}`)
    out.push(`${pad}     ${C.dim}${C.bold}d${C.reset}${C.dim} find stations · ${C.bold}r${C.reset}${C.dim} switch station · ${C.bold}f${C.reset}${C.dim} favorite a song · ${C.bold}?${C.reset}${C.dim} all shortcuts${C.reset}`)
  }

  if (state.note && Date.now() - state.noteAt < NOTE_MS) {
    const warn = state.note.startsWith('⚠ ')
    const dot = warn ? `${C.yellow}⏺${C.reset}` : `${C.green}⏺${C.reset}`
    out.push('')
    out.push(`${pad}${dot} ${C.dim}${clip(warn ? state.note.slice(2) : state.note, inner - 2)}${C.reset}`)
  }

  if (state.failStreak >= book.entries.length && book.entries.length) {
    out.push('')
    out.push(`${pad}${C.red}⏺ all mirrors struggling — still trying${C.reset}`)
  }

  const bottom = ['']
  if (state.swapping) {
    bottom.push(
      `${pad}${C.accent}${spinnerFrame()} ${C.italic}${state.verb}…${C.reset} ${C.dim}(${fmtDur(Date.now() - state.swapStartedAt)} · ${hostOf(state.warming ?? '')})${C.reset}`,
    )
  }
  bottom.push(rule)
  const eq = !primary || primary.dead || !ready
    ? ''
    : `${state.paused ? C.dim : C.accentDim}${eqFrame()}${C.reset}`
  const mount = primary ? ` · ${hostOf(primary.url).toUpperCase()}` : ''
  const station = ((primary?.station ?? state.station)?.name ?? '').toUpperCase()
  const plate = station ? `${C.yellow}[${station}${mount}]${C.reset}` : `${C.dim}[no station]${C.reset}`
  bottom.push(pad + rowFit(plate, [eq, ''], inner))
  const ipcDown = primary?.ipcFailed && !primary.dead && !state.swapping
  const breakColor = { off: C.dim, duck: C.purple, mute: C.red, hop: C.green }[settings.breakAudio]
  const breakLabel = {
    off: 'do nothing',
    duck: 'lower volume',
    mute: 'mute',
    hop: 'hop stations',
  }[settings.breakAudio]
  const mode = ipcDown
    ? `${C.red}⚠ no ipc${C.reset} ${C.dim}— pause/volume unavailable${C.reset}`
    : state.paused
      ? `${C.accent}⏸ paused${C.reset} ${C.dim}(space to resume)${C.reset}`
      : `${breakColor}⏵⏵ during breaks: ${breakLabel}${C.reset} ${C.dim}${Date.now() < breakModeArmAt ? `(applying in ${Math.ceil((breakModeArmAt - Date.now()) / 1000)}…)` : '(shift+tab to cycle)'}${state.hops ? ` · ${state.hops} hop${state.hops === 1 ? '' : 's'}` : ''}${C.reset}`
  const modeShort = ipcDown
    ? `${C.red}⚠ no ipc${C.reset}`
    : state.paused
      ? `${C.accent}⏸ paused${C.reset}`
      : `${breakColor}⏵⏵ during breaks: ${breakLabel}${C.reset}`
  const volBase = state.muted ? 'muted' : state.ducked && chipLive ? `${state.volume} lowered` : state.volume
  const volLabel = `${volBase}${settings.audioMode === 'normal' ? '' : ` · ${settings.audioMode}`}`
  const hint = state.showHelp
    ? `${C.dim}vol ${volLabel}${C.reset}`
    : `${C.dim}vol ${volLabel} · ? for shortcuts${C.reset}`
  const hintShort = `${C.dim}vol ${volLabel}${C.reset}`
  const modeLeft = visible(mode) + visible(hintShort) + 1 <= inner ? mode : modeShort
  bottom.push(pad + rowFit(modeLeft, [hint, hintShort, ''], inner))
  if (state.showHelp) {
    bottom.push(`${pad}${C.dim}space pause · m mute · ↑↓ vol · ←→ station · 1-9 station · shift+tab break mode · a audio mode · f favorite · v favorites · h history · r stations · d discover · w wrapped · s settings · n hop · q quit${C.reset}`)
  }
  bottom.push('')

  const rows = process.stdout.rows || 24
  const avail = Math.max(3, rows - bottom.length)
  const top =
    out.length > avail ? [...out.slice(0, Math.max(1, avail - 1)), `${pad}${C.dim}…${C.reset}`] : out
  const filler = Math.max(0, rows - top.length - bottom.length)
  process.stdout.write(`\x1b[H\x1b[J${[...top, ...Array(filler).fill(''), ...bottom].join('\n')}`)
}

let renderTimer = null
let watchdogTimer = null
let stationNowTimer = null
let shuttingDown = false

function cleanup() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(renderTimer)
  clearInterval(watchdogTimer)
  clearInterval(stationNowTimer)
  clearTimeout(pollTimer)
  primary?.mpv.stop()
  standby?.mpv.stop()
  dropParked()
  try {
    writeFileSync(SETTINGS_PATH, JSON.stringify(settingsSnapshot(), null, 2))
  } catch {}
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdout.write('\x1b]0;\x07')
  process.stdout.write(ALT_OFF)
}

function adjustVolume(delta) {
  state.muted = false
  const prev = state.volume
  state.volume = Math.max(0, Math.min(100, state.volume + delta))
  if (state.ducked) state.duckApplied = duckLevel()
  if (!primary?.mpv.setVolume(mpvVol(effVol()))) state.volume = prev
}

let discTimer = null
let discEpoch = 0

function queueDiscoverSearch() {
  clearTimeout(discTimer)
  state.discError = null
  const local = builtinSearch(state.discQuery)
  state.discResults = local
  state.discCursor = 0
  state.discScroll = 0
  if (!state.discQuery.trim()) {
    discEpoch++
    state.discBusy = false
    state.discRan = false
    return
  }
  state.discBusy = true
  discTimer = setTimeout(async () => {
    const mine = ++discEpoch
    try {
      const hits = await rbSearch(state.discQuery)
      if (mine !== discEpoch) return
      state.discResults = [...local, ...hits]
    } catch (err) {
      if (mine !== discEpoch) return
      state.discResults = local
      state.discError = err.message
    } finally {
      if (mine === discEpoch) {
        state.discBusy = false
        state.discRan = true
        render()
      }
    }
  }, 280)
}

function openDiscover(open = true) {
  state.showDiscover = open
  state.showFavs = false
  state.showRadios = false
  state.showWrapped = false
  state.showHistory = false
  state.showSettings = false
  if (open) {
    state.discCursor = 0
    state.discScroll = 0
    queueDiscoverSearch()
  }
}

function onKey(buf) {
  const key = buf.toString()
  firstRun = false
  if (state.showDiscover && key !== '\x03') {
    if (key === '\x1b') {
      openDiscover(false)
      render()
      return
    }
    if (key === '\x1b[A' || key === '\x1b[B') {
      const max = Math.max(0, state.discResults.length - 1)
      state.discCursor = Math.min(max, Math.max(0, state.discCursor + (key === '\x1b[B' ? 1 : -1)))
      render()
      return
    }
    if (key === '\r' || key === '\n') {
      const hit = state.discResults[state.discCursor]
      if (hit) {
        const st = addStation(hit)
        openDiscover(false)
        if (st && st !== state.station) {
          lastFleeAt = 0
          tuneTo(stations.indexOf(st))
        }
      }
      render()
      return
    }
    if (key === '\x7f' || key === '\x08') {
      state.discQuery = [...state.discQuery].slice(0, -1).join('')
      queueDiscoverSearch()
      render()
      return
    }
    if (key === '\x15') {
      state.discQuery = ''
      queueDiscoverSearch()
      render()
      return
    }
    if (key.startsWith('\x1b')) return
    const typed = [...key].filter((c) => c >= ' ' && c !== '\x7f').join('')
    if (typed) {
      state.discQuery = (state.discQuery + typed).slice(0, 60)
      queueDiscoverSearch()
      render()
      return
    }
    return
  }
  if (state.showSettings) {
    const d = SETTING_DEFS[state.settingsCursor]
    if (key === '\x1b[A' || key === '\x1b[B') {
      const dir = key === '\x1b[A' ? -1 : 1
      state.settingsCursor = (state.settingsCursor + dir + SETTING_DEFS.length) % SETTING_DEFS.length
      render()
      return
    }
    if (d && (key === '\r' || key === '\n' || key === '\x1b[C' || key === '\x1b[D')) {
      const dir = key === '\x1b[D' ? -1 : 1
      if (d.key === 'volume') {
        adjustVolume(dir * 5)
        saveSettings()
      } else {
        const i = d.values.indexOf(settings[d.key])
        settings[d.key] = d.values[(i + dir + d.values.length) % d.values.length]
        saveSettings()
        onSettingChanged(d.key)
      }
      render()
      return
    }
  }
  if (state.showRadios) {
    if (key === '\x1b[A' || key === '\x1b[B') {
      const d = key === '\x1b[A' ? -1 : 1
      state.radioCursor = (state.radioCursor + d + stations.length) % stations.length
      render()
      return
    }
    if (key === '\r' || key === '\n') {
      const target = radioSorted()[state.radioCursor]
      if (target === state.station) state.showRadios = false
      else {
        lastFleeAt = 0
        tuneTo(stations.indexOf(target))
      }
      render()
      return
    }
    if (key === 'p') {
      const st = radioSorted()[state.radioCursor]
      if (st) {
        const i = settings.favStations.indexOf(st.uid)
        if (i >= 0) {
          if (!confirmTwice('pin', st.uid, `unpin ${st.name}`)) {
            render()
            return
          }
          settings.favStations.splice(i, 1)
        } else {
          settings.favStations.push(st.uid)
        }
        saveSettings()
        state.radioCursor = Math.max(0, radioSorted().indexOf(st))
      }
      render()
      return
    }
    if (key === 'f') {
      const st = radioSorted()[state.radioCursor]
      const tr = stationInfo(st)?.track ?? null
      if (tr) toggleFavoriteTrack(tr)
      else setNote("⚠ can't favorite — no song data for that station")
      render()
      return
    }
    if (key === 'x' || isDeleteKey(key)) {
      const st = radioSorted()[state.radioCursor]
      if (st && confirmTwice('drop', st.uid, `remove ${st.name}`)) {
        removeStation(st)
        state.radioCursor = Math.min(state.radioCursor, Math.max(0, stations.length - 1))
      }
      render()
      return
    }
    if (key === 'w') {
      warmAll()
      render()
      return
    }
    if (key === 'c') {
      const n = parkedList.length
      dropParked()
      setNote(n ? `cooled ${n} warm station${n === 1 ? '' : 's'}` : 'nothing was warm')
      render()
      return
    }
  }
  if (state.showWrapped && (key === '\x1b[A' || key === '\x1b[B')) {
    state.wrapScroll = Math.max(0, state.wrapScroll + (key === '\x1b[B' ? 1 : -1))
    render()
    return
  }
  if (state.showHistory && (key === '\x1b[A' || key === '\x1b[B')) {
    const max = Math.max(0, history.length - 1)
    state.histCursor = Math.min(max, Math.max(0, state.histCursor + (key === '\x1b[B' ? 1 : -1)))
    render()
    return
  }
  if (state.showFavs && (key === '\x1b[A' || key === '\x1b[B')) {
    const max = Math.max(0, favorites.length - 1)
    state.favCursor = Math.min(max, Math.max(0, state.favCursor + (key === '\x1b[B' ? 1 : -1)))
    render()
    return
  }
  switch (key) {
    case ' ':
    case 'p': {
      if (!primary?.mpv.connected) break
      const want = !state.paused
      state.paused = want
      if (want) {
        state.pausedSince = Date.now()
        state.pausedAt = Date.now()
        state.pausedCacheSnap = primary.cacheSeconds
        danceUntil = Date.now() + PAUSE_FADE_MS + 250
        standby?.mpv.setPause(true)
        fadeVolume(effVol(), 0, PAUSE_FADE_MS, () => {
          cmdPause(primary, true)
        })
      } else {
        const pausedFor = Date.now() - (state.pausedAt || Date.now())
        state.pausedSince = 0
        state.pausedAt = 0
        if (pausedFor > 60_000) {
          primary.stale = true
          state.rejoining = true
          failover('rejoining live', { blame: false })
        } else {
          const backlog = primary.cacheSeconds
          if (backlog > LIVE_TARGET + 1) primary.mpv.seek(backlog - LIVE_TARGET)
          else state.pausedTotal += pausedFor
          primary.lastProgressAt = Date.now()
          primary.mpv.setVolume(0)
          cmdPause(primary, false)
          standby?.mpv.setPause(false)
          fadeVolume(0, effVol(), PAUSE_FADE_MS)
        }
      }
      break
    }
    case '\x1b[A':
    case '+':
    case '=': {
      adjustVolume(5)
      break
    }
    case '\x1b[B':
    case '-': {
      adjustVolume(-5)
      break
    }
    case '\x1b[C':
      stepStation(1)
      break
    case '\x1b[D':
      stepStation(-1)
      break
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9': {
      const st = radioSorted()[Number(key) - 1]
      if (!st) setNote(`no station ${key}`)
      else if (st === state.station) setNote(`already on ${st.name}`)
      else {
        lastFleeAt = 0
        tuneTo(stations.indexOf(st))
      }
      break
    }
    case 'n':
      failover('manual hop', { blame: false })
      break
    case 'm': {
      if (state.paused || !primary?.mpv.connected) break
      const from = effVol()
      state.muted = !state.muted
      fadeVolume(from, effVol(), PAUSE_FADE_MS)
      break
    }
    case 'a': {
      const values = SETTING_DEFS.find((d) => d.key === 'audioMode').values
      const i = values.indexOf(settings.audioMode)
      settings.audioMode = values[(i + 1) % values.length]
      saveSettings()
      onSettingChanged('audioMode')
      break
    }
    case 'f': {
      if (state.showHistory) {
        const sel = [...history].reverse()[state.histCursor]
        if (sel) toggleFavoriteTrack(sel)
      } else if (state.showFavs) {
        const sel = [...favorites].reverse()[state.favCursor]
        if (sel) toggleFavoriteTrack(sel)
      } else toggleFavorite()
      break
    }
    case 'h':
      state.showHistory = !state.showHistory
      state.showFavs = false
      state.showRadios = false
      state.showWrapped = false
      state.showSettings = false
      state.showDiscover = false
      state.histCursor = 0
      state.histScroll = 0
      break
    case 'v':
      state.showFavs = !state.showFavs
      state.showRadios = false
      state.showWrapped = false
      state.showHistory = false
      state.showSettings = false
      state.showDiscover = false
      state.favScroll = 0
      state.favCursor = 0
      break
    case 'd':
      openDiscover(!state.showDiscover)
      break
    case 'r':
      state.showRadios = !state.showRadios
      state.showFavs = false
      state.showWrapped = false
      state.showHistory = false
      state.showSettings = false
      state.showDiscover = false
      if (state.showRadios) state.radioCursor = Math.max(0, radioSorted().indexOf(state.station))
      break
    case 'w':
      state.showWrapped = !state.showWrapped
      state.showFavs = false
      state.showRadios = false
      state.showHistory = false
      state.showSettings = false
      state.showDiscover = false
      state.wrapScroll = 0
      break
    case 's':
      state.showSettings = !state.showSettings
      state.showFavs = false
      state.showRadios = false
      state.showWrapped = false
      state.showHistory = false
      state.showDiscover = false
      state.settingsCursor = 0
      break
    case '\x1b[Z': {
      const values = SETTING_DEFS.find((d) => d.key === 'breakAudio').values
      const i = values.indexOf(settings.breakAudio)
      settings.breakAudio = values[(i + 1) % values.length]
      saveSettings()
      onSettingChanged('breakAudio')
      break
    }
    case '\x1b':
      state.showFavs = false
      state.showRadios = false
      state.showWrapped = false
      state.showHistory = false
      state.showSettings = false
      state.showDiscover = false
      break
    case '?':
      state.showHelp = !state.showHelp
      break
    case 'q':
    case '\x03':
      cleanup()
      process.exit(0)
      break
  }
  render()
}

const MPV_HINT =
  process.platform === 'win32'
    ? 'scoop install mpv    (or: winget install mpv)'
    : process.platform === 'darwin'
      ? 'brew install mpv'
      : 'sudo apt install mpv    (or your distro package manager)'

function mpvRuns(bin) {
  return new Promise((done) => {
    const p = spawn(bin, ['--version'], { stdio: 'ignore' })
    p.on('error', () => done(false))
    p.on('exit', (code) => done(code === 0))
  })
}

async function mpvPresent() {
  if (await mpvRuns(MPV_BIN)) return true
  if (process.platform !== 'win32') return false
  for (const bin of WIN_MPV_PATHS) {
    if (!existsSync(bin)) continue
    if (await mpvRuns(bin)) {
      MPV_BIN = bin
      return true
    }
  }
  return false
}

function normalizeStations(list) {
  return list
    .map((s) => {
      const mirrors = [...new Set((s.mirrors ?? []).filter((m) => typeof m === 'string' && m))]
      const playlistId = Number.isFinite(Number(s.id)) && s.id !== null && s.id !== '' ? Number(s.id) : null
      const src = playlistId == null ? null : PLAYLISTS[s.src] ? s.src : 'rmf'
      const uid = s.uid ?? (src ? `${src}:${playlistId}` : mirrors[0] ? `url:${mirrors[0]}` : null)
      return { uid, name: s.name, flag: s.flag ?? '', src, playlistId, mirrors }
    })
    .filter((s) => s.uid && s.mirrors.length && s.name)
}

const GENERIC_BRANDS = new Set(['radio', 'the', 'fm', 'music', 'hits', 'mix'])

function refreshJingleRe() {
  const brands = [...new Set(stations.map((s) => s.name.split(' ')[0].replace(/[^\w]/g, '')))].filter(
    (b) => b.length > 2 && !GENERIC_BRANDS.has(b.toLowerCase()),
  )
  jingleRe = brands.length ? new RegExp(`\\b(${brands.join('|')})\\b`, 'i') : null
}

async function main() {
  ensureHome()
  if (!(await mpvPresent())) {
    console.error('ttyfm needs mpv to play audio, and it is not on your PATH.')
    console.error(`install it with:  ${MPV_HINT}`)
    process.exit(1)
  }
  let raw = {}
  try {
    raw = JSON.parse(await readFile(JSON_PATH, 'utf8'))
  } catch {}
  stations = normalizeStations(raw.stations ?? [])
  refreshJingleRe()
  state.station = stations[0] ?? null
  if (state.station) book.load(state.station.mirrors)

  process.stdout.write(ALT_ON)
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onKey)
  }

  await loadPersisted()
  refreshStationDefs()
  const wantSt =
    settings.startupStation === 'last'
      ? stations.find((s) => s.uid === settings.lastStationId)
      : settings.startupStation === 'default'
        ? stations[0]
        : stations.find((s) => s.uid === String(settings.startupStation))
  if (wantSt) {
    state.station = wantSt
    book.load(wantSt.mirrors)
  }
  const wantVol =
    settings.startupVolume === 'last'
      ? settings.volume
      : settings.startupVolume === 'default'
        ? 80
        : Number(settings.startupVolume)
  if (Number.isFinite(wantVol)) {
    state.volume = Math.max(0, Math.min(100, Math.round(wantVol)))
  }
  if (state.station) {
    startPrimary()
    probeMirrors()
    render()
    await fetchPlaylist()
    schedulePoll()
  } else {
    openDiscover(true)
    render()
  }
  render()

  if (settings.warmOnStartup !== 'off') {
    setTimeout(() => {
      if (!shuttingDown) {
        warmAll(settings.warmOnStartup === 'favs')
        render()
      }
    }, 3000)
  }

  process.stdout.on('resize', render)
  renderTimer = setInterval(render, 100)
  watchdogTimer = setInterval(watchdog, 1000)
  refreshStationNow()
  stationNowTimer = setInterval(() => {
    if (Date.now() - stationNowAt > 25_000) refreshStationNow()
  }, 30_000)
}

main().catch((err) => {
  cleanup()
  console.error(err)
  process.exit(1)
})
