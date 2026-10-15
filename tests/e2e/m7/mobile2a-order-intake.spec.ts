import { expect, test, type Page } from '@playwright/test'

const EVIDENCE='docs/p0-mobile-evidence/implementation-mobile-2a'

async function noOverflow(page:Page){const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));expect(size.scroll).toBeLessThanOrEqual(size.client+1)}
async function continueStep(page:Page){const button=page.getByTestId('mobile-action-bar').getByRole('button',{name:'Continuar'});await expect(button).toBeVisible();const box=await button.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);await button.click()}
async function selectSeedCustomer(page:Page){await page.getByLabel('Buscar cliente').fill('Cliente E2E');await page.getByRole('button',{name:/Cliente E2E/}).click();await continueStep(page)}
/**
 * Guarda el acceso de una orden por `set_order_device_access_secret` con la
 * sesión de la página, tal como lo hacía el frontend anterior (que mandaba la
 * grilla cruda como arreglo de números). Sólo stack local (.env.e2e).
 */
async function guardarComoFrontendAnterior(page:Page,orderId:string,secret:string){
  const url=process.env.VITE_SUPABASE_URL,anon=process.env.VITE_SUPABASE_ANON_KEY
  if(!url||!anon)throw new Error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (.env.e2e)')
  const status=await page.evaluate(async({url,anon,orderId,secret})=>{
    const clave=Object.keys(localStorage).find(k=>/^sb-.*-auth-token$/.test(k))
    const token=clave?JSON.parse(localStorage.getItem(clave)||'{}').access_token:null
    const respuesta=await fetch(`${url}/rest/v1/rpc/set_order_device_access_secret`,{method:'POST',
      headers:{apikey:anon,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_order_id:orderId,p_mode:'pattern',p_secret:secret})})
    return respuesta.status
  },{url,anon,orderId,secret})
  expect(status,'el servidor acepta el formato anterior').toBeLessThan(300)
}

