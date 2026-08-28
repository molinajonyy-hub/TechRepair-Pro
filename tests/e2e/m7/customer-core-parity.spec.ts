// ─────────────────────────────────────────────────────────────────────────────
// UI-CONSISTENCY-1 · Gate distintivo de paridad.
//
// Crea el MISMO cliente lógico por las dos superficies de alta, con los mismos
// campos del core, y compara las filas REALMENTE PERSISTIDAS.
//
//   A. Clientes → Nuevo cliente      (página completa)
//   B. Nueva Orden → Crear cliente rápido (diálogo)
//
// Antes de este lote, el mismo tecleo producía filas distintas:
//   A guardaba `DNI: 30.123.456` · B guardaba `30.123.456`.
//
// Corre sólo bajo el proyecto `m7-local`: stack local, usuario sembrado, y el
// globalSetup valida el destino antes de cualquier spec. `consultarJSON` va por
// `docker exec` al contenedor local, así que este archivo es estructuralmente
// incapaz de tocar producción.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test, type Locator, type Page } from '@playwright/test'
import { consultarJSON, ejecutarSQL } from '../setup/sqlLocal'
import { E2E } from '../setup/seedE2E'

// Marca propia del lote: hace el cleanup exacto y no toca fixtures ajenos.
const MARK = 'UICONS1'
const FULL_PAGE_NAME = `${MARK} Alta Full Page`
const QUICK_NAME = `${MARK} Alta Rapida`
const PHONE = '3512345678'
const EMAIL = 'uicons1@example.test'
const ADDRESS = 'Av. Corrientes 1234, CABA'
const NOTES = 'Cliente de prueba de paridad.'
const DOCUMENT_TYPED = 'AB-123.456'

type CustomerRow = {
  name: string
  phone: string | null
  email: string | null
  document: string | null
  customer_type: string
  business_name: string | null
  contact_person: string | null
  address: string | null
  notes: string | null
}

function readCustomer(name: string): CustomerRow {
  return consultarJSON<CustomerRow>(`
    SELECT name, phone, email, document, customer_type, business_name, contact_person, address, notes
      FROM public.customers
     WHERE business_id = '${E2E.business}' AND name = '${name}'
  `)
}

function cleanup() {
  ejecutarSQL(`DELETE FROM public.customers
                WHERE business_id = '${E2E.business}' AND name LIKE '${MARK} %';`)
}

async function createFromFullPage(page: Page) {
  await page.goto('/customers/new')
  await page.getByTestId('customer-name-input').fill(FULL_PAGE_NAME)
  await page.getByTestId('customer-phone-input').fill(PHONE)
  await page.getByTestId('customer-email-input').fill(EMAIL)
  await page.getByTestId('customer-document-input').fill(DOCUMENT_TYPED)
  await page.getByTestId('customer-address-input').fill(ADDRESS)
  await page.getByTestId('customer-notes-input').fill(NOTES)
  await page.getByTestId('customer-save-button').click()
  // La página completa navega al detalle del cliente creado.
  await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/)
}

async function createFromQuickDialog(page: Page) {
  await page.goto('/orders/new')
  await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
  const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Nombre completo').fill(QUICK_NAME)
  await dialog.getByLabel('Teléfono').fill(PHONE)
  await dialog.getByTestId('customer-additional-toggle').click()
  await dialog.getByLabel('Email').fill(EMAIL)
  await dialog.getByLabel('DNI').fill(DOCUMENT_TYPED)
  await dialog.getByLabel('Dirección').fill(ADDRESS)
  await dialog.getByLabel('Notas').fill(NOTES)
  await dialog.getByRole('button', { name: 'Crear cliente' }).click()
  await expect(dialog).not.toBeVisible()
  // Contrato con el wizard: vuelve seleccionado en el paso Cliente.
  await expect(page.getByRole('button', { name: new RegExp(QUICK_NAME) })).toBeVisible()
}

