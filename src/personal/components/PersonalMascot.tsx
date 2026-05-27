import type { CSSProperties } from 'react'
import type { MascotMood, MoodResult } from '../services/mascotMoodService'

// ── Mood config ───────────────────────────────────────────────────────────────

interface MoodConfig {
  eyes: { ry: number; pupilR: number; isClosed?: boolean; isStars?: boolean }
  mouth: 'smile' | 'bigsmile' | 'frown' | 'straight' | 'open'
  extra: 'sparkles' | 'zzz' | null
  animation: 'float' | 'bounce' | 'pulse' | 'slow-float' | 'sway'
  gradient: string
  border: string
  avatarBg: string
  avatarGlow: string
  labelColor: string
  title: string
}

const MOOD_CONFIG: Record<MascotMood, MoodConfig> = {
  calm: {
    eyes: { ry: 3.5, pupilR: 2.5 }, mouth: 'smile', extra: null, animation: 'float',
    gradient:  'linear-gradient(145deg, rgba(52,211,153,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(52,211,153,0.2)',
    avatarBg:  'rgba(52,211,153,0.1)',
    avatarGlow:'rgba(52,211,153,0.2)',
    labelColor:'#34d399', title: 'Michi está tranquila',
  },
  happy: {
    eyes: { ry: 5.5, pupilR: 3.5 }, mouth: 'smile', extra: null, animation: 'float',
    gradient:  'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(52,211,153,0.28)',
    avatarBg:  'rgba(52,211,153,0.13)',
    avatarGlow:'rgba(52,211,153,0.28)',
    labelColor:'#4ade80', title: 'Michi está contenta',
  },
  proud: {
    eyes: { ry: 5, pupilR: 3 }, mouth: 'bigsmile', extra: null, animation: 'float',
    gradient:  'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(52,211,153,0.28)',
    avatarBg:  'rgba(52,211,153,0.13)',
    avatarGlow:'rgba(52,211,153,0.28)',
    labelColor:'#4ade80', title: 'Michi está orgullosa',
  },
  motivated: {
    eyes: { ry: 6.5, pupilR: 4 }, mouth: 'smile', extra: null, animation: 'bounce',
    gradient:  'linear-gradient(145deg, rgba(96,165,250,0.08) 0%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(96,165,250,0.22)',
    avatarBg:  'rgba(96,165,250,0.1)',
    avatarGlow:'rgba(96,165,250,0.2)',
    labelColor:'#60a5fa', title: 'Michi está motivada',
  },
  worried: {
    eyes: { ry: 5, pupilR: 3 }, mouth: 'frown', extra: null, animation: 'pulse',
    gradient:  'linear-gradient(145deg, rgba(251,191,36,0.07) 0%, rgba(4,7,15,0.76) 100%)',
    border:    'rgba(251,191,36,0.22)',
    avatarBg:  'rgba(251,191,36,0.1)',
    avatarGlow:'rgba(251,191,36,0.16)',
    labelColor:'#fbbf24', title: 'Michi está preocupada',
  },
  alert: {
    eyes: { ry: 7, pupilR: 4.5 }, mouth: 'open', extra: null, animation: 'sway',
    gradient:  'linear-gradient(145deg, rgba(248,113,113,0.09) 0%, rgba(4,7,15,0.78) 100%)',
    border:    'rgba(248,113,113,0.28)',
    avatarBg:  'rgba(248,113,113,0.1)',
    avatarGlow:'rgba(248,113,113,0.22)',
    labelColor:'#f87171', title: 'Michi está atenta',
  },
  celebrating: {
    eyes: { ry: 5, pupilR: 3, isStars: true }, mouth: 'bigsmile', extra: 'sparkles', animation: 'bounce',
    gradient:  'linear-gradient(145deg, rgba(251,191,36,0.1) 0%, rgba(52,211,153,0.06) 60%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(251,191,36,0.32)',
    avatarBg:  'rgba(251,191,36,0.12)',
    avatarGlow:'rgba(251,191,36,0.28)',
    labelColor:'#fbbf24', title: '¡Michi está celebrando!',
  },
  thinking: {
    eyes: { ry: 3, pupilR: 2 }, mouth: 'straight', extra: null, animation: 'slow-float',
    gradient:  'linear-gradient(145deg, rgba(129,140,248,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:    'rgba(129,140,248,0.2)',
    avatarBg:  'rgba(129,140,248,0.1)',
    avatarGlow:'rgba(129,140,248,0.16)',
    labelColor:'#818cf8', title: 'Michi está pensando',
  },
  tired: {
    eyes: { ry: 2, pupilR: 1.5, isClosed: true }, mouth: 'straight', extra: 'zzz', animation: 'slow-float',
    gradient:  'linear-gradient(145deg, rgba(52,211,153,0.04) 0%, rgba(4,7,15,0.8) 100%)',
    border:    'rgba(148,163,184,0.18)',
    avatarBg:  'rgba(148,163,184,0.08)',
    avatarGlow:'rgba(148,163,184,0.12)',
    labelColor:'#94a3b8', title: 'Michi está cansada',
  },
}

