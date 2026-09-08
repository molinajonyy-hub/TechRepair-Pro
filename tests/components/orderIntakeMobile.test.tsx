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

/**
 * ORDERS-V2-0.1 — este bloque cambió porque el test ANTERIOR fijaba el bug.
 *
 * Decía: «explica la falta de API sin pedir permisos», y aseveraba que sin
 * `window.BarcodeDetector` NO se llamara a `getUserMedia`. Eso es exactamente
 * la regresión que encontró el owner: la API no existe en WebKit ni en Chrome
 * para Windows, así que en esos navegadores la app se rendía sin siquiera
 * intentar abrir la cámara — que estaba disponible.
 *
 * El test verde daba la sensación de cobertura mientras protegía el defecto.
 * Ahora se aservera lo contrario: sin la API nativa, se pide la cámara igual y
 * se decodifica con el motor de respaldo.
 */
describe('ORDERS-V2-0.1 · scanner cross-browser', () => {
  const setEnv = (
    detector: unknown,
    getUserMedia: ReturnType<typeof vi.fn>,
    enumerateDevices?: ReturnType<typeof vi.fn>,
  ) => {
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,
      value: enumerateDevices ? { getUserMedia, enumerateDevices } : { getUserMedia }})
    Object.defineProperty(window,'isSecureContext',{configurable:true,value:true})
    if (detector === undefined) delete (globalThis as Record<string,unknown>).BarcodeDetector
    else (globalThis as Record<string,unknown>).BarcodeDetector = detector
  }

  /**
   * REGRESIÓN del pre-merge review, y la más importante de este archivo.
   *
   * La primera corrección cambió una compuerta dura por otra: llamaba
   * `enumerateDevices()` ANTES de `getUserMedia()` y abortaba con «este
   * dispositivo no tiene cámara» si no veía un `videoinput`. Pero
   * `enumerateDevices` depende del permiso y de las políticas de privacidad
   * del navegador: devuelve una lista vacía en situaciones donde la cámara
   * existe y funciona perfectamente.
   *
   * Este test fija que `getUserMedia` es la autoridad: si devuelve un stream,
   * el scanner ABRE, sin importar lo que haya dicho la enumeración.
   */
  it('enumerateDevices vacío pero getUserMedia OK → el scanner ABRE igual', async () => {
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    const enumerateDevices = vi.fn().mockResolvedValue([])   // «no veo cámaras»
    setEnv(undefined, getUserMedia, enumerateDevices)

    // jsdom no reproduce video; alcanza con que `play()` resuelva.
    Object.defineProperty(HTMLMediaElement.prototype,'play',
      {configurable:true,value:vi.fn().mockResolvedValue(undefined)})

    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByTestId('scanner-start'))

    expect(await screen.findByTestId('scanner-active')).toBeInTheDocument()
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('scanner-error')).not.toBeInTheDocument()
  })

  it('no consulta enumerateDevices antes de intentar abrir la cámara', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotAllowedError'}))
    const enumerateDevices = vi.fn().mockResolvedValue([])
    setEnv(undefined, getUserMedia, enumerateDevices)

    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByTestId('scanner-start'))
    await screen.findByTestId('scanner-error')

    // El orden importa: primero se intenta de verdad, y recién si el error es
    // genérico la enumeración puede afinar el mensaje. Con NotAllowedError la
    // causa ya se conoce y no hace falta consultarla.
    expect(getUserMedia).toHaveBeenCalled()
    expect(enumerateDevices).not.toHaveBeenCalled()
  })

  it('no pide cámara hasta la acción explícita', () => {
    const getUserMedia=vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotAllowedError'}))
    setEnv(class { detect(){return Promise.resolve([])} }, getUserMedia)
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('SIN BarcodeDetector pide la cámara igual — el navegador del owner', async () => {
    // Chrome 152 / Windows: hasBarcodeDetector=false, hasGetUserMedia=true.
    const getUserMedia=vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotAllowedError'}))
    setEnv(undefined, getUserMedia)
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByTestId('scanner-start'))
    // `start()` comprueba primero si hay cámara, así que `getUserMedia` cae en
    // un microtask posterior al click: hay que esperar al efecto, no al click.
    expect(await screen.findByTestId('scanner-error')).toHaveTextContent(/No diste permiso/i)
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('distingue permiso denegado de cámara inexistente', async () => {
    const denied=vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotAllowedError'}))
    setEnv(undefined, denied)
    const { unmount }=render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByTestId('scanner-start'))
    expect(await screen.findByTestId('scanner-error')).toHaveTextContent(/candado de la barra/i)
    unmount()

    const missing=vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotFoundError'}))
    setEnv(undefined, missing)
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    fireEvent.click(screen.getByTestId('scanner-start'))
    expect(await screen.findByTestId('scanner-error')).toHaveTextContent(/no tiene cámara/i)
  })

  it('fuera de HTTPS no manda a buscar un permiso que no existe', async () => {
    const getUserMedia=vi.fn()
    setEnv(undefined, getUserMedia)
    Object.defineProperty(window,'isSecureContext',{configurable:true,value:false})
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}}/>)
    expect(await screen.findByTestId('scanner-error')).toHaveTextContent(/conexión segura/i)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('el ingreso manual nunca deja de estar disponible', async () => {
    const getUserMedia=vi.fn().mockRejectedValue(Object.assign(new Error('x'),{name:'NotFoundError'}))
    setEnv(undefined, getUserMedia)
    render(<BarcodeScannerDialog open onClose={()=>{}} onDetected={()=>{}} target="imei"/>)
    fireEvent.click(screen.getByTestId('scanner-start'))
    await screen.findByTestId('scanner-error')
    // El mensaje de error y la ayuda al pie mandan los dos a escribirlo a mano.
    expect(screen.getByText(/escribir el IMEI a mano/i)).toBeInTheDocument()
    expect(screen.getAllByRole('button',{name:'Cerrar'}).length).toBeGreaterThanOrEqual(1)
  })
})