test.describe('@mobile2a MOBILE-2A · recepción OWNER',()=>{
  test('quick-create queda por encima de la action bar y abre en cada ancho mobile',async({page})=>{
    for(const viewport of [{width:320,height:568},{width:390,height:844},{width:430,height:932}]){
      await page.setViewportSize(viewport)
      await page.goto('/orders/new')
      const quickCreate=page.getByRole('button',{name:'Crear cliente rápido'})
      await expect(quickCreate).toBeVisible()
      // BETA-UX-2: `html` tiene `scroll-behavior: smooth` y desde que la barra
      // reserva su lugar con `scroll-padding-bottom` el navegador SÍ scrollea
      // acá. Con el scroll suave la medida de abajo caía a mitad de la animación
      // (CI: 434 contra 423 ya quieto). Se mide la posición FINAL: el control sin
      // `scroll-padding` sigue dando superposición con este mismo scroll.
      await quickCreate.evaluate(element=>element.scrollIntoView({block:'end',behavior:'instant'}))

      const geometry=await page.evaluate(()=>{
        const quick=Array.from(document.querySelectorAll('button')).find(element=>element.textContent?.trim()==='Crear cliente rápido')
        const bar=document.querySelector('[data-testid="mobile-action-bar"]')
        if(!quick||!bar)throw new Error('Falta quick-create o MobileActionBar')
        const buttonRect=quick.getBoundingClientRect()
        const barRect=bar.getBoundingClientRect()
        const x=buttonRect.left+buttonRect.width/2
        const points=[buttonRect.top+4,buttonRect.top+buttonRect.height/2,buttonRect.bottom-4]
        return {
          intersects:buttonRect.bottom>barRect.top&&buttonRect.top<barRect.bottom,
          hitTargets:points.map(y=>{const hit=document.elementFromPoint(x,y);return hit===quick||Boolean(hit&&quick.contains(hit))}),
          overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        }
      })

      expect(geometry.intersects).toBe(false)
      expect(geometry.hitTargets).toEqual([true,true,true])
      expect(geometry.overflow).toBeLessThanOrEqual(1)
      await quickCreate.click()
      const dialog=page.getByRole('dialog',{name:'Crear cliente rápido'})
      await expect(dialog).toBeVisible()
      const retail=dialog.getByTestId('customer-type-minorista')
      const wholesale=dialog.getByTestId('customer-type-mayorista')
      await expect(retail).toHaveAttribute('aria-pressed','true')
      await expect(wholesale).toHaveAttribute('aria-pressed','false')

      await wholesale.click()
      await expect(wholesale).toHaveAttribute('aria-pressed','true')
      await dialog.getByLabel('Razón social').fill('Mayorista temporal')
      await dialog.getByLabel('Persona de contacto').fill('Contacto temporal')

      await retail.click()
      await expect(retail).toHaveAttribute('aria-pressed','true')
      await expect(dialog.getByLabel('Razón social')).not.toBeVisible()
      await expect(dialog.getByLabel('Persona de contacto')).not.toBeVisible()

      await wholesale.click()
      await expect(dialog.getByLabel('Razón social')).toHaveValue('')
      await expect(dialog.getByLabel('Persona de contacto')).toHaveValue('')
      await dialog.getByRole('button',{name:'Cerrar'}).click()
      await expect(dialog).not.toBeVisible()
    }
  })

  // BETA-UX-2: la recepción pasó de 10 pasos a 4 (Cliente · Equipo · Ingreso ·
  // Confirmar). Las capturas conservan sus nombres de archivo; lo que muestran
  // ahora es el paso donde vive cada cosa.
  test('flujo completo USD, foto, checklist, secreto enmascarado e idempotencia visual',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('techrepair_theme','dark')})
    await page.goto('/orders/new')
    const stepper=page.getByTestId('intake-stepper')
    await expect(stepper.getByRole('listitem')).toHaveCount(4)
    await expect(stepper.locator('[aria-current="step"]')).toContainText('Cliente')
    await noOverflow(page)
    await page.getByLabel('Buscar cliente').fill('Cliente E2E')
    await expect(page.getByRole('button',{name:/Cliente E2E/})).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-01-cliente.png`})
    await page.getByRole('button',{name:/Cliente E2E/}).click();await continueStep(page)

    // ── Equipo: tipo, marca/modelo, serie/IMEI y acceso en el mismo paso ──
    await page.getByLabel('Marca').fill('Samsung')
    await page.getByLabel('Modelo').fill('Galaxy S24')
    await page.screenshot({path:`${EVIDENCE}/390x844-02-equipo.png`})

    await page.getByRole('button',{name:'Escanear'}).first().click()
    // ORDERS-V2-0.1: el diálogo dice QUÉ se escanea. El primer botón
    // «Escanear» es el del número de serie.
    await expect(page.getByRole('dialog',{name:'Escanear número de serie'})).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-03-scanner-fallback.png`})
    await page.getByRole('dialog').getByRole('button',{name:'Cerrar'}).last().click()
    await page.getByLabel('Número de serie').fill('SERIAL-E2E-M2A')
    await page.getByLabel('IMEI (opcional)').fill('490154203237518')

    await page.getByRole('button',{name:/PIN Código numérico/}).click()
    await page.getByLabel('PIN').fill('4826')
    await expect(page.getByLabel('PIN')).toHaveAttribute('type','password')
    await page.screenshot({path:`${EVIDENCE}/390x844-06-acceso-pin.png`})
    await page.getByRole('button',{name:/Patrón Secuencia/}).click()
    await page.getByRole('button',{name:'Punto 1'}).click();await page.getByRole('button',{name:'Punto 5'}).click();await page.getByRole('button',{name:'Punto 9'}).click()
    await page.screenshot({path:`${EVIDENCE}/390x844-07-acceso-patron.png`})
    await page.getByRole('button',{name:/PIN Código numérico/}).click();await page.getByLabel('PIN').fill('4826')
    await continueStep(page)

    // ── Ingreso: problema, estado, fotos y checklist (plegado) ──
    await page.getByLabel('Problema informado por el cliente').fill('No carga de forma estable')
    await page.getByLabel('Observaciones de recepción').fill('Llega con funda')
    await page.locator('input[type=file]').setInputFiles({name:'recepcion-e2e.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')})
    await expect(page.getByAltText('Foto de recepción 1')).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-04-estado-fotos.png`})

    // ORDERS-V2-0: el checklist dejó de ser `<select>` y pasó a radios en
    // segmented control. El resultado guardado es el mismo `CheckResult`.
    await page.getByTestId('intake-checklist').locator('summary').click()
    await page.getByRole('radio',{name:'Pantalla: OK'}).check()
    await page.getByRole('radio',{name:'Táctil: Falla'}).check()
    await expect(page.getByRole('radio',{name:'Pantalla: OK'})).toBeChecked()
    await expect(page.getByRole('radio',{name:'Táctil: Falla'})).toBeChecked()
    await page.screenshot({path:`${EVIDENCE}/390x844-05-checklist.png`})
    await page.setViewportSize({width:320,height:568});await noOverflow(page)
    await page.screenshot({path:`${EVIDENCE}/320x568-checklist-denso.png`})
    await page.setViewportSize({width:390,height:844});await continueStep(page)

    // ── Confirmar: asignación y presupuesto opcionales + resumen ──
    await page.getByLabel('Prioridad').selectOption('high')
    // ORDERS-V2-0.1: moneda y monto son una sola unidad (AppMoneyInput). El
    // grupo lleva el nombre del campo, así que el monto se toma por testid.
    await page.getByTestId('intake-budget').fill('150,50')
    await expect(page.getByTestId('intake-budget')).toHaveValue('150,50')
    await page.getByTestId('intake-budget-currency').selectOption('USD')
    await expect(page.locator('.app-money-prefix')).toHaveText('US$')
    await page.screenshot({path:`${EVIDENCE}/390x844-08-presupuesto-usd.png`})

    await expect(page.getByText('PIN configurado')).toBeVisible()
    await expect(page.getByText('4826')).toHaveCount(0)
    await page.setViewportSize({width:430,height:932});await noOverflow(page)
    await page.screenshot({path:`${EVIDENCE}/430x932-09-resumen.png`})
    const create=page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'})
    await expect(create).toBeVisible();await create.dblclick({delay:25})
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
    await expect(page.getByText('PIN configurado')).toBeVisible()
    await expect(page.getByText('4826')).toHaveCount(0)
  })

  test('recepción mínima no obliga foto, checklist, técnico ni presupuesto',async({page})=>{
    await page.setViewportSize({width:360,height:800})
    await page.addInitScript(()=>{localStorage.setItem('theme','light');localStorage.setItem('techrepair_theme','light')})
    await page.goto('/orders/new');await expect(page.locator('html')).toHaveAttribute('data-theme','light');await selectSeedCustomer(page)
    // BETA-UX-2: tres «Continuar» y «Crear orden» (antes eran nueve).
    await page.getByLabel('Marca').fill('Motorola');await page.getByLabel('Modelo').fill('Moto G')
    await page.getByRole('button',{name:/Sin bloqueo/}).click();await continueStep(page)
    await page.getByLabel('Problema informado por el cliente').fill('No enciende');await continueStep(page)
    await expect(page.getByText('Sin presupuesto')).toBeVisible();await expect(page.getByText('Sin bloqueo')).toBeVisible()
    await page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'}).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
  })

  /**
   * BETA-UX-2 — el patrón no bloquea la orden. Contra la base REAL.
   *
   * La grilla numera 1–9; el servidor (`private.mobile2a_legacy_from_access`)
   * acepta 0–8. Hasta este lote un patrón con el punto 9 hacía fallar TODA la
   * creación con `INVALID_ACCESS_PATTERN`, y el spec anterior no lo veía: dibujaba
   * 1-5-9 pero volvía a PIN antes de crear. Acá se crea con el patrón, se lo
   * revela desde el detalle y tiene que leerse igual a lo que se dibujó.
   */
  test('un patrón con el punto 9 crea la orden y se revela con la misma numeración',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.goto('/orders/new');await selectSeedCustomer(page)
    await page.getByLabel('Marca').fill('Motorola');await page.getByLabel('Modelo').fill('Moto G')
    await page.getByRole('button',{name:/Patrón Secuencia/}).click()
    for(const punto of [1,5,9])await page.getByRole('button',{name:`Punto ${punto}`}).click()
    // Tres puntos: ayuda, no bloqueo.
    await expect(page.getByTestId('intake-access-notice')).toHaveAttribute('data-level','info')
    await continueStep(page)
    await page.getByLabel('Problema informado por el cliente').fill('Pantalla bloqueada');await continueStep(page)
    await expect(page.getByText('Patrón configurado')).toBeVisible()
    await page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'}).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
    await expect(page.getByRole('alert')).toHaveCount(0)

    await expect(page.getByTestId('device-lock-status')).toHaveText('Patrón configurado')
    await page.getByRole('button',{name:'Revelar'}).click()
    // BETA-UX-2 · hotfix: se ve como grilla 3×3 (el nombre accesible lleva la secuencia).
    await expect(page.getByTestId('device-lock-reveal').getByRole('img',{name:/Patrón de 3 puntos, en orden: 1, 5, 9\./})).toBeVisible()
    await expect(page.getByTestId('device-lock-legacy')).toHaveCount(0)
  })

  /**
   * BETA-UX-2 · hotfix — un patrón con el formato ANTERIOR (arreglo de números
   * sin 0 ni 9, como lo guardaba el frontend de MOBILE-2A) no se puede leer con
   * certeza: la misma lista es un patrón en la grilla 1–9 y otro en el contrato
   * 0–8. Se siembra por la MISMA RPC que usaba ese frontend, con la sesión real,
   * y la tarjeta tiene que avisar en vez de dibujarlo. Valor SINTÉTICO.
   */
  test('un patrón con formato anterior no se dibuja: avisa y se reconfigura',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.goto('/orders/new');await selectSeedCustomer(page)
    await page.getByLabel('Marca').fill('Motorola');await page.getByLabel('Modelo').fill('Moto G')
    await page.getByRole('button',{name:/Sin bloqueo/}).click();await continueStep(page)
    await page.getByLabel('Problema informado por el cliente').fill('Pantalla bloqueada');await continueStep(page)
    await page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'}).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
    const orderId=new URL(page.url()).pathname.split('/').pop()!
    await guardarComoFrontendAnterior(page,orderId,'[1,2,5,8]')
    await page.reload()

    await expect(page.getByTestId('device-lock-status')).toHaveText('Patrón configurado')
    await page.getByRole('button',{name:'Revelar'}).click()
    const aviso=page.getByTestId('device-lock-legacy')
    await expect(aviso).toContainText('Patrón guardado con formato anterior')
    // Ni la grilla ni una secuencia: nada que pueda tomarse por el patrón.
    await expect(page.getByTestId('device-lock-pattern')).toHaveCount(0)
    await expect(page.getByRole('img',{name:/^Patrón de/})).toHaveCount(0)
    await expect(aviso).not.toContainText(/\d/)
    for(const accion of ['Ocultar','Configurar','Eliminar'])await expect(page.getByRole('button',{name:accion,exact:true})).toBeVisible()

    // Reconfigurar lo guarda en el formato actual, y desde ahí se ve exacto.
    await aviso.getByRole('button',{name:'Reconfigurar patrón'}).click()
    for(const punto of [1,2,5,8])await page.getByRole('button',{name:`Punto ${punto}`}).click()
    await page.getByRole('button',{name:'Guardar'}).click()
    await expect(page.getByRole('button',{name:'Revelar'})).toBeVisible()
    await page.getByRole('button',{name:'Revelar'}).click()
    await expect(page.getByTestId('device-lock-reveal').getByRole('img',{name:/Patrón de 4 puntos, en orden: 1, 2, 5, 8\./})).toBeVisible()
    await expect(page.getByTestId('device-lock-legacy')).toHaveCount(0)
  })

  test('un patrón sin dibujar no frena: la orden se crea como «No lo proporcionó»',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.goto('/orders/new');await selectSeedCustomer(page)
    await page.getByLabel('Marca').fill('Motorola');await page.getByLabel('Modelo').fill('Moto G')
    await page.getByRole('button',{name:/Patrón Secuencia/}).click()
    await page.getByRole('button',{name:'Punto 5'}).click()
    await expect(page.getByTestId('intake-access-notice')).toHaveAttribute('data-level','warning')
    await continueStep(page)
    await expect(page.getByRole('heading',{level:1})).toHaveText('Problema y estado')
    await page.getByLabel('Problema informado por el cliente').fill('No enciende');await continueStep(page)
    await expect(page.getByText(/No lo proporcionó \(el patrón quedó sin cargar\)/)).toBeVisible()
    await page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'}).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
    await expect(page.getByTestId('device-lock-status')).toHaveText('No proporcionado')
  })
})
