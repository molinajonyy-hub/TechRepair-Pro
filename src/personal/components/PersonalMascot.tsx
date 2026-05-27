import type { CSSProperties } from 'react'
import type { MascotMood, MoodResult } from '../services/mascotMoodService'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface EyeConfig {
  type: 'circle' | 'happy' | 'closed' | 'stars'
  r?: number
  hlDx?: number
  hlDy?: number
  showBrows?: boolean
}

interface MoodConfig {
  eyes: EyeConfig
  mouth: 'smile' | 'bigsmile' | 'frown' | 'neutral' | 'open' | 'excited'
  extra: 'sparkles' | 'zzz' | null
  animation: 'float' | 'bounce' | 'pulse' | 'slow-float' | 'sway'
  gradient: string
  border: string
  avatarBg: string
  avatarGlow: string
  labelColor: string
  title: string
}

// ── Config por mood ───────────────────────────────────────────────────────────

const MOOD_CONFIG: Record<MascotMood, MoodConfig> = {
  calm: {
    eyes: { type: 'circle', r: 7.5 },
    mouth: 'smile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.2)',
    avatarBg:   'rgba(52,211,153,0.1)',
    avatarGlow: 'rgba(52,211,153,0.2)',
    labelColor: '#34d399',
    title: 'Miguita está tranquila',
  },
  happy: {
    eyes: { type: 'happy' },
    mouth: 'smile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.28)',
    avatarBg:   'rgba(52,211,153,0.13)',
    avatarGlow: 'rgba(52,211,153,0.28)',
    labelColor: '#4ade80',
    title: 'Miguita está contenta',
  },
  proud: {
    eyes: { type: 'circle', r: 8.5 },
    mouth: 'bigsmile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.28)',
    avatarBg:   'rgba(52,211,153,0.13)',
    avatarGlow: 'rgba(52,211,153,0.28)',
    labelColor: '#4ade80',
    title: 'Miguita está orgullosa',
  },
  motivated: {
    eyes: { type: 'circle', r: 9.5 },
    mouth: 'smile', extra: null, animation: 'bounce',
    gradient:   'linear-gradient(145deg, rgba(96,165,250,0.08) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(96,165,250,0.22)',
    avatarBg:   'rgba(96,165,250,0.1)',
    avatarGlow: 'rgba(96,165,250,0.2)',
    labelColor: '#60a5fa',
    title: 'Miguita está motivada',
  },
  worried: {
    eyes: { type: 'circle', r: 8.5, showBrows: true },
    mouth: 'frown', extra: null, animation: 'pulse',
    gradient:   'linear-gradient(145deg, rgba(251,191,36,0.07) 0%, rgba(4,7,15,0.76) 100%)',
    border:     'rgba(251,191,36,0.22)',
    avatarBg:   'rgba(251,191,36,0.1)',
    avatarGlow: 'rgba(251,191,36,0.16)',
    labelColor: '#fbbf24',
    title: 'Miguita está preocupada',
  },
  alert: {
    eyes: { type: 'circle', r: 9.5, showBrows: true },
    mouth: 'open', extra: null, animation: 'sway',
    gradient:   'linear-gradient(145deg, rgba(248,113,113,0.09) 0%, rgba(4,7,15,0.78) 100%)',
    border:     'rgba(248,113,113,0.28)',
    avatarBg:   'rgba(248,113,113,0.1)',
    avatarGlow: 'rgba(248,113,113,0.22)',
    labelColor: '#f87171',
    title: 'Miguita está atenta',
  },
  celebrating: {
    eyes: { type: 'stars' },
    mouth: 'excited', extra: 'sparkles', animation: 'bounce',
    gradient:   'linear-gradient(145deg, rgba(251,191,36,0.1) 0%, rgba(52,211,153,0.06) 60%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(251,191,36,0.32)',
    avatarBg:   'rgba(251,191,36,0.12)',
    avatarGlow: 'rgba(251,191,36,0.28)',
    labelColor: '#fbbf24',
    title: '¡Miguita está celebrando!',
  },
  thinking: {
    eyes: { type: 'circle', r: 8, hlDx: 2, hlDy: -2 },
    mouth: 'neutral', extra: null, animation: 'slow-float',
    gradient:   'linear-gradient(145deg, rgba(129,140,248,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(129,140,248,0.2)',
    avatarBg:   'rgba(129,140,248,0.1)',
    avatarGlow: 'rgba(129,140,248,0.16)',
    labelColor: '#818cf8',
    title: 'Miguita está pensando',
  },
  tired: {
    eyes: { type: 'closed' },
    mouth: 'neutral', extra: 'zzz', animation: 'slow-float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.04) 0%, rgba(4,7,15,0.8) 100%)',
    border:     'rgba(148,163,184,0.18)',
    avatarBg:   'rgba(148,163,184,0.08)',
    avatarGlow: 'rgba(148,163,184,0.12)',
    labelColor: '#94a3b8',
    title: 'Miguita está cansada',
  },
}

