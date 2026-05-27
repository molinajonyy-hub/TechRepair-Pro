import type { CSSProperties } from 'react'
import type { MascotMood, MoodResult } from '../services/mascotMoodService'

// ── Tipos ─────────────────────────────────────────────────────────────────────

interface EyeConfig {
  type: 'ellipse' | 'happy' | 'closed' | 'stars'
  ry?: number
  pupilR?: number
  pupilDx?: number
  pupilDy?: number
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
    eyes:      { type: 'ellipse', ry: 4.5, pupilR: 3 },
    mouth: 'smile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.2)',
    avatarBg:   'rgba(52,211,153,0.1)',
    avatarGlow: 'rgba(52,211,153,0.2)',
    labelColor: '#34d399',
    title: 'Michi está tranquila',
  },
  happy: {
    eyes:      { type: 'happy' },
    mouth: 'smile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.28)',
    avatarBg:   'rgba(52,211,153,0.13)',
    avatarGlow: 'rgba(52,211,153,0.28)',
    labelColor: '#4ade80',
    title: 'Michi está contenta',
  },
  proud: {
    eyes:      { type: 'ellipse', ry: 6, pupilR: 3.5, pupilDy: -1 },
    mouth: 'bigsmile', extra: null, animation: 'float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.1) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(52,211,153,0.28)',
    avatarBg:   'rgba(52,211,153,0.13)',
    avatarGlow: 'rgba(52,211,153,0.28)',
    labelColor: '#4ade80',
    title: 'Michi está orgullosa',
  },
  motivated: {
    eyes:      { type: 'ellipse', ry: 8, pupilR: 4.5 },
    mouth: 'smile', extra: null, animation: 'bounce',
    gradient:   'linear-gradient(145deg, rgba(96,165,250,0.08) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(96,165,250,0.22)',
    avatarBg:   'rgba(96,165,250,0.1)',
    avatarGlow: 'rgba(96,165,250,0.2)',
    labelColor: '#60a5fa',
    title: 'Michi está motivada',
  },
  worried: {
    eyes:      { type: 'ellipse', ry: 6.5, pupilR: 3.5, showBrows: true },
    mouth: 'frown', extra: null, animation: 'pulse',
    gradient:   'linear-gradient(145deg, rgba(251,191,36,0.07) 0%, rgba(4,7,15,0.76) 100%)',
    border:     'rgba(251,191,36,0.22)',
    avatarBg:   'rgba(251,191,36,0.1)',
    avatarGlow: 'rgba(251,191,36,0.16)',
    labelColor: '#fbbf24',
    title: 'Michi está preocupada',
  },
  alert: {
    eyes:      { type: 'ellipse', ry: 8.5, pupilR: 4.5, showBrows: true },
    mouth: 'open', extra: null, animation: 'sway',
    gradient:   'linear-gradient(145deg, rgba(248,113,113,0.09) 0%, rgba(4,7,15,0.78) 100%)',
    border:     'rgba(248,113,113,0.28)',
    avatarBg:   'rgba(248,113,113,0.1)',
    avatarGlow: 'rgba(248,113,113,0.22)',
    labelColor: '#f87171',
    title: 'Michi está atenta',
  },
  celebrating: {
    eyes:      { type: 'stars' },
    mouth: 'excited', extra: 'sparkles', animation: 'bounce',
    gradient:   'linear-gradient(145deg, rgba(251,191,36,0.1) 0%, rgba(52,211,153,0.06) 60%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(251,191,36,0.32)',
    avatarBg:   'rgba(251,191,36,0.12)',
    avatarGlow: 'rgba(251,191,36,0.28)',
    labelColor: '#fbbf24',
    title: '¡Michi está celebrando!',
  },
  thinking: {
    eyes:      { type: 'ellipse', ry: 5, pupilR: 3, pupilDx: 1.5, pupilDy: -1.5 },
    mouth: 'neutral', extra: null, animation: 'slow-float',
    gradient:   'linear-gradient(145deg, rgba(129,140,248,0.07) 0%, rgba(4,7,15,0.72) 100%)',
    border:     'rgba(129,140,248,0.2)',
    avatarBg:   'rgba(129,140,248,0.1)',
    avatarGlow: 'rgba(129,140,248,0.16)',
    labelColor: '#818cf8',
    title: 'Michi está pensando',
  },
  tired: {
    eyes:      { type: 'closed' },
    mouth: 'neutral', extra: 'zzz', animation: 'slow-float',
    gradient:   'linear-gradient(145deg, rgba(52,211,153,0.04) 0%, rgba(4,7,15,0.8) 100%)',
    border:     'rgba(148,163,184,0.18)',
    avatarBg:   'rgba(148,163,184,0.08)',
    avatarGlow: 'rgba(148,163,184,0.12)',
    labelColor: '#94a3b8',
    title: 'Michi está cansada',
  },
}

