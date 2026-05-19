/**
 * @purchase @finance
 * Compra pagada no duplica gasto — protege el bug "Phone Case" (BUG-03).
 * Una compra pagada a proveedor debe crear un solo egreso, no dos.
 *
 * POR QUÉ ESTÁ EN FIXME:
 *   El flujo de compras usa un modal complejo (ModalCrearComprobante o Expenses
 *   con tipo 'factura') que tampoco tiene data-testid en sus campos.
 *   Específicamente:
 *   - La sección de factura de proveedor en Expenses.tsx tiene inputs sin testid
 *   - El selector de proveedor no tiene testid
 *   - El grid de ítems de la factura no tiene testid
 *
 * QUÉ FALTA PARA ACTIVARLO:
 *   En Expenses.tsx (tipo 'factura') agregar:
 *   - data-testid="expense-supplier-select" en el selector de proveedor
 *   - data-testid="expense-invoice-number-input" en el número de factura
 *   - data-testid="expense-invoice-item-description-{n}" en la descripción del ítem
 *   - data-testid="expense-invoice-item-qty-{n}" en cantidad
 *   - data-testid="expense-invoice-item-cost-{n}" en costo
 *   - data-testid="expense-invoice-save-button" en el botón guardar
 *
 * INVARIANTE A PROTEGER:
 *   - Compra pagada → crea 1 egreso en financial_movements (no 2)
 *   - El egreso tiene reference_id = compra.id (no null)
 *   - No existe un gasto manual duplicado con el mismo monto/fecha
 *
 * Ver FASE BUGFIX BUG-03 en el historial para contexto del bug original.
 */
import { test } from '@playwright/test'

test.describe('@purchase @finance Compra pagada no duplica egreso', () => {
  test('crear compra pagada genera un solo egreso en finanzas', async ({ page: _page }) => {
    test.fixme(
      true,
      'Requiere data-testid en la sección de factura de proveedor de Expenses.tsx. ' +
      'Ver lista completa en el comentario del archivo.'
    )
  })
})