test.describe('@customer-core UI-CONSISTENCY-1 · paridad entre superficies de alta', () => {
  test.beforeEach(() => cleanup())
  test.afterAll(() => cleanup())

  test('el mismo cliente creado por las dos superficies persiste igual', async ({ page }) => {
    await createFromFullPage(page)
    await createFromQuickDialog(page)

    const full = readCustomer(FULL_PAGE_NAME)
    const quick = readCustomer(QUICK_NAME)

    // 1) El documento quedó en el formato canónico en AMBAS filas.
    expect(full.document).toBe('DNI AB123456')
    expect(quick.document).toBe('DNI AB123456')

    // 2) Los campos compartidos son semánticamente idénticos.
    //    (`name` se excluye a propósito: es lo único que distingue las filas.)
    for (const field of ['phone', 'email', 'document', 'customer_type', 'business_name', 'contact_person', 'address', 'notes'] as const) {
      expect(quick[field], `divergencia en "${field}"`).toEqual(full[field])
    }

    // 3) Y el tipo de cliente es un valor que acepta el CHECK de la tabla.
    expect(full.customer_type).toBe('minorista')
  })

  test('un mayorista creado por cada superficie persiste igual', async ({ page }) => {
    const fullWholesale = `${MARK} Mayorista Full`
    const quickWholesale = `${MARK} Mayorista Rapido`

    await page.goto('/customers/new')
    await page.getByTestId('customer-name-input').fill(fullWholesale)
    await page.getByTestId('customer-phone-input').fill(PHONE)
    await page.getByTestId('customer-type-mayorista').click()
    // Elegir mayorista pasa el documento a CUIT en las dos superficies.
    await expect(page.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('customer-document-input').fill('20-30123456-7')
    await page.getByTestId('customer-business-name-input').fill('Demo SRL')
    await page.getByTestId('customer-save-button').click()
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/)

    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    await dialog.getByTestId('customer-type-mayorista').click()
    await expect(dialog.getByTestId('customer-document-type-cuit')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByLabel('Razón social').fill('Demo SRL')
    await dialog.getByLabel('Nombre completo').fill(quickWholesale)
    await dialog.getByLabel('Teléfono').fill(PHONE)
    await dialog.getByLabel('CUIT').fill('20-30123456-7')
    await dialog.getByRole('button', { name: 'Crear cliente' }).click()
    await expect(dialog).not.toBeVisible()

    const full = readCustomer(fullWholesale)
    const quick = readCustomer(quickWholesale)

    expect(full.document).toBe('CUIT 20301234567')
    expect(quick.document).toBe('CUIT 20301234567')
    for (const field of ['document', 'customer_type', 'business_name'] as const) {
      expect(quick[field], `divergencia en "${field}"`).toEqual(full[field])
    }
    expect(full.customer_type).toBe('mayorista')
    expect(full.business_name).toBe('Demo SRL')
  })

  test('la edición no puede dejar un mayorista sin razón social', async ({ page }) => {
    const name = `${MARK} Para Editar`
    ejecutarSQL(`INSERT INTO public.customers (business_id, name, phone, customer_type)
                 VALUES ('${E2E.business}', '${name}', '${PHONE}', 'minorista');`)

    await page.goto('/customers')
    // Se apunta a LA fila del cliente, no a `.first()`: el buscador tiene 300 ms
    // de debounce y `.first()` puede agarrar otra fila antes de que filtre.
    const listRow = page.getByRole('row').filter({ hasText: name })
    await expect(listRow).toBeVisible()
    await listRow.getByTitle('Editar cliente').click()
    await expect(page.getByText('Editar Cliente')).toBeVisible()
    await expect(page.getByTestId('customer-edit-name-input')).toHaveValue(name)

    await page.getByTestId('customer-edit-type-mayorista').click()
    // El gate que faltaba: sin razón social, no se guarda.
    await expect(page.getByTestId('customer-edit-save-button')).toBeDisabled()

    await page.getByTestId('customer-edit-business-name-input').fill('Editada SRL')
    await expect(page.getByTestId('customer-edit-save-button')).toBeEnabled()
    await page.getByTestId('customer-edit-save-button').click()

    await expect(page.getByText('Editar Cliente')).not.toBeVisible()
    const row = readCustomer(name)
    expect(row.customer_type).toBe('mayorista')
    expect(row.business_name).toBe('Editada SRL')
  })
})

// ── Sanidad responsive, de tema y de interacción ───────────────────────────
const VIEWPORTS = [320, 375, 390, 430, 768, 1024, 1440] as const
const THEMES = ['light', 'dark'] as const

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
}

async function expectReachable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  await expect(locator).toBeVisible()
  const reachable = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return hit === element || Boolean(hit && element.contains(hit))
  })
  expect(reachable).toBe(true)
}

async function expectTouchTargets(locator: Locator) {
  const boxes = await locator.evaluateAll((elements) => elements
    .filter((element) => (element as HTMLElement).getClientRects().length > 0)
    .map((element) => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }))
  expect(boxes.length).toBeGreaterThan(0)
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(43.5)
    expect(box.height).toBeGreaterThanOrEqual(43.5)
  }
}