// ── SVG cat ───────────────────────────────────────────────────────────────────

const MOUTH_PATHS = {
  smile:    'M 33,56 Q 40,62 47,56',
  bigsmile: 'M 29,54 Q 40,65 51,54',
  frown:    'M 33,60 Q 40,54 47,60',
  straight: 'M 34,57 L 46,57',
  open:     'M 34,56 Q 40,63 46,56 Q 40,68 34,56 Z',
}

function MichiSVG({ mood }: { mood: MascotMood }) {
  const cfg = MOOD_CONFIG[mood]
  const { ry, pupilR, isClosed, isStars } = cfg.eyes
  const green      = '#34d399'
  const greenDark  = '#059669'
  const greenLight = '#6ee7b7'

  return (
    <svg viewBox="0 0 80 80" width="60" height="60" aria-label="Michi">
      {/* Ears */}
      <polygon points="10,32 23,5 37,30" fill={green} />
      <polygon points="70,32 57,5 43,30" fill={green} />
      <polygon points="16,30 23,12 33,29" fill={greenLight} opacity="0.45" />
      <polygon points="64,30 57,12 47,29" fill={greenLight} opacity="0.45" />

      {/* Head */}
      <circle cx="40" cy="46" r="28" fill={green} />

      {isClosed ? (
        <>
          <path d="M 24,42 Q 30,38 36,42" stroke={greenDark} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path d="M 44,42 Q 50,38 56,42" stroke={greenDark} strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </>
      ) : isStars ? (
        <>
          <text x="22" y="48" fontSize="13" fill="#fbbf24" textAnchor="middle">★</text>
          <text x="58" y="48" fontSize="13" fill="#fbbf24" textAnchor="middle">★</text>
        </>
      ) : (
        <>
          <ellipse cx="30" cy="42" rx="5.5" ry={ry} fill="white" />
          <ellipse cx="50" cy="42" rx="5.5" ry={ry} fill="white" />
          <circle cx="31" cy="43" r={pupilR} fill="#071018" />
          <circle cx="51" cy="43" r={pupilR} fill="#071018" />
          <circle cx="33" cy="40" r="1.5" fill="white" opacity="0.85" />
          <circle cx="53" cy="40" r="1.5" fill="white" opacity="0.85" />
        </>
      )}

      {/* Nose */}
      <ellipse cx="40" cy="52" rx="3" ry="2" fill={greenDark} />

      {/* Mouth */}
      <path
        d={MOUTH_PATHS[cfg.mouth]}
        stroke={greenDark}
        strokeWidth="1.8"
        fill={cfg.mouth === 'open' ? 'rgba(5,150,105,0.4)' : 'none'}
        strokeLinecap="round"
      />

      {/* Whiskers */}
      <line x1="14" y1="48" x2="28" y2="50" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="14" y1="53" x2="28" y2="53" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="66" y1="48" x2="52" y2="50" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="66" y1="53" x2="52" y2="53" stroke="rgba(255,255,255,0.32)" strokeWidth="1.2" strokeLinecap="round" />

      {cfg.extra === 'sparkles' && (
        <>
          <text x="65" y="18" fontSize="9"  fill="#fbbf24" opacity="0.9">✦</text>
          <text x="8"  y="22" fontSize="7"  fill="#fbbf24" opacity="0.7">✦</text>
          <text x="68" y="32" fontSize="6"  fill="#fbbf24" opacity="0.55">✦</text>
        </>
      )}
      {cfg.extra === 'zzz' && (
        <>
          <text x="60" y="22" fontSize="10" fill="#94a3b8" fontWeight="700" opacity="0.85">z</text>
          <text x="67" y="14" fontSize="7"  fill="#94a3b8" fontWeight="700" opacity="0.55">z</text>
        </>
      )}
    </svg>
  )
}

// ── CSS animations ────────────────────────────────────────────────────────────

const ANIM_CSS = `
@keyframes michiFloat     { 0%,100%{transform:translateY(0)}             50%{transform:translateY(-5px)} }
@keyframes michiBounce    { 0%,100%{transform:scale(1) translateY(0)}    45%{transform:scale(1.07) translateY(-4px)} }
@keyframes michiSway      { 0%,100%{transform:rotate(0deg)}              30%{transform:rotate(-2.5deg)} 70%{transform:rotate(2.5deg)} }
@keyframes michiPulse     { 0%,100%{transform:scale(1)}                  50%{transform:scale(0.95)} }
@keyframes michiSlowFloat { 0%,100%{transform:translateY(0)}             50%{transform:translateY(-2.5px)} }
`

