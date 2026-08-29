import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewOrder } from '../../src/pages/NewOrder'

const mocks=vi.hoisted(()=>({
  create:vi.fn(),upload:vi.fn(),customerCreate:vi.fn(),getAll:vi.fn(),loadProfiles:vi.fn(),
}))
vi.mock('../../src/hooks/usePermissions',()=>({usePermissions:()=>({can:()=>true}),effectivePermissions:()=>({orders_create:true})}))
vi.mock('../../src/services/api',()=>({customersService:{getAll:mocks.getAll,create:mocks.customerCreate}}))
vi.mock('../../src/features/order-intake/service',()=>({
  createOrderIntake:mocks.create,uploadIntakePhotos:mocks.upload,
  loadAssignableProfiles:mocks.loadProfiles,
}))

function renderWizard(){return render(<MemoryRouter><NewOrder/></MemoryRouter>)}
function action(name:string){const buttons=screen.getAllByRole('button',{name});return buttons[buttons.length-1]}
function chooseCustomer(){fireEvent.click(screen.getByRole('button',{name:/Cliente Uno/}));fireEvent.click(action('Continuar'))}

describe('MOBILE-2A · wizard',()=>{
  beforeEach(()=>{
    mocks.getAll.mockReset().mockResolvedValue([{id:'c1',name:'Cliente Uno',phone:'111',created_at:'',updated_at:''}])
    mocks.loadProfiles.mockReset().mockResolvedValue([{id:'p1',full_name:'Técnica E2E',role:'tech'}])
    mocks.create.mockReset().mockResolvedValue({order_id:'11111111-1111-4111-8111-111111111111',replayed:false});mocks.upload.mockReset().mockResolvedValue({uploaded:0,failed:[]});mocks.customerCreate.mockReset()
  })

  it('navega atrás sin perder marca/modelo',async()=>{
    renderWizard();await screen.findByText('Cliente Uno');chooseCustomer()
    fireEvent.change(screen.getByLabelText('Marca'),{target:{value:'Samsung'}})
    fireEvent.change(screen.getByLabelText('Modelo'),{target:{value:'S24'}})
    fireEvent.click(action('Continuar'))
    fireEvent.click(action('Anterior'))
    expect(screen.getByLabelText('Marca')).toHaveValue('Samsung')
    expect(screen.getByLabelText('Modelo')).toHaveValue('S24')
  })

  it('alta rápida muestra campos mayoristas y los limpia al volver a minorista',async()=>{
    renderWizard();await screen.findByText('Cliente Uno')
    fireEvent.click(screen.getByRole('button',{name:'Crear cliente rápido'}))
    fireEvent.click(screen.getByTestId('customer-type-mayorista'))
    const business=screen.getByLabelText('Razón social')
    fireEvent.change(business,{target:{value:'Comercio Demo'}})
    expect(business).toHaveValue('Comercio Demo')
    fireEvent.click(screen.getByTestId('customer-type-minorista'))
    expect(screen.queryByLabelText('Razón social')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('customer-type-mayorista'))
    expect(screen.getByLabelText('Razón social')).toHaveValue('')
  })

  it('una carga tardía de clientes no reemplaza al cliente recién creado',async()=>{
    let resolveCustomers!: (customers: Array<{id:string;name:string;phone:string;created_at:string;updated_at:string}>)=>void
    mocks.getAll.mockReturnValueOnce(new Promise(resolve=>{resolveCustomers=resolve}))
    mocks.customerCreate.mockResolvedValueOnce({id:'nuevo',name:'Cliente Nuevo',phone:'222',created_at:'',updated_at:''})
    renderWizard()

    fireEvent.click(screen.getByRole('button',{name:'Crear cliente rápido'}))
    fireEvent.change(screen.getByLabelText('Nombre completo'),{target:{value:'Cliente Nuevo'}})
    fireEvent.change(screen.getByLabelText('Teléfono'),{target:{value:'222'}})
    fireEvent.click(screen.getByRole('button',{name:'Crear cliente'}))

    expect(await screen.findByRole('button',{name:/Cliente Nuevo/})).toHaveClass('is-selected')

    await act(async()=>resolveCustomers([{id:'c1',name:'Cliente Uno',phone:'111',created_at:'',updated_at:''}]))

    await screen.findByRole('button',{name:/Cliente Uno/})
    expect(screen.getByRole('button',{name:/Cliente Nuevo/})).toHaveClass('is-selected')
  })

  it('limita fotos de ingreso a ocho, muestra previews y permite quitarlas',async()=>{
    Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn((file:File)=>`blob:${file.name}`)})
    Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()})
    const {container}=renderWizard();await screen.findByText('Cliente Uno');chooseCustomer()
    fireEvent.change(screen.getByLabelText('Marca'),{target:{value:'Samsung'}})
    fireEvent.change(screen.getByLabelText('Modelo'),{target:{value:'S24'}})
    fireEvent.click(action('Continuar'));fireEvent.click(action('Continuar'))
    const input=container.querySelector('input[type="file"]') as HTMLInputElement
    const files=Array.from({length:9},(_,index)=>new File(['img'],`foto-${index+1}.png`,{type:'image/png'}))
    fireEvent.change(input,{target:{files}})
    expect(screen.getAllByAltText(/Foto de recepción/)).toHaveLength(8)
    expect(screen.getByRole('alert')).toHaveTextContent(/hasta 8 imágenes/i)
    fireEvent.click(screen.getByRole('button',{name:'Quitar foto 1'}))
    expect(screen.getAllByAltText(/Foto de recepción/)).toHaveLength(7)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:foto-1.png')
  })

  it('enmascara el PIN en resumen y el doble click invoca una sola creación',async()=>{
    renderWizard();await screen.findByText('Cliente Uno');chooseCustomer()
    fireEvent.change(screen.getByLabelText('Marca'),{target:{value:'Samsung'}});fireEvent.change(screen.getByLabelText('Modelo'),{target:{value:'S24'}});fireEvent.click(action('Continuar'))
    fireEvent.click(action('Continuar'));fireEvent.click(action('Continuar'));fireEvent.click(action('Continuar'))
    fireEvent.click(screen.getByRole('button',{name:/PIN\s*C[oó]digo num[eé]rico/}));fireEvent.change(screen.getByLabelText('PIN'),{target:{value:'4826'}});fireEvent.click(action('Continuar'))
    fireEvent.change(screen.getByLabelText('Problema informado por el cliente'),{target:{value:'No carga'}});fireEvent.click(action('Continuar'))
    fireEvent.click(action('Continuar'));fireEvent.click(action('Continuar'))
    expect(screen.getByText('PIN configurado')).toBeInTheDocument();expect(screen.queryByText('4826')).not.toBeInTheDocument()
    const create=action('Crear orden');fireEvent.click(create);fireEvent.click(create)
    await waitFor(()=>expect(mocks.create).toHaveBeenCalledTimes(1))
    const rpcDraft=mocks.create.mock.calls[0][1]
    expect(rpcDraft.accessSecret).toBe('4826')
  })
})