test.describe('@customer-core CUSTOMER-CREATION-PARITY-1A · responsive y tema', () => {
  for (const theme of THEMES) {
    for (const width of VIEWPORTS) {
      test(`ambos shells son usables en ${width}px · ${theme}`, async ({ page }) => {
        const height = width <= 430 ? 844 : 900
        await page.addInitScript((value) => {
          localStorage.setItem('theme', value)
          localStorage.setItem('techrepair_theme', value)
        }, theme)
        await page.setViewportSize({ width, height })

        await page.goto('/customers/new')
        await expect(page.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'true')
        await expect(page.getByLabel('Nombre completo')).toBeVisible()
        await expect(page.getByLabel('Dirección')).toBeVisible()
        await expect(page.getByLabel('Notas')).toBeVisible()
        expect(await overflow(page)).toBeLessThanOrEqual(1)

        await page.getByLabel('Nombre completo').fill('QA responsive')
        await page.getByLabel('Teléfono').fill('3510000009')
        const fullCta = page.getByTestId('customer-save-button')
        await expect(fullCta).toBeEnabled()
        await expectReachable(fullCta)
        const fullActionPosition = await page.getByTestId('mobile-action-bar').evaluate((element) => getComputedStyle(element).position)
        expect(fullActionPosition).toBe(width < 1024 ? 'fixed' : 'static')
        await expectTouchTargets(page.locator('.customer-create-page .customer-create-fields input, .customer-create-page .customer-create-fields textarea, .customer-create-page .customer-create-fields button, .customer-create-page .page-hdr-right .btn, .customer-create-page [data-testid="customer-save-button"]'))

        await page.goto('/orders/new')
        const trigger = page.getByRole('button', { name: 'Crear cliente rápido' })
        await trigger.click()
        const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByTestId('customer-additional-toggle')).toHaveAttribute('aria-expanded', 'false')
        expect(await overflow(page)).toBeLessThanOrEqual(1)

        if (width <= 767) {
          await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(width - 1)
          await expect.poll(async () => (await dialog.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(height - 1)
        } else {
          const dialogBox = await dialog.boundingBox()
          expect(dialogBox).not.toBeNull()
          expect(dialogBox!.width).toBeLessThan(width)
        }

        await dialog.getByLabel('Nombre completo').fill('QA diálogo')
        await dialog.getByLabel('Teléfono').fill('3510000009')
        await dialog.getByTestId('customer-additional-toggle').click()
        await expect(dialog.getByLabel('Dirección')).toBeVisible()
        await expect(dialog.getByLabel('Notas')).toBeVisible()
        const quickCta = dialog.getByRole('button', { name: 'Crear cliente' })
        await expect(quickCta).toBeEnabled()
        await expectReachable(quickCta)
        await expectTouchTargets(dialog.locator('.customer-create-fields input, .customer-create-fields textarea, .customer-create-fields button, .modal-footer .btn'))
        expect(await overflow(page)).toBeLessThanOrEqual(1)

        await page.keyboard.press('Escape')
        await expect(dialog).not.toBeVisible()
        await expect(trigger).toBeFocused()
      })
    }
  }
})

test.describe('@customer-core CUSTOMER-CREATION-PARITY-1A · validación y teclado', () => {
  test.beforeEach(() => cleanup())
  test.afterAll(() => cleanup())

  test('el email vacío es válido y el inválido muestra el mismo error en ambos shells', async ({ page }) => {
    await page.goto('/customers/new')
    await page.getByLabel('Nombre completo').fill('Email Full')
    await page.getByLabel('Teléfono').fill(PHONE)
    await expect(page.getByTestId('customer-save-button')).toBeEnabled()
    await page.getByLabel('Email').fill('email-invalido')
    await expect(page.getByText('Ingresá un email válido.')).toBeVisible()
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('customer-save-button')).toBeDisabled()

    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    await dialog.getByLabel('Nombre completo').fill('Email Quick')
    await dialog.getByLabel('Teléfono').fill(PHONE)
    await expect(dialog.getByRole('button', { name: 'Crear cliente' })).toBeEnabled()
    await dialog.getByTestId('customer-additional-toggle').click()
    await dialog.getByLabel('Email').fill('email-invalido')
    await expect(dialog.getByText('Ingresá un email válido.')).toBeVisible()
    await expect(dialog.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByRole('button', { name: 'Crear cliente' })).toBeDisabled()
  })

  test('Enter envía ambos formularios una sola vez y conserva la selección del wizard', async ({ page }) => {
    const fullName = `${MARK} Enter Full`
    const quickName = `${MARK} Enter Rapido`

    await page.goto('/customers/new')
    await page.getByLabel('Nombre completo').fill(fullName)
    await page.getByLabel('Teléfono').fill(PHONE)
    await page.getByLabel('Teléfono').press('Enter')
    await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/)

    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    await dialog.getByLabel('Nombre completo').fill(quickName)
    await dialog.getByLabel('Teléfono').fill(PHONE)
    await dialog.getByLabel('Teléfono').press('Enter')
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(quickName) })).toBeVisible()

    for (const name of [fullName, quickName]) {
      const row = consultarJSON<{ count: number }>(`
        SELECT count(*)::int AS count
          FROM public.customers
         WHERE business_id = '${E2E.business}' AND name = '${name}'
      `)
      expect(row.count, name).toBe(1)
    }
  })
})