const ANIM_STYLE: Record<MoodConfig['animation'], CSSProperties> = {
  'float':      { animation: 'michiFloat 3.2s ease-in-out infinite' },
  'bounce':     { animation: 'michiBounce 1.5s ease-in-out infinite' },
  'sway':       { animation: 'michiSway 2.4s ease-in-out infinite' },
  'pulse':      { animation: 'michiPulse 2s ease-in-out infinite' },
  'slow-float': { animation: 'michiSlowFloat 4.5s ease-in-out infinite' },
}

// ── CTA button colors ─────────────────────────────────────────────────────────

const CTA_BG: Record<MascotMood, string> = {
  calm:       'rgba(52,211,153,0.1)',
  happy:      'rgba(52,211,153,0.1)',
  proud:      'rgba(52,211,153,0.1)',
  motivated:  'rgba(96,165,250,0.1)',
  worried:    'rgba(251,191,36,0.1)',
  alert:      'rgba(248,113,113,0.1)',
  celebrating:'rgba(251,191,36,0.1)',
  thinking:   'rgba(129,140,248,0.1)',
  tired:      'rgba(148,163,184,0.08)',
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PersonalMascotProps {
  result: MoodResult
  loading?: boolean
  onCtaClick?: (route: string) => void
}

export function PersonalMascot({ result, loading = false, onCtaClick }: PersonalMascotProps) {
  const { mood, message, detail, cta } = result
  const cfg = MOOD_CONFIG[mood]

  return (
    <>
      <style>{ANIM_CSS}</style>
      <div
        data-testid="personal-michi-card"
        style={{
          background: cfg.gradient,
          border: `1px solid ${cfg.border}`,
          borderRadius: '1.5rem',
          padding: '1.125rem 1.125rem 1rem',
          boxShadow: '0 4px 24px rgba(0,0,0,0.22)',
        }}
      >
        {/* Row: avatar + text */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>

          {/* Avatar circle with glow */}
          <div
            data-testid="personal-michi-avatar"
            style={{
              flexShrink: 0,
              width: 76,
              height: 76,
              borderRadius: '50%',
              background: cfg.avatarBg,
              border: `1.5px solid ${cfg.border}`,
              boxShadow: `0 0 22px ${cfg.avatarGlow}, inset 0 0 12px ${cfg.avatarGlow}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              ...ANIM_STYLE[cfg.animation],
            }}
          >
            <MichiSVG mood={mood} />
          </div>

          {/* Text column */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Title: "Michi está [estado]" */}
            <div
              data-testid="personal-michi-mood-label"
              style={{
                fontSize: '0.8rem',
                fontWeight: 700,
                color: cfg.labelColor,
                marginBottom: '0.35rem',
                letterSpacing: '-0.01em',
              }}
            >
              {cfg.title}
            </div>

            {/* Message */}
            {loading ? (
              <>
                <div style={{ height: 13, width: '85%', borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginBottom: '0.35rem' }} />
                <div style={{ height: 11, width: '60%', borderRadius: 4, background: 'rgba(255,255,255,0.03)' }} />
              </>
            ) : (
              <>
                <p
                  data-testid="personal-michi-message"
                  style={{
                    margin: 0,
                    fontSize: '0.8125rem',
                    fontWeight: 500,
                    color: '#cbd5e1',
                    lineHeight: 1.5,
                  }}
                >
                  {message}
                </p>

                {detail && (
                  <p
                    data-testid="personal-michi-detail"
                    style={{
                      margin: '0.3rem 0 0',
                      fontSize: '0.72rem',
                      color: '#475569',
                      lineHeight: 1.4,
                      fontStyle: 'italic',
                    }}
                  >
                    {detail}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* CTA pill */}
        {!loading && cta && onCtaClick && (
          <div style={{ marginTop: '0.875rem', paddingTop: '0.75rem', borderTop: `1px solid ${cfg.border}` }}>
            <button
              data-testid="personal-michi-cta"
              onClick={() => onCtaClick(cta.route)}
              style={{
                background: CTA_BG[mood],
                border: `1.5px solid ${cfg.border}`,
                borderRadius: '99px',
                padding: '0.375rem 1.125rem',
                fontSize: '0.78rem',
                fontWeight: 700,
                color: cfg.labelColor,
                cursor: 'pointer',
                letterSpacing: '0.01em',
                lineHeight: 1,
              }}
            >
              {cta.label} →
            </button>
          </div>
        )}
      </div>
    </>
  )
}
