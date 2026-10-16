/**
 * Ayuda.tsx — BETA-1 · Entrada de ayuda del producto.
 * BETA-UX-3 · Centro de ayuda: Soporte + Tutoriales en una sola pantalla.
 *
 * Dos accesos y nada más:
 *   · Soporte — el canal atendido de siempre (`config/contacto.ts` vía
 *     `SupportContactButton`). No es un sistema de tickets ni un inbox: acá no
 *     hay teléfonos ni URLs.
 *   · Tutoriales — el catálogo de `config/tutorials.ts`. Las guías se abren en
 *     `/ayuda/tutoriales/<id>`; los videos, aparte. Sumar contenido es sumar una
 *     entrada al catálogo, no tocar esta pantalla.
 *
 * Se llega desde el sidebar, desde «Más» en mobile, desde la pantalla de fin de
 * prueba y desde `/tutorials` (redirige a `#tutoriales`). Es para cualquier
 * miembro y `SubscriptionGuard` la deja pasar con el negocio bloqueado.
 */
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ChevronRight, ExternalLink, GraduationCap, LifeBuoy, MessageCircle } from 'lucide-react'
import { SupportContactButton } from '../components/ui/SupportContactButton'
import { AppPageHeader } from '../ui'
import { TUTORIALS, tutorialHref, tutorialMeta, type Tutorial } from '../config/tutorials'

function TutorialRow({ tutorial }: { tutorial: Tutorial }) {
  const Icon = tutorial.icon
  const body = (
    <>
      <span className="help-item__icon" aria-hidden="true"><Icon size={20} /></span>
      <span className="help-item__text">
        <span className="help-item__title">{tutorial.title}</span>
        <span className="help-item__description">{tutorial.description}</span>
        <span className="help-item__meta">{tutorialMeta(tutorial)}</span>
      </span>
      {tutorial.kind === 'video'
        ? <ExternalLink size={16} className="help-item__chevron" aria-hidden="true" />
        : <ChevronRight size={18} className="help-item__chevron" aria-hidden="true" />}
    </>
  )

  // Un video sale de la app: enlace real en otra pestaña, como el de soporte.
  if (tutorial.kind === 'video') {
    return (
      <a
        className="help-item"
        href={tutorialHref(tutorial)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`help-tutorial-${tutorial.id}`}
      >
        {body}
      </a>
    )
  }
  return (
    <Link className="help-item" to={tutorialHref(tutorial)} data-testid={`help-tutorial-${tutorial.id}`}>
      {body}
    </Link>
  )
}

export function Ayuda() {
  const { hash } = useLocation()

  // `/tutorials` (el ítem viejo del menú) llega con `#tutoriales`.
  useEffect(() => {
    if (hash === '#tutoriales') document.getElementById('tutoriales')?.scrollIntoView({ block: 'start' })
  }, [hash])

  return (
    <div className="help-page" data-testid="ayuda-page">
      <AppPageHeader
        icon={<LifeBuoy size={24} />}
        title="Centro de ayuda"
        description="Soporte y tutoriales de TechRepair Pro"
      />

      <div className="help-grid">
        <section className="help-panel" aria-labelledby="help-support-title" data-testid="help-support">
          <div className="help-panel__head">
            <span className="help-panel__icon" aria-hidden="true"><MessageCircle size={20} /></span>
            <div>
              <h2 id="help-support-title" className="help-panel__title">Soporte</h2>
              <p className="help-panel__lead">Consultas y problemas técnicos</p>
            </div>
          </div>

          <p className="help-panel__text">
            Si algo te impide continuar durante la beta, escribinos y te ayudamos.
          </p>

          <SupportContactButton style={{ width: '100%', padding: '0.875rem', fontSize: '1rem' }} />
        </section>

        <section id="tutoriales" className="help-panel" aria-labelledby="help-tutorials-title" data-testid="help-tutorials">
          <div className="help-panel__head">
            <span className="help-panel__icon" aria-hidden="true"><GraduationCap size={20} /></span>
            <div>
              <h2 id="help-tutorials-title" className="help-panel__title">Tutoriales</h2>
              <p className="help-panel__lead">Videos y guías paso a paso para configurar y usar TechRepair Pro</p>
            </div>
          </div>

          <ul className="help-list" aria-labelledby="help-tutorials-title">
            {TUTORIALS.map(tutorial => (
              <li key={tutorial.id}><TutorialRow tutorial={tutorial} /></li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