// ── UI-CONSISTENCY-2A · contraste real del selector DNI/CUIT ────────────────
// El gate anterior sólo probaba que el color existiera, y por eso dejó pasar
// un par medido en 1.44:1 en tema claro. Acá se calcula el ratio WCAG de
// verdad, en el navegador, con los tokens ya resueltos.
//
// El texto del chip es ~12.8 px bold: NO califica como "large text", así que
// el umbral es 4.5:1, no 3:1.
const AA_TEXTO_CHICO = 4.5

/** Ratio WCAG entre el color de un elemento y su fondo pintado real. */
async function contrastOf(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const parse = (value: string) => (value.match(/[\d.]+/g) || []).map(Number)
    const srgb = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    const lum = (rgb: number[]) => 0.2126 * srgb(rgb[0]) + 0.7152 * srgb(rgb[1]) + 0.0722 * srgb(rgb[2])

    const el = document.querySelector(id) as HTMLElement
    if (!el) throw new Error(`sin elemento ${id}`)

    // Fondo REAL: se componen las capas semitransparentes hacia arriba hasta
    // dar con una opaca. Un chip con fondo teñido sobre el contenedor no se
    // puede evaluar contra `transparent`.
    const layers: Array<{ rgb: number[]; a: number }> = []
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      const parts = parse(getComputedStyle(node).backgroundColor)
      if (parts.length < 3) continue
      const a = parts.length > 3 ? parts[3] : 1
      if (a === 0) continue
      layers.push({ rgb: parts.slice(0, 3), a })
      if (a === 1) break
    }
    let bg = layers.length && layers[layers.length - 1].a === 1
      ? layers[layers.length - 1].rgb
      : [255, 255, 255]
    for (let i = layers.length - 2; i >= 0; i--) {
      const { rgb, a } = layers[i]
      bg = rgb.map((c, k) => c * a + bg[k] * (1 - a))
    }

    const fg = parse(getComputedStyle(el).color).slice(0, 3)
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x)
    return (hi + 0.05) / (lo + 0.05)
  }, `[data-testid="${testId}"]`)
}

test.describe('@customer-core UI-CONSISTENCY-2A · contraste del selector DNI/CUIT', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`DNI/CUIT cumple AA en tema ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => {
        localStorage.setItem('theme', value)
        localStorage.setItem('techrepair_theme', value)
      }, theme)
      await page.goto('/customers/new')
      await expect(page.getByTestId('customer-document-type-dni')).toBeVisible()

      // DNI arranca seleccionado, CUIT no: se miden los dos estados.
      await expect(page.getByTestId('customer-document-type-dni')).toHaveAttribute('aria-pressed', 'true')
      const seleccionado = await contrastOf(page, 'customer-document-type-dni')
      const noSeleccionado = await contrastOf(page, 'customer-document-type-cuit')

      expect(seleccionado, `seleccionado en ${theme}`).toBeGreaterThanOrEqual(AA_TEXTO_CHICO)
      expect(noSeleccionado, `no seleccionado en ${theme}`).toBeGreaterThanOrEqual(AA_TEXTO_CHICO)

      // El par viejo daba exactamente 1.44:1 en claro y 2.56:1 el inactivo:
      // este margen deja fuera cualquier vuelta a esos valores.
      expect(seleccionado).toBeGreaterThan(2.6)
    })
  }

  test('el estado seleccionado no se distingue sólo por el color del texto', async ({ page }) => {
    await page.goto('/customers/new')
    await expect(page.getByTestId('customer-document-type-dni')).toBeVisible()
    const fondos = await page.evaluate(() => {
      const bg = (id: string) =>
        getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).backgroundColor
      return { sel: bg('customer-document-type-dni'), noSel: bg('customer-document-type-cuit') }
    })
    // Hay fondo propio en el seleccionado, no sólo un matiz de texto.
    expect(fondos.sel).not.toBe(fondos.noSel)
  })
})