// ── Paths de boca ─────────────────────────────────────────────────────────────

const MOUTH_PATHS = {
  smile:    'M 36,53 Q 40,58 44,53',
  bigsmile: 'M 33,52 Q 40,60 47,52',
  frown:    'M 36,56 Q 40,51 44,56',
  neutral:  'M 38,54 L 40,57.5 L 42,54',
  excited:  'M 33,52 Q 37,62 40,57 Q 43,62 47,52',
}

// ── SVG principal ─────────────────────────────────────────────────────────────

function MascotSVG({ mood }: { mood: MascotMood }) {
  const cfg = MOOD_CONFIG[mood]
  const { type: eyeType, r: eyeR = 8.5, hlDx = 0, hlDy = 0, showBrows } = cfg.eyes

  const green      = '#34d399'
  const greenDark  = '#059669'
  const greenLight = '#a7f3d0'
  const indigo     = '#4f46e5'
  const blush      = 'rgba(255,110,90,0.13)'

  return (
    <svg viewBox="0 0 80 80" width="62" height="62" aria-label="Miguita">

      {/* ── Orejas (detras de la cabeza) ── */}
      <polygon points="13,30 22,5 36,22"  fill={green} />
      <polygon points="67,30 58,5 44,22"  fill={green} />
      {/* orejas internas indigo (clay 3D) */}
      <polygon points="17,28 22,11 32,22" fill={indigo} opacity="0.75" />
      <polygon points="63,28 58,11 48,22" fill={indigo} opacity="0.75" />

      {/* ── Cabeza ── */}
      <circle cx="40" cy="39" r="27" fill={green} />

      {/* ── Highlight de frente (efecto 3D clay) ── */}
      <ellipse cx="38" cy="24" rx="13" ry="9" fill={greenLight} opacity="0.28" />

      {/* ── Rubor ── */}
      <ellipse cx="20" cy="44" rx="6"   ry="3.5" fill={blush} />
      <ellipse cx="60" cy="44" rx="6"   ry="3.5" fill={blush} />

      {/* ── Ojos ── */}
      {eyeType === 'closed' ? (
        <>
          <path d="M 20,34 Q 28,28 36,34" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M 44,34 Q 52,28 60,34" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </>
      ) : eyeType === 'stars' ? (
        <>
          <text x="28" y="34" fontSize="14" fill="#fbbf24" textAnchor="middle" dominantBaseline="middle">&#9733;</text>
          <text x="52" y="34" fontSize="14" fill="#fbbf24" textAnchor="middle" dominantBaseline="middle">&#9733;</text>
        </>
      ) : eyeType === 'happy' ? (
        <>
          {/* Circulos oscuros base */}
          <circle cx="28" cy="34" r="8.5" fill="#1a1a2e" />
          <circle cx="52" cy="34" r="8.5" fill="#1a1a2e" />
          {/* Arcos verdes cubren mitad inferior: efecto guino */}
          <path d="M 19.5,34 A 8.5,8.5 0 0 1 36.5,34 Z" fill={green} />
          <path d="M 43.5,34 A 8.5,8.5 0 0 1 60.5,34 Z" fill={green} />
          {/* Highlights */}
          <circle cx="32" cy="29" r="2"   fill="white" opacity="0.85" />
          <circle cx="56" cy="29" r="2"   fill="white" opacity="0.85" />
          <circle cx="25" cy="37" r="1.2" fill="white" opacity="0.4"  />
          <circle cx="49" cy="37" r="1.2" fill="white" opacity="0.4"  />
        </>
      ) : (
        /* circle: normal / worried / alert / motivated / proud / calm / thinking */
        <>
          {showBrows && (
            <>
              <path d="M 20,27 Q 28,23 36,28" stroke={greenDark} strokeWidth="2.2" fill="none" strokeLinecap="round" />
              <path d="M 44,28 Q 52,23 60,27" stroke={greenDark} strokeWidth="2.2" fill="none" strokeLinecap="round" />
            </>
          )}
          {/* Ojos grandes oscuros (estilo clay) */}
          <circle cx="28" cy="34" r={eyeR} fill="#1a1a2e" />
          <circle cx="52" cy="34" r={eyeR} fill="#1a1a2e" />
          {/* Highlight principal */}
          <circle cx={32 + hlDx} cy={30 + hlDy} r="2.5"  fill="white" opacity="0.9"  />
          <circle cx={56 + hlDx} cy={30 + hlDy} r="2.5"  fill="white" opacity="0.9"  />
          {/* Highlight secundario */}
          <circle cx={25 + hlDx} cy={37 + hlDy} r="1.3"  fill="white" opacity="0.45" />
          <circle cx={49 + hlDx} cy={37 + hlDy} r="1.3"  fill="white" opacity="0.45" />
        </>
      )}

      {/* ── Nariz indigo (oval) ── */}
      <ellipse cx="40" cy="47" rx="3.5" ry="2.5" fill={indigo} />

      {/* ── Boca ── */}
      {cfg.mouth === 'open' ? (
        <ellipse cx="40" cy="57" rx="5.5" ry="5"
          fill="rgba(5,150,105,0.38)" stroke={indigo} strokeWidth="1.5" />
      ) : (
        <path
          d={MOUTH_PATHS[cfg.mouth as keyof typeof MOUTH_PATHS]}
          stroke={greenDark}
          strokeWidth="1.8"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* ── Bigotes ── */}
      <line x1="8"  y1="44" x2="22" y2="46.5" stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="8"  y1="50" x2="22" y2="50"   stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="72" y1="44" x2="58" y2="46.5" stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="72" y1="50" x2="58" y2="50"   stroke="rgba(255,255,255,0.25)" strokeWidth="1.2" strokeLinecap="round" />

      {/* ── Collar indigo ── */}
      <path d="M 18,62 Q 40,70 62,62" stroke={indigo} strokeWidth="3.5" fill="none" strokeLinecap="round" />

      {/* ── Medalla con grafico de barras ascendente ── */}
      <circle cx="40" cy="68" r="6.5" fill="#e0e7ff" />
      <rect x="35.5" y="66.5" width="2" height="3.5" rx="0.5" fill={indigo} />
      <rect x="39"   y="65"   width="2" height="5"   rx="0.5" fill={indigo} />
      <rect x="42.5" y="63.5" width="2" height="6.5" rx="0.5" fill={indigo} />

      {/* ── Extras ── */}
      {cfg.extra === 'sparkles' && (
        <>
          <text x="65" y="18" fontSize="9"  fill="#fbbf24" opacity="0.9">&#10022;</text>
          <text x="8"  y="22" fontSize="7"  fill="#fbbf24" opacity="0.75">&#10022;</text>
          <text x="68" y="32" fontSize="6"  fill="#fbbf24" opacity="0.55">&#10022;</text>
        </>
      )}
      {cfg.extra === 'zzz' && (
        <>
          <text x="60" y="22" fontSize="10" fill="#94a3b8" opacity="0.85" fontWeight="700">z</text>
          <text x="67" y="14" fontSize="8"  fill="#94a3b8" opacity="0.55" fontWeight="700">z</text>
        </>
      )}
    </svg>
  )
}

// ── CSS animaciones ───────────────────────────────────────────────────────────

const ANIM_CSS = `
@keyframes mascotFloat     { 0%,100%{transform:translateY(0)}             50%{transform:translateY(-5px)} }
@keyframes mascotBounce    { 0%,100%{transform:scale(1) translateY(0)}    45%{transform:scale(1.07) translateY(-4px)} }
@keyframes mascotSway      { 0%,100%{transform:rotate(0deg)}              30%{transform:rotate(-2.5deg)} 70%{transform:rotate(2.5deg)} }
@keyframes mascotPulse     { 0%,100%{transform:scale(1)}                  50%{transform:scale(0.95)} }
@keyframes mascotSlowFloat { 0%,100%{transform:translateY(0)}             50%{transform:translateY(-2.5px)} }
`

const ANIM_STYLE: Record<MoodConfig['animation'], CSSProperties> = {
  'float':      { animation: 'mascotFloat 3.2s ease-in-out infinite' },
  'bounce':     { animation: 'mascotBounce 1.5s ease-in-out infinite' },
  'sway':       { animation: 'mascotSway 2.4s ease-in-out infinite' },
  'pulse':      { animation: 'mascotPulse 2s ease-in-out infinite' },
  'slow-float': { animation: 'mascotSlowFloat 4.5s ease-in-out infinite' },
}

// ── CTA bg por mood ───────────────────────────────────────────────────────────

const CTA_BG: Record<MascotMood, string> = {
  calm:        'rgba(52,211,153,0.1)',
  happy:       'rgba(52,211,153,0.1)',
  proud:       'rgba(52,211,153,0.1)',
  motivated:   'rgba(96,165,250,0.1)',
  worried:     'rgba(251,191,36,0.1)',
  alert:       'rgba(248,113,113,0.1)',
  celebrating: 'rgba(251,191,36,0.1)',
  thinking:    'rgba(129,140,248,0.1)',
  tired:       'rgba(148,163,184,0.08)',
}

// ── Componente publico ────────────────────────────────────────────────────────

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
        data-testid="personal-miguita-card"
        style={{
          background:   cfg.gradient,
          border:       `1px solid ${cfg.border}`,
          borderRadius: '1.5rem',
          padding:      '1.125rem 1.125rem 1rem',
          boxShadow:    '0 4px 24px rgba(0,0,0,0.22)',
        }}
      >
        {/* Fila: avatar + texto */}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>

          {/* Avatar circular con glow */}
          <div
            data-testid="personal-miguita-avatar"
            style={{
              flexShrink: 0,
              width: 76, height: 76,
              borderRadius: '50%',
              background: cfg.avatarBg,
              border: `1.5px solid ${cfg.border}`,
              boxShadow: `0 0 22px ${cfg.avatarGlow}, inset 0 0 12px ${cfg.avatarGlow}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              ...ANIM_STYLE[cfg.animation],
            }}
          >
            <MascotSVG mood={mood} />
          </div>

          {/* Columna de texto */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Titulo "Miguita esta [estado]" */}
            <div
              data-testid="personal-miguita-mood-label"
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

            {/* Mensaje principal */}
            {loading ? (
              <>
                <div style={{ height: 13, width: '85%', borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginBottom: '0.35rem' }} />
                <div style={{ height: 11, width: '60%', borderRadius: 4, background: 'rgba(255,255,255,0.03)' }} />
              </>
            ) : (
              <>
                <p
                  data-testid="personal-miguita-message"
                  style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 500, color: '#cbd5e1', lineHeight: 1.5 }}
                >
                  {message}
                </p>
                {detail && (
                  <p
                    data-testid="personal-miguita-detail"
                    style={{ margin: '0.3rem 0 0', fontSize: '0.72rem', color: '#475569', lineHeight: 1.4, fontStyle: 'italic' }}
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
              data-testid="personal-miguita-cta"
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
              {cta.label} &rarr;
            </button>
          </div>
        )}
      </div>
    </>
  )
}
