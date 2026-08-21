/**
 * Privacidad — página pública, SIN login.
 *
 * Existe por dos razones, y las dos son obligatorias:
 *
 * 1. El pie del Login promete «Términos de uso» y «Política de privacidad»
 *    desde siempre, y los dos enlaces eran `href="#"`: prometía dos documentos
 *    que no existían.
 * 2. El Chrome Web Store exige una URL de política de privacidad cuando un ítem
 *    maneja datos de usuario, y TechRepair Companion los maneja. La definición
 *    oficial de «handle» incluye *usar*, aunque el dato no se guarde ni se
 *    transmita: construir la URL de WhatsApp con el teléfono y el texto ya
 *    cuenta.
 *
 * Se dibuja sola, sin MainLayout: es una ruta pública y el layout de la app
 * exige sesión. Mismo criterio que Login, que también es standalone.
 *
 * REGLA AL EDITAR: esta página tiene que decir lo que el sistema hace de verdad,
 * incluido lo incómodo. Si el comportamiento cambia, cambia primero acá. Una
 * política que describe con detalle lo que la extensión NO guarda y omite lo que
 * la aplicación SÍ guarda es exactamente la clase de omisión que un revisor lee
 * como engañosa.
 */
import { useNavigate } from 'react-router-dom'
import logoSvg from '../assets/logo.svg'
import { CONTACTO_SOPORTE } from '../config/contacto'

/**
 * Contacto público. Ya no sale del entorno: una política de privacidad es un
 * documento legal y su casilla no puede desaparecer porque falte una env en el
 * deploy. Es el mismo email que el publisher de la extensión en el Chrome Web
 * Store, que lo exige verificado y lo muestra en la ficha.
 */
const CONTACTO = CONTACTO_SOPORTE

/** Última revisión del texto. Se actualiza a mano cuando el contenido cambia. */
const ACTUALIZADO = '21 de agosto de 2026'

const c = {
  fondo: '#0f1115',
  panel: '#171a21',
  borde: 'rgba(255,255,255,0.08)',
  texto: '#e7e9ee',
  suave: '#a8b0bd',
  tenue: '#7d8695',
  acento: '#818cf8',
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '2.5rem' }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: c.texto, margin: '0 0 0.75rem', letterSpacing: '-0.01em' }}>
        {titulo}
      </h2>
      <div style={{ color: c.suave, fontSize: '0.95rem', lineHeight: 1.7 }}>{children}</div>
    </section>
  )
}

function Lista({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
      {items.map((x, i) => <li key={i} style={{ marginBottom: '0.4rem' }}>{x}</li>)}
    </ul>
  )
}

