// ─────────────────────────────────────────────────────────────────────────────
// Diálogos · el foco no se pierde al re-renderizar.
//
// `ResponsiveDialog` re-ejecutaba su efecto de foco cada vez que cambiaba la
// identidad de `onClose`, y casi todos los padres lo pasan inline. Resultado
// medido en 3d4d142 (y desde 600d766): en Editar cliente sólo entraba el primer
// carácter y el resto caía sobre «Cerrar»; en el alta rápida de Nueva Orden un
// espacio activaba «Cerrar» y el diálogo se cerraba con lo tipeado.
//
// `fill()` no lo detecta: escribe el valor de una vez. Acá se tipea tecla a
// tecla, como una persona.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`@dialog-focus alta rápida: tipear tecla a tecla no pierde el foco · ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 })
    await page.goto('/orders/new')
    await page.getByRole('button', { name: 'Crear cliente rápido' }).click()
    const dialog = page.getByRole('dialog', { name: 'Crear cliente rápido' })
    const name = dialog.getByLabel('Nombre completo')
    await expect(name).toBeVisible()

    await name.click()
    await page.keyboard.type('Juan Perez', { delay: 40 })
    await expect(dialog).toBeVisible()
    await expect(name).toHaveValue('Juan Perez')
    await expect(name).toBeFocused()

    await dialog.getByLabel('Teléfono').click()
    await page.keyboard.type('351 555 0000', { delay: 40 })
    await expect(dialog.getByLabel('Teléfono')).toHaveValue('351 555 0000')
    await expect(dialog.getByLabel('Teléfono')).toBeFocused()

    // Escape cierra y devuelve el foco al disparador.
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Crear cliente rápido' })).toBeFocused()
  })
}

test('@dialog-focus editar cliente: tipear tecla a tecla no pierde caracteres', async ({ page }) => {
  await page.goto('/customers')
  await page.getByRole('row').filter({ hasText: 'Cliente E2E' }).first().getByTitle('Editar cliente').click()
  const dialog = page.getByRole('dialog', { name: 'Editar Cliente' })
  const notes = dialog.getByLabel('Notas')
  await expect(notes).toBeVisible()

  await notes.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type('Prefiere retirar a la tarde', { delay: 30 })
  await expect(notes).toHaveValue('Prefiere retirar a la tarde')
  await expect(notes).toBeFocused()
  await expect(dialog).toBeVisible()

  // Sin guardar: el cliente sembrado no se toca.
  await dialog.getByRole('button', { name: 'Cancelar' }).click()
  await expect(dialog).not.toBeVisible()
})
