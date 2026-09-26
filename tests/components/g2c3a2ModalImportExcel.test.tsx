// ─────────────────────────────────────────────────────────────────────────────
// G2-C.3A2 — el modal de import define la INTENCIÓN del import (attemptId).
//
//   T16 reintentar después de un error reusa el mismo attemptId (y el botón
//       sigue habilitado: un error del import no es un error del archivo).
//   T17 cambiar de archivo → attemptId nuevo.
//   + el resumen muestra detalles y avisos (stale / archivo viejo).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../src/services/excelService', () => ({
  ExcelService: {
    importFromExcel: vi.fn(async () => ({ success: true, errors: [], data: [{ 'Código/SKU': 'A', 'Nombre del producto': 'A' }] })),
    normalizeData: (d: unknown[]) => d,
  },
}))

import { ModalImportExcel } from '../../src/components/ModalImportExcel'

function elegirArchivo(container: HTMLElement, nombre = 'inventario.xlsx') {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  const file = new File(['x'], nombre, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  fireEvent.change(input, { target: { files: [file] } })
}

describe('ModalImportExcel · intento de import', () => {
  it('T16 · retry tras error reusa el attemptId; T17 · archivo nuevo lo rota', async () => {
    const onImport = vi.fn()
      .mockRejectedValueOnce(new Error('TypeError: Failed to fetch'))
      .mockResolvedValueOnce({ created: 1, updated: 2, details: ['2 stocks actualizados'], warnings: ['1 stock omitido porque cambió desde la exportación: A (ahora 8, exportado 10)'] })
      .mockResolvedValueOnce({ created: 0, updated: 1 })

    const { container } = render(
      <ModalImportExcel isOpen onClose={() => {}} onImport={onImport} title="Importar Inventario" requiredColumns={['Código/SKU']} />,
    )
    elegirArchivo(container)
    const importar = await screen.findByRole('button', { name: 'Importar' })

    fireEvent.click(importar)
    await screen.findByText(/podés reintentar: lo ya aplicado no se duplica/)
    // El error del import NO deshabilita el retry.
    const retry = screen.getByRole('button', { name: 'Importar' })
    expect(retry).not.toBeDisabled()
    fireEvent.click(retry)

    await screen.findByText(/Importación exitosa/)
    expect(onImport).toHaveBeenCalledTimes(2)
    const a1 = onImport.mock.calls[0][1].attemptId
    const a2 = onImport.mock.calls[1][1].attemptId
    expect(a1).toBeTruthy()
    expect(a2).toBe(a1) // T16

    // Resumen con detalles y avisos.
    expect(screen.getByText(/2 stocks actualizados/)).toBeInTheDocument()
    expect(screen.getByText(/1 stock omitido porque cambió desde la exportación/)).toBeInTheDocument()

    // T17: otro archivo = otra intención.
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar' }))
    elegirArchivo(container, 'otro.xlsx')
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(3))
    expect(onImport.mock.calls[2][1].attemptId).not.toBe(a1)
  })

  it('compatibilidad: un onImport que ignora el contexto (Clientes) sigue funcionando', async () => {
    const onImport = vi.fn(async (_rows: unknown[]) => ({ created: 3, updated: 0 }))
    const { container } = render(
      <ModalImportExcel isOpen onClose={() => {}} onImport={onImport} title="Importar Clientes" requiredColumns={[]} />,
    )
    elegirArchivo(container, 'clientes.xlsx')
    fireEvent.click(await screen.findByRole('button', { name: 'Importar' }))
    await screen.findByText(/3 registros creados, 0 registros actualizados/)
  })
})
