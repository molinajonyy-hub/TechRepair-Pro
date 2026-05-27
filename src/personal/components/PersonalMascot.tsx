import type { CSSProperties } from 'react'
import type { MascotMood, MoodResult } from '../services/mascotMoodService'

// ── SVG cat expressions ───────────────────────────────────────────────────────

interface EyeConfig {
  ry: number
  pupilR: number
  isClosed?: boolean
  isStars?: boolean
}

interface MoodConfig {
  eyes: EyeConfig
  mouth: 'smile' | 'bigsmile' | 'frown' | 'straight' | 'open'
  extra: 'sparkles' | 'zzz' | null
  animation: 'float' | 'bounce' | 'shake' | 'pulse' | 'slow-float'
  borderColor: string
  bgColor: string
  labelColor: string
  label: string
}

const MOOD_CONFIG: Record<MascotMood, MoodConfig> = {
  calm:        { eyes: { ry: 3.5, pupilR: 2.5 },                 mouth: 'smile',    extra: null,       animation: 'float',      borderColor: 'rgba(52,211,153,0.25)',  bgColor: 'rgba(52,211,153,0.06)',   labelColor: '#34d399', label: 'Tranquila'    },
  happy:       { eyes: { ry: 5.5, pupilR: 3.5 },                 mouth: 'smile',    extra: null,       animation: 'bounce',     borderColor: 'rgba(52,211,153,0.35)',  bgColor: 'rgba(52,211,153,0.08)',   labelColor: '#34d399', label: 'Contenta'     },
  proud:       { eyes: { ry: 5,   pupilR: 3 },                   mouth: 'bigsmile', extra: null,       animation: 'float',      borderColor: 'rgba(52,211,153,0.35)',  bgColor: 'rgba(52,211,153,0.08)',   labelColor: '#34d399', label: 'Orgullosa'    },
  motivated:   { eyes: { ry: 6.5, pupilR: 4 },                   mouth: 'smile',    extra: null,       animation: 'bounce',     borderColor: 'rgba(96,165,250,0.35)',  bgColor: 'rgba(96,165,250,0.06)',   labelColor: '#60a5fa', label: 'Motivada'     },
  worried:     { eyes: { ry: 5,   pupilR: 3 },                   mouth: 'frown',    extra: null,       animation: 'pulse',      borderColor: 'rgba(251,191,36,0.35)',  bgColor: 'rgba(251,191,36,0.06)',   labelColor: '#fbbf24', label: 'Preocupada'   },
  alert:       { eyes: { ry: 7,   pupilR: 4.5 },                 mouth: 'open',     extra: null,       animation: 'shake',      borderColor: 'rgba(248,113,113,0.45)', bgColor: 'rgba(248,113,113,0.07)',  labelColor: '#f87171', label: 'Alerta'       },
  celebrating: { eyes: { ry: 5,   pupilR: 3, isStars: true },    mouth: 'bigsmile', extra: 'sparkles', animation: 'bounce',     borderColor: 'rgba(251,191,36,0.45)',  bgColor: 'rgba(251,191,36,0.08)',   labelColor: '#fbbf24', label: '¡Celebrando!' },
  thinking:    { eyes: { ry: 3,   pupilR: 2 },                   mouth: 'straight', extra: null,       animation: 'slow-float', borderColor: 'rgba(129,140,248,0.3)',  bgColor: 'rgba(129,140,248,0.06)',  labelColor: '#818cf8', label: 'Pensando'     },
  tired:       { eyes: { ry: 2,   pupilR: 1.5, isClosed: true }, mouth: 'straight', extra: 'zzz',      animation: 'slow-float', borderColor: 'rgba(100,116,139,0.3)',  bgColor: 'rgba(100,116,139,0.05)',  labelColor: '#64748b', label: 'Cansada'      },
}

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
  const green = '#34d399'
  const greenDark = '#059669'
  const greenLight = '#6ee7b7'

  return (
    <svg viewBox="0 0 80 80" width="68" height="68" aria-label="Michi" aria-hidden="false">
      {/* Ears */}
      <polygon points="10,32 23,5 37,30" fill={green} />
      <polygon points="70,32 57,5 43,30" fill={green} />
      <polygon points="16,30 23,12 33,29" fill={greenLight} opacity="0.45" />
      <polygon points="64,30 57,12 47,29" fill={greenLight} opacity="0.45" />

      {/* Head */}
      <circle cx="40" cy="46" r="28" fill={green} />

      {isClosed ? (
        /* Tired: closed eyes */
        <>
          <path d="M 24,42 Q 30,38 36,42" stroke={greenDark} strokeWidth="2" fill="none" strokeLinecap="round" />
          <path d="M 44,42 Q 50,38 56,42" stroke={greenDark} strokeWidth="2" fill="none" strokeLinecap="round" />
        </>
      ) : isStars ? (
        /* Celebrating: star eyes */
        <>
          <text x="22" y="48" fontSize="13" fill="#fbbf24" textAnchor="middle">★</text>
          <text x="58" y="48" fontSize="13" fill="#fbbf24" textAnchor="middle">★</text>
        </>
      ) : (
        /* Normal eyes */
        <>
          <ellipse cx="30" cy="42" rx="5.5" ry={ry} fill="white" />
          <ellipse cx="50" cy="42" rx="5.5" ry={ry} fill="white" />
          <circle cx="31" cy="43" r={pupilR} fill="#071018" />
          <circle cx="51" cy="43" r={pupilR} fill="#071018" />
          {/* Highlights */}
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
      <line x1="14" y1="48" x2="28" y2="50" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="14" y1="53" x2="28" y2="53" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="66" y1="48" x2="52" y2="50" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="66" y1="53" x2="52" y2="53" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" strokeLinecap="round" />

      {/* Extras */}
      {cfg.extra === 'sparkles' && (
        <>
          <text x="64" y="18" fontSize="9"  fill="#fbbf24" opacity="0.9">✦</text>
          <text x="8"  y="22" fontSize="7"  fill="#fbbf24" opacity="0.7">✦</text>
          <text x="68" y="32" fontSize="6"  fill="#fbbf24" opacity="0.6">✦</text>
        </>
      )}
      {cfg.extra === 'zzz' && (
        <>
          <text x="60" y="22" fontSize="10" fill="#94a3b8" fontWeight="700" opacity="0.9">z</text>
          <text x="67" y="14" fontSize="8"  fill="#94a3b8" fontWeight="700" opacity="0.6">z</text>
        </>
      )}
    </svg>
  )
}

// ── CSS animations ────────────────────────────────────────────────────────────

const ANIM_CSS = `
@keyframes michiFloat     { 0%,100%{transform:translateY(0)}   50%{transform:translateY(-4px)} }
@keyframes michiBounce    { 0%,100%{transform:scale(1)}         40%{transform:scale(1.07)} }
@keyframes michiShake     { 0%,100%{transform:rotate(0deg)}     25%{transform:rotate(-4deg)} 75%{transform:rotate(4deg)} }
@keyframes michiPulse     { 0%,100%{opacity:1}                  50%{opacity:0.75} }
@keyframes michiSlowFloat { 0%,100%{transform:translateY(0)}   50%{transform:translateY(-2px)} }
`

const ANIM_STYLE: Record<MoodConfig['animation'], CSSProperties> = {
  'float':      { animation: 'michiFloat 3s ease-in-out infinite' },
  'bounce':     { animation: 'michiBounce 1.4s ease-in-out infinite' },
  'shake':      { animation: 'michiShake 0.6s ease-in-out infinite' },
  'pulse':      { animation: 'michiPulse 1.8s ease-in-out infinite' },
  'slow-float': { animation: 'michiSlowFloat 4s ease-in-out infinite' },
}

// ── Public component ──────────────────────────────────────────────────────────

interface PersonalMascotProps {
  result: MoodResult
  loading?: boolean
}

export function PersonalMascot({ result, loading = false }: PersonalMascotProps) {
  const { mood, message, detail } = result
  const cfg = MOOD_CONFIG[mood]

  return (
    <>
      <style>{ANIM_CSS}</style>
      <div
        data-testid="personal-michi-card"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.875rem',
          background: cfg.bgColor,
          border: `1px solid ${cfg.borderColor}`,
          borderRadius: '1.25rem',
          padding: '0.875rem 1rem',
        }}
      >
        {/* Cat SVG with animation */}
        <div
          data-testid="personal-michi-avatar"
          style={{
            flexShrink: 0,
            width: 68,
            height: 68,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            ...ANIM_STYLE[cfg.animation],
          }}
        >
          <MichiSVG mood={mood} />
        </div>

        {/* Text */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            data-testid="personal-michi-mood-label"
            style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              color: cfg.labelColor,
              marginBottom: '0.3rem',
            }}
          >
            Michi · {cfg.label}
          </div>
          {loading ? (
            <div style={{ height: 14, width: '70%', borderRadius: 4, background: 'rgba(255,255,255,0.06)' }} />
          ) : (
            <>
              <p
                data-testid="personal-michi-message"
                style={{
                  margin: 0,
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: '#e2e8f0',
                  lineHeight: 1.4,
                }}
              >
                {message}
              </p>
              {detail && (
                <p
                  data-testid="personal-michi-detail"
                  style={{
                    margin: '0.2rem 0 0',
                    fontSize: '0.72rem',
                    color: '#475569',
                    lineHeight: 1.35,
                  }}
                >
                  {detail}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