export function Privacidad() {
  const navigate = useNavigate()

  return (
    <div
      data-testid="pagina-privacidad"
      style={{ minHeight: '100vh', background: c.fondo, color: c.texto, padding: '2rem 1rem 5rem' }}
    >
      <div style={{ maxWidth: 760, margin: '0 auto' }}>

        <button
          onClick={() => navigate('/landing')}
          style={{ background: 'none', border: 'none', color: c.tenue, cursor: 'pointer', padding: 0, fontSize: '0.85rem', marginBottom: '2rem' }}
        >
          ← Volver al inicio
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <img src={logoSvg} alt="" width={40} height={40} style={{ borderRadius: '0.6rem' }} />
          <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>TechRepair Pro</span>
        </div>

        <h1 style={{ fontSize: '1.9rem', fontWeight: 800, margin: '0 0 0.5rem', letterSpacing: '-0.02em' }}>
          Política de privacidad
        </h1>
        <p style={{ color: c.tenue, fontSize: '0.85rem', margin: 0 }}>
          Última actualización: {ACTUALIZADO}
        </p>

        <Seccion titulo="Qué cubre este documento">
          <p style={{ margin: 0 }}>
            TechRepair Pro es un sistema de gestión para talleres y locales de reparación.
            Esta política cubre tres cosas distintas: la aplicación web, la analítica de las
            páginas públicas, y la extensión de Chrome <strong>TechRepair Companion</strong>.
          </p>
        </Seccion>

        <Seccion titulo="Datos de tu negocio en la aplicación">
          <p style={{ margin: 0 }}>
            Los datos que cargás —clientes, equipos, órdenes, comprobantes, pagos e inventario—
            se guardan en nuestra base de datos y quedan acotados a tu negocio: cada consulta se
            filtra por el negocio de tu sesión a nivel de base de datos, no sólo en la interfaz.
            Los usa el sistema para prestarte el servicio. No los vendemos y no hacemos
            publicidad con ellos.
          </p>
          <p style={{ marginBottom: 0 }}>
            Cuando preparás un mensaje de WhatsApp desde TechRepair Pro, la aplicación registra
            el número de teléfono y el <strong>texto completo del mensaje</strong> junto con la
            marca de que iniciaste el envío. Ese registro es de la aplicación, queda dentro de tu
            negocio, y sirve para que tengas el historial de lo que le mandaste a cada cliente.
            La aplicación <strong>no puede saber</strong> si el mensaje efectivamente se envió:
            eso ocurre dentro de WhatsApp.
          </p>
        </Seccion>

        <Seccion titulo="Cuánto tiempo conservamos los mensajes">
          <p style={{ margin: 0 }} data-testid="privacidad-retencion">
            Los mensajes de WhatsApp que preparás no se guardan para siempre. La política es
            automática y corre todos los días:
          </p>
          <Lista items={[
            <>El <strong>número de teléfono</strong> del destinatario y el <strong>cuerpo del mensaje</strong> se conservan por un máximo de <strong>90 días</strong> desde que se preparó el mensaje.</>,
            <>Cumplidos los 90 días, <strong>esos campos se eliminan</strong>. En su lugar el historial muestra “Contenido eliminado por política de retención”, así seguís sabiendo que hubo un contacto y cuándo, pero el contenido ya no está.</>,
            <>La <strong>metadata operacional</strong> —la fecha, la orden asociada, la plantilla usada y el resultado— se conserva por un máximo de <strong>12 meses</strong>.</>,
            <>Cumplidos los <strong>12 meses</strong>, el registro <strong>se elimina por completo</strong>.</>,
          ]} />
          <p style={{ marginBottom: 0 }}>
            La eliminación es definitiva: no guardamos una copia, ni un resumen, ni un valor
            derivado del que se pueda reconstruir el mensaje original.
          </p>
        </Seccion>

        <Seccion titulo="Analítica de las páginas públicas">
          <p style={{ margin: 0 }}>
            En las páginas públicas usamos herramientas de analítica para entender qué secciones
            se visitan. Sólo viajan datos de una lista cerrada de eventos de navegación:
            nunca el identificador de tu negocio, tu usuario, tu email, teléfonos, importes ni
            datos de clientes u órdenes. Del sitio que te trajo guardamos sólo el dominio.
            Dentro de la aplicación, una vez que iniciás sesión, no hay analítica de este tipo.
          </p>
        </Seccion>

        <div
          id="whatsapp-companion"
          data-testid="privacidad-companion"
          style={{ marginTop: '3rem', padding: '1.5rem', background: c.panel, border: `1px solid ${c.borde}`, borderRadius: '0.9rem' }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0 0 0.35rem', letterSpacing: '-0.015em' }}>
            Extensión TechRepair Companion
          </h2>
          <p style={{ color: c.tenue, fontSize: '0.85rem', margin: '0 0 1.25rem' }}>
            Complemento de Chrome. No está afiliado a WhatsApp ni a Meta Platforms, Inc.
          </p>

          <Seccion titulo="Qué hace">
            <p style={{ margin: 0 }}>
              Abre —o reutiliza— una única pestaña de WhatsApp Web con la conversación y el
              mensaje que preparaste en TechRepair Pro, para que contactar a un cliente no te
              llene el navegador de pestañas. <strong>El botón Enviar lo apretás vos, siempre.</strong>
            </p>
          </Seccion>

          <Seccion titulo="Qué datos recibe">
            <p style={{ margin: 0 }}>
              Cuando hacés clic en abrir WhatsApp dentro de TechRepair Pro, y sólo entonces, la
              extensión recibe dos datos desde el sitio:
            </p>
            <Lista items={[
              'el número de teléfono del destinatario;',
              'el texto del mensaje que preparaste.',
            ]} />
            <p style={{ marginBottom: 0 }}>
              No recibe ningún otro dato: ni el identificador de tu negocio, ni datos del
              cliente, ni información de la orden, ni credenciales.
            </p>
          </Seccion>

          <Seccion titulo="Para qué los usa">
            <p style={{ margin: 0 }}>
              Únicamente para construir la dirección <code>web.whatsapp.com/send</code> con ese
              número y ese texto, y llevar una pestaña de WhatsApp Web hasta ahí. La dirección la
              arma la extensión con un host y una ruta fijos de su propio código: el sitio que la
              invoca nunca aporta la dirección de destino.
            </p>
          </Seccion>

          <Seccion titulo="Qué NO hace con ellos">
            <Lista items={[
              <><strong>No los guarda.</strong> La extensión no pide el permiso de almacenamiento y su código no usa ninguna forma de almacenamiento del navegador. Los usa una sola vez, dentro de la operación que los recibe; al terminar no queda ninguna copia dentro de la extensión.</>,
              <><strong>No los envía a ningún servidor nuestro.</strong> El código de la extensión no hace una sola petición de red.</>,
              <><strong>No los vende ni los comparte</strong> con terceros con fines publicitarios. No hay publicidad de ningún tipo.</>,
              <><strong>Nadie de nuestro equipo puede leerlos:</strong> no llegan a ningún sistema nuestro desde la extensión.</>,
            ]} />
          </Seccion>

          <Seccion titulo="Quién recibe esos datos">
            <p style={{ margin: 0 }}>
              <strong>WhatsApp (Meta).</strong> Abrir el chat significa navegar a
              web.whatsapp.com con el número y el mensaje en la dirección, así que ese contenido
              llega a la infraestructura de Meta, igual que si hubieras abierto ese enlace a
              mano. El uso que WhatsApp haga de esos datos se rige por su propia política de
              privacidad.
            </p>
          </Seccion>

          <Seccion titulo="Qué queda en tu navegador">
            <p style={{ margin: 0 }}>
              Como abrir el chat es una navegación normal, tu navegador registra esa dirección
              —que contiene el número y el mensaje— en el historial y en la restauración de
              sesión, y la sincroniza con tu cuenta de Google si tenés activada la sincronización
              de historial. <strong>Ese registro lo hace el navegador, no la extensión</strong>, y
              podés borrarlo desde el historial de Chrome. La extensión no lee ni borra tu
              historial: no pide ese permiso.
            </p>
          </Seccion>

          <Seccion titulo="Qué ve de tus pestañas">
            <p style={{ margin: 0 }}>
              Para encontrar tu pestaña de WhatsApp Web, Chrome le entrega a la extensión los
              datos de las pestañas abiertas en web.whatsapp.com <strong>y sólo de ésas</strong>:
              su dirección, su título, su ícono, si está activa y cuándo la usaste por última vez.
              De todo eso la extensión mira únicamente si está activa, cuándo se usó, y en qué
              ventana y posición está, para decidir cuál reutilizar. No guarda nada de eso y no lo
              envía a ningún lado.
            </p>
            <p style={{ marginBottom: 0 }}>
              De las pestañas de cualquier otro sitio no recibe ni la dirección ni el título: la
              extensión no pide el permiso que daría ese acceso.
            </p>
          </Seccion>

          <Seccion titulo="Lo que la extensión no puede hacer">
            <p style={{ margin: 0 }}>
              No inyecta código en WhatsApp Web ni lee su contenido. No lee tus chats, tus
              contactos, tus mensajes ni el código QR. No usa las APIs de cookies, almacenamiento
              ni historial. No envía mensajes por vos.
            </p>
          </Seccion>

          <Seccion titulo="Permiso que solicita">
            <p style={{ margin: 0 }}>
              Uno solo: acceso a <code>https://web.whatsapp.com</code>. Se usa exclusivamente para
              localizar y navegar la pestaña de WhatsApp Web. Al instalarla, Chrome te va a avisar
              que puede «leer y cambiar tus datos en web.whatsapp.com»: es el permiso más chico
              que existe para poder hacerlo, y la extensión no lo usa para leer nada.
            </p>
          </Seccion>

          <Seccion titulo="Uso limitado">
            <p style={{ margin: 0 }}>
              El uso que TechRepair Companion hace de la información que recibe cumple con la
              política de <em>Limited Use</em> del Chrome Web Store, incluidos sus requisitos de
              uso limitado.
            </p>
          </Seccion>
        </div>

        <Seccion titulo="Cambios">
          <p style={{ margin: 0 }}>
            Si esta política cambia, actualizamos la fecha del encabezado y publicamos la versión
            nueva en esta misma dirección.
          </p>
        </Seccion>

        <Seccion titulo="Contacto">
          {CONTACTO ? (
            <p style={{ margin: 0 }} data-testid="privacidad-contacto">
              Escribinos a{' '}
              <a href={`mailto:${CONTACTO}`} style={{ color: c.acento }}>{CONTACTO}</a>.
            </p>
          ) : (
            /* Fail-closed: sin casilla configurada no se inventa una dirección. */
            <p style={{ margin: 0 }} data-testid="privacidad-contacto-pendiente">
              Estamos definiendo la casilla de contacto para consultas de privacidad. Mientras
              tanto, podés escribirnos desde el mismo canal por el que contrataste el servicio.
            </p>
          )}
        </Seccion>

      </div>
    </div>
  )
}