// ── Paths de boca ─────────────────────────────────────────────────────────────

const MOUTH_PATHS = {
  smile:    'M 36,58 Q 40,63 44,58',
  bigsmile: 'M 33,57 Q 40,65 47,57',
  frown:    'M 36,61 Q 40,56 44,61',
  neutral:  'M 38,59 L 40,62.5 L 42,59',
  // 'open' se renderiza como ellipse separado
  // 'excited' = W-smile
  excited:  'M 33,57 Q 37,66 40,61 Q 43,66 47,57',
}

// ── SVG principal ─────────────────────────────────────────────────────────────

function MichiSVG({ mood }: { mood: MascotMood }) {
  const cfg    = MOOD_CONFIG[mood]
  const { type: eyeType, ry = 7, pupilR = 3.5, pupilDx = 0, pupilDy = 0, showBrows } = cfg.eyes

  const green      = '#34d399'
  const greenDark  = '#059669'
  const greenLight = '#a7f3d0'
  const blush      = 'rgba(255,110,90,0.13)'

  return (
    <svg viewBox="0 0 80 80" width="62" height="62" aria-label="Michi">

      {/* ── Orejas (detrás de la cabeza) ── */}
      <polygon points="11,36 21,6 38,27"  fill={green} />
      <polygon points="69,36 59,6 42,27"  fill={green} />
      <polygon points="17,33 22,13 34,27" fill={greenLight} opacity="0.5" />
      <polygon points="63,33 58,13 46,27" fill={greenLight} opacity="0.5" />

      {/* ── Cabeza ── */}
      <circle cx="40" cy="46" r="28" fill={green} />

      {/* ── Rubor (siempre presente, muy sutil) ── */}
      <ellipse cx="22" cy="52" rx="6"   ry="3.5" fill={blush} />
      <ellipse cx="58" cy="52" rx="6"   ry="3.5" fill={blush} />

      {/* ── Ojos ── */}
      {eyeType === 'closed' ? (
        /* Cansada: ojos cerrados como arcos suaves */
        <>
          <path d="M 22,42 Q 29,36 36,42" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <path d="M 44,42 Q 51,36 58,42" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </>
      ) : eyeType === 'stars' ? (
        /* Celebrando: ojos estrella dorados */
        <>
          <text x="29" y="46" fontSize="14" fill="#fbbf24" textAnchor="middle" dominantBaseline="middle">★</text>
          <text x="51" y="46" fontSize="14" fill="#fbbf24" textAnchor="middle" dominantBaseline="middle">★</text>
        </>
      ) : eyeType === 'happy' ? (
        /* Contenta: medias lunas (arco superior, estilo ^_^) */
        <>
          <path d="M 22.5,42 A 6.5,7.5 0 0 0 35.5,42 Z" fill="white" />
          <circle cx="29"  cy="41" r="3.5" fill="#0a1520" />
          <circle cx="32"  cy="39" r="1.8" fill="white"   opacity="0.9" />
          <path d="M 44.5,42 A 6.5,7.5 0 0 0 57.5,42 Z" fill="white" />
          <circle cx="51"  cy="41" r="3.5" fill="#0a1520" />
          <circle cx="54"  cy="39" r="1.8" fill="white"   opacity="0.9" />
        </>
      ) : (
        /* Ellipse: normal / wide / calm / worried / motivated / proud / thinking */
        <>
          {/* Cejas fruncidas para worried/alert */}
          {showBrows && (
            <>
              <path d="M 23,33 Q 28,30 34,34"   stroke={greenDark} strokeWidth="2"   fill="none" strokeLinecap="round" />
              <path d="M 46,34 Q 52,30 57,33"   stroke={greenDark} strokeWidth="2"   fill="none" strokeLinecap="round" />
            </>
          )}
          {/* Blancos del ojo */}
          <ellipse cx="29" cy="41" rx="6.5" ry={ry}     fill="white" />
          <ellipse cx="51" cy="41" rx="6.5" ry={ry}     fill="white" />
          {/* Pupilas */}
          <circle cx={29 + pupilDx} cy={41 + pupilDy} r={pupilR} fill="#0a1520" />
          <circle cx={51 + pupilDx} cy={41 + pupilDy} r={pupilR} fill="#0a1520" />
          {/* Highlight principal */}
          <circle cx={32 + pupilDx} cy={38.5 + pupilDy} r="2"   fill="white" opacity="0.9" />
          <circle cx={54 + pupilDx} cy={38.5 + pupilDy} r="2"   fill="white" opacity="0.9" />
          {/* Highlight secundario (más suave) */}
          <circle cx={27 + pupilDx} cy={43   + pupilDy} r="1"   fill="white" opacity="0.4" />
          <circle cx={49 + pupilDx} cy={43   + pupilDy} r="1"   fill="white" opacity="0.4" />
        </>
      )}

      {/* ── Nariz (triángulo invertido estilo gato) ── */}
      <path d="M 37.5,50.5 L 40,54.5 L 42.5,50.5 Z" fill={greenDark} />

      {/* ── Boca ── */}
      {cfg.mouth === 'open' ? (
        /* Alerta: boca abierta (oval con relleno) */
        <ellipse cx="40" cy="61" rx="5.5" ry="5"
          fill="rgba(5,150,105,0.38)" stroke={greenDark} strokeWidth="1.5" />
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
      <line x1="10" y1="48"   x2="24" y2="50.5" stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="10" y1="53"   x2="24" y2="53"   stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="70" y1="48"   x2="56" y2="50.5" stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="70" y1="53"   x2="56" y2="53"   stroke="rgba(255,255,255,0.28)" strokeWidth="1.2" strokeLinecap="round" />

      {/* ── Extras ── */}
      {cfg.extra === 'sparkles' && (
        <>
          <text x="65" y="18" fontSize="9"  fill="#fbbf24" opacity="0.9">✦</text>
          <text x="8"  y="22" fontSize="7"  fill="#fbbf24" opacity="0.75">✦</text>
          <text x="68" y="32" fontSize="6"  fill="#fbbf24" opacity="0.55">✦</text>
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

// ── Componente público ────────────────────────────────────────────────────────

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
            data-testid="personal-michi-avatar"
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
            <MichiSVG mood={mood} />
          </div>

          {/* Columna de texto */}
          <div style={{ flex: 1, minWidth: 0 }}>

            {/* Título "Michi está [estado]" */}
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

            {/* Mensaje principal */}
            {loading ? (
              <>
                <div style={{ height: 13, width: '85%', borderRadius: 4, background: 'rgba(255,255,255,0.05)', marginBottom: '0.35rem' }} />
                <div style={{ height: 11, width: '60%', borderRadius: 4, background: 'rgba(255,255,255,0.03)' }} />
              </>
            ) : (
              <>
                <p
                  data-testid="personal-michi-message"
                  style={{ margin: 0, fontSize: '0.8125rem', fontWeight: 500, color: '#cbd5e1', lineHeight: 1.5 }}
                >
                  {message}
                </p>
                {detail && (
                  <p
                    data-testid="personal-michi-detail"
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
