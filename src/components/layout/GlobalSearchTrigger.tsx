/**
 * GlobalSearchTrigger — único punto de entrada para la búsqueda global.
 *
 * Reemplaza el botón "Buscar..." + el GlobalSearch inline que antes convivían
 * en el TopHeader. Ahora hay un solo control de búsqueda en toda la app.
 *
 * Click / Ctrl+K / ⌘K → abre CommandPalette.
 */
import { Search } from 'lucide-react'

const open = () => window.dispatchEvent(new Event('tr-open-palette'))

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export function GlobalSearchTrigger() {
  return (
    <>
      {/* ── Desktop: input-like wide button ── */}
      <button
        data-testid="global-search-trigger"
        onClick={open}
        title={`Buscar en todo el sistema (${isMac ? '⌘K' : 'Ctrl+K'})`}
        className="global-search-trigger"
        style={{
          flex: 1,
          minWidth: 0,
          maxWidth: 520,
          display: 'flex',
          alignItems: 'center',
          gap: '0.625rem',
          padding: '0.45rem 0.875rem',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '0.625rem',
          cursor: 'pointer',
          color: 'var(--text-subtle)',
          fontSize: '0.82rem',
          textAlign: 'left',
          transition: 'all 0.12s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background  = 'rgba(99,102,241,0.07)'
          e.currentTarget.style.borderColor = 'rgba(99,102,241,0.28)'
          e.currentTarget.style.color       = 'var(--indigo-400)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background  = 'rgba(255,255,255,0.04)'
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
          e.currentTarget.style.color       = 'var(--text-subtle)'
        }}
      >
        <Search size={14} style={{ flexShrink: 0, opacity: 0.65 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Buscar clientes, órdenes, comprobantes, productos, proveedores...
        </span>
        <kbd style={{
          fontSize: '0.6rem',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '0.25rem',
          padding: '0.05rem 0.375rem',
          fontFamily: 'monospace',
          color: 'inherit',
          flexShrink: 0,
        }}>
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </button>

      {/* ── Mobile: compact icon button ── */}
      <button
        data-testid="global-search-trigger-mobile"
        onClick={open}
        title="Buscar"
        className="global-search-trigger-mobile"
        style={{
          width: 38, height: 38, flexShrink: 0,
          display: 'none',          // shown via CSS on small screens
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '0.625rem',
          cursor: 'pointer',
          color: 'var(--text-subtle)',
        }}
      >
        <Search size={17} />
      </button>

      <style>{`
        /* On narrow screens (tablet/mobile via mobile-topbar), hide desktop trigger,
           show compact icon button. The desktop trigger is already hidden via
           .desktop-topheader-wrapper media query, so this is just an extra guard. */
        @media (max-width: 480px) {
          .global-search-trigger        { display: none  !important; }
          .global-search-trigger-mobile { display: flex  !important; }
        }
      `}</style>
    </>
  )
}
