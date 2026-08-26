import { expect, test, type Page } from '@playwright/test'

const EVIDENCE='docs/p0-mobile-evidence/implementation-mobile-2a'

async function noOverflow(page:Page){const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));expect(size.scroll).toBeLessThanOrEqual(size.client+1)}
async function continueStep(page:Page){const button=page.getByTestId('mobile-action-bar').getByRole('button',{name:'Continuar'});await expect(button).toBeVisible();const box=await button.boundingBox();expect(box?.height).toBeGreaterThanOrEqual(44);await button.click()}
async function selectSeedCustomer(page:Page){await page.getByLabel('Buscar cliente').fill('Cliente E2E');await page.getByRole('button',{name:/Cliente E2E/}).click();await continueStep(page)}

test.describe('@mobile2a MOBILE-2A · recepción OWNER',()=>{
  test('quick-create queda por encima de la action bar y abre en cada ancho mobile',async({page})=>{
    for(const viewport of [{width:320,height:568},{width:390,height:844},{width:430,height:932}]){
      await page.setViewportSize(viewport)
      await page.goto('/orders/new')
      const quickCreate=page.getByRole('button',{name:'Crear cliente rápido'})
      await expect(quickCreate).toBeVisible()
      await quickCreate.evaluate(element=>element.scrollIntoView({block:'end'}))

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
      const customerType=dialog.getByLabel('Tipo de cliente')
      await expect(customerType).toHaveValue('minorista')
      await customerType.selectOption('mayorista')
      await expect(dialog.getByLabel('Razón social')).toBeVisible()
      await customerType.selectOption('minorista')
      await expect(dialog.getByLabel('Razón social')).not.toBeVisible()
      await dialog.getByRole('button',{name:'Cerrar'}).click()
      await expect(dialog).not.toBeVisible()
    }
  })

  test('flujo completo USD, foto, checklist, secreto enmascarado e idempotencia visual',async({page})=>{
    await page.setViewportSize({width:390,height:844})
    await page.addInitScript(()=>{localStorage.setItem('theme','dark');localStorage.setItem('techrepair_theme','dark')})
    await page.goto('/orders/new')
    await expect(page.getByText('Nueva orden · Paso 1 de 10')).toBeVisible()
    await noOverflow(page)
    await page.getByLabel('Buscar cliente').fill('Cliente E2E')
    await expect(page.getByRole('button',{name:/Cliente E2E/})).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-01-cliente.png`})
    await page.getByRole('button',{name:/Cliente E2E/}).click();await continueStep(page)

    await page.getByLabel('Marca').fill('Samsung')
    await page.getByLabel('Modelo').fill('Galaxy S24')
    await page.screenshot({path:`${EVIDENCE}/390x844-02-equipo.png`})
    await continueStep(page)

    await page.getByRole('button',{name:'Escanear'}).first().click()
    await expect(page.getByRole('dialog',{name:'Escanear identificación'})).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-03-scanner-fallback.png`})
    await page.getByRole('dialog').getByRole('button',{name:'Cerrar'}).last().click()
    await page.getByLabel('Número de serie').fill('SERIAL-E2E-M2A')
    await page.getByLabel('IMEI (opcional)').fill('490154203237518')
    await continueStep(page)

    await page.locator('input[type=file]').setInputFiles({name:'recepcion-e2e.png',mimeType:'image/png',buffer:Buffer.from('89504e470d0a1a0a','hex')})
    await expect(page.getByAltText('Foto de recepción 1')).toBeVisible()
    await page.screenshot({path:`${EVIDENCE}/390x844-04-estado-fotos.png`})
    await continueStep(page)

    await page.getByLabel('Pantalla').selectOption('ok')
    await page.getByLabel('Táctil').selectOption('fail')
    await page.screenshot({path:`${EVIDENCE}/390x844-05-checklist.png`})
    await page.setViewportSize({width:320,height:568});await noOverflow(page)
    await page.screenshot({path:`${EVIDENCE}/320x568-checklist-denso.png`})
    await page.setViewportSize({width:390,height:844});await continueStep(page)

    await page.getByRole('button',{name:/PIN Código numérico/}).click()
    await page.getByLabel('PIN').fill('4826')
    await expect(page.getByLabel('PIN')).toHaveAttribute('type','password')
    await page.screenshot({path:`${EVIDENCE}/390x844-06-acceso-pin.png`})
    await page.getByRole('button',{name:/Patrón Secuencia/}).click()
    await page.getByRole('button',{name:'Punto 1'}).click();await page.getByRole('button',{name:'Punto 5'}).click();await page.getByRole('button',{name:'Punto 9'}).click()
    await page.screenshot({path:`${EVIDENCE}/390x844-07-acceso-patron.png`})
    await page.getByRole('button',{name:/PIN Código numérico/}).click();await page.getByLabel('PIN').fill('4826')
    await continueStep(page)

    await page.getByLabel('Problema informado por el cliente').fill('No carga de forma estable')
    await page.getByLabel('Observaciones de recepción').fill('Llega con funda')
    await continueStep(page)
    await page.getByLabel('Prioridad').selectOption('high')
    await continueStep(page)
    await page.getByLabel('Presupuesto estimado').fill('150,50')
    await page.getByLabel('Moneda').selectOption('USD')
    await page.screenshot({path:`${EVIDENCE}/390x844-08-presupuesto-usd.png`})
    await continueStep(page)

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
    await page.getByLabel('Marca').fill('Motorola');await page.getByLabel('Modelo').fill('Moto G');await continueStep(page)
    await continueStep(page);await continueStep(page);await continueStep(page)
    await page.getByRole('button',{name:/Sin bloqueo/}).click();await continueStep(page)
    await page.getByLabel('Problema informado por el cliente').fill('No enciende');await continueStep(page)
    await continueStep(page);await continueStep(page)
    await expect(page.getByText('Sin presupuesto')).toBeVisible();await expect(page.getByText('Sin bloqueo')).toBeVisible()
    await page.getByTestId('mobile-action-bar').getByRole('button',{name:'Crear orden'}).click()
    await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/,{timeout:20_000})
  })
})
