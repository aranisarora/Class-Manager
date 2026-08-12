'use client'

/**
 * Sample inbound media for the composer (§14.5 — multimodal in).
 *
 * Both are generated in the browser rather than shipped as assets, so the emulator has no
 * binary dependencies: the image is a drawn timetable photo, the voice note is a real WAV
 * with speech-shaped bursts. They go to `/api/emulator/inbound` as `mediaUrl` data URIs,
 * which is exactly the shape the media pipeline receives from a fetched Meta media id.
 */

let timetableCache: string | null = null
let voiceCache: string | null = null

/** A photographed timetable — the §7.1 data-entry case, as an image. */
export function sampleTimetableImage(): string {
  if (timetableCache) return timetableCache
  const W = 620
  const H = 440
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  if (!g) return ''

  // paper, slightly warm and unevenly lit like a phone photo
  g.fillStyle = '#efe9dd'
  g.fillRect(0, 0, W, H)
  const glare = g.createRadialGradient(W * 0.72, H * 0.18, 20, W * 0.72, H * 0.18, W * 0.8)
  glare.addColorStop(0, 'rgba(255,255,255,0.55)')
  glare.addColorStop(1, 'rgba(120,110,95,0.12)')
  g.fillStyle = glare
  g.fillRect(0, 0, W, H)

  g.strokeStyle = 'rgba(60,55,45,0.25)'
  g.lineWidth = 1
  for (let y = 96; y < H - 20; y += 34) {
    g.beginPath()
    g.moveTo(28, y)
    g.lineTo(W - 28, y)
    g.stroke()
  }

  g.fillStyle = '#1e232b'
  g.font = 'bold 26px Georgia, serif'
  g.fillText('WEEKLY TIMETABLE', 28, 48)
  g.font = '15px Georgia, serif'
  g.fillStyle = '#3b4250'
  g.fillText('Green Park Court · from 1 July', 28, 72)

  const rows: [string, string, string][] = [
    ['MON / WED / FRI', '6:30 – 7:30 pm', 'Beginners'],
    ['MON / WED / FRI', '7:30 – 9:00 pm', 'Advanced'],
    ['SAT', '8:00 – 10:00 am', 'Advanced'],
    ['SAT', '10:00 – 11:00 am', 'Sub-junior'],
    ['SUN', '7:00 – 8:30 am', 'Match practice'],
  ]
  g.font = '16px Georgia, serif'
  rows.forEach(([day, time, name], i) => {
    const y = 120 + i * 34
    g.fillStyle = '#1e232b'
    g.fillText(day, 34, y)
    g.fillStyle = '#2a3140'
    g.fillText(time, 250, y)
    g.fillStyle = '#1e232b'
    g.fillText(name, 420, y)
  })

  g.strokeStyle = 'rgba(20,25,35,0.35)'
  g.lineWidth = 2
  g.strokeRect(20, 20, W - 40, H - 40)

  timetableCache = c.toDataURL('image/png')
  return timetableCache
}

function encodeWav(samples: Float32Array, rate: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return `data:audio/wav;base64,${btoa(binary)}`
}

/** A short voice note — audio goes to the model natively (§14.5), so it must be real bytes. */
export function sampleVoiceNote(): string {
  if (voiceCache) return voiceCache
  const rate = 8000
  const seconds = 2.4
  const n = Math.floor(rate * seconds)
  const out = new Float32Array(n)
  // Four syllable-shaped bursts with a wandering pitch — a stand-in utterance, not a beep.
  const bursts = [
    { start: 0.1, len: 0.42, f0: 132 },
    { start: 0.62, len: 0.3, f0: 154 },
    { start: 1.02, len: 0.55, f0: 118 },
    { start: 1.72, len: 0.5, f0: 143 },
  ]
  for (let i = 0; i < n; i++) {
    const t = i / rate
    let v = 0
    for (const b of bursts) {
      if (t < b.start || t > b.start + b.len) continue
      const p = (t - b.start) / b.len
      const env = Math.sin(Math.PI * p) ** 1.6
      const f = b.f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 1.7 * t))
      v +=
        env *
        (0.55 * Math.sin(2 * Math.PI * f * t) +
          0.25 * Math.sin(4 * Math.PI * f * t) +
          0.12 * Math.sin(6 * Math.PI * f * t) +
          0.08 * (Math.random() * 2 - 1))
    }
    out[i] = v * 0.6
  }
  voiceCache = encodeWav(out, rate)
  return voiceCache
}
