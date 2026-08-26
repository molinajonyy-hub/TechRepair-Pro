import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PatternGrid } from '../../src/features/order-intake/PatternGrid'
import { BarcodeScannerDialog } from '../../src/features/order-intake/BarcodeScannerDialog'

describe('MOBILE-2A · patrón accesible', () => {
  it('permite construir y limpiar el patrón sólo con teclado/click', () => {
    const onChange=vi.fn()
    const { rerender }=render(<PatternGrid value={[]} onChange={onChange}/>)
    fireEvent.click(screen.getByRole('button',{name:'Punto 1'}))
    expect(onChange).toHaveBeenCalledWith([1])
    rerender(<PatternGrid value={[1]} onChange={onChange}/>)
    fireEvent.click(screen.getByRole('button',{name:'Punto 5'}))
    expect(onChange).toHaveBeenLastCalledWith([1,5])
    fireEvent.click(screen.getByRole('button',{name:'Limpiar patrón'}))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})

describe('MOBILE-2A · scanner progresivo', () => {
  it('no pide cámara hasta la acción explícita y conserva fallback manual', async () => {
    const getUserMedia=vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}})
    Object.defineProperty(window,'BarcodeDetector',{configurable:true,value:class { detect(){return Promise.resolve([])} }})
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    expect(getUserMedia).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button',{name:/Permitir cámara/}))
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/ingresá el código manualmente/i)).toBeInTheDocument()
  })

  it('explica la falta de API sin pedir permisos ni bloquear el ingreso manual', async () => {
    const getUserMedia=vi.fn()
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}})
    Object.defineProperty(window,'BarcodeDetector',{configurable:true,value:undefined})
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByRole('button',{name:/Permitir cámara/}))
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/ingresar el código manualmente/i)
    expect(screen.getAllByRole('button',{name:'Cerrar'})).toHaveLength(2)
  })
})
