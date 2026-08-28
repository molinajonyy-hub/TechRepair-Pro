import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Camera, Check, ChevronLeft, ChevronRight, ScanLine, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { customersService } from '../services/api'
import { DEFAULT_BRANDS, DEFAULT_MODELS_BY_BRAND } from '../services/deviceCatalogService'
import type { Customer } from '../lib/supabase'
import { AppButton, AppInput, AppSelect, AppTextarea, FormGrid, MobileActionBar, ResponsiveDialog } from '../ui'
import { effectivePermissions, usePermissions } from '../hooks/usePermissions'
import { BarcodeScannerDialog } from '../features/order-intake/BarcodeScannerDialog'
import { PatternGrid } from '../features/order-intake/PatternGrid'
import { INITIAL_INTAKE_DRAFT, isValidImei, normalizeImei, parseLocalizedAmount, type AccessMode, type CheckResult, type IntakeDraft } from '../features/order-intake/model'
import { createOrderIntake, loadAssignableProfiles, uploadIntakePhotos } from '../features/order-intake/service'
import { CustomerCreateFields, documentSearchTokens, firstCustomerCoreError, useCustomerCore } from '../features/customer-core'

const STEPS = ['Cliente','Equipo','Identificación','Estado y fotos','Checklist','Acceso','Problema','Asignación','Presupuesto','Resumen'] as const
const CHECKS = [['display','Pantalla'],['touch','Táctil'],['cameras','Cámaras'],['audio','Audio'],['charging','Carga'],['wifi','Wi‑Fi'],['buttons','Botones'],['biometrics','Biometría']] as const
const CHECK_OPTIONS: { value: CheckResult; label: string }[] = [
  { value:'ok',label:'OK' },{ value:'fail',label:'Falla' },{ value:'not_tested',label:'No probado' },{ value:'not_applicable',label:'No aplica' },
]
const ACCESS: { value: AccessMode; label: string; hint: string }[] = [
  {value:'none',label:'Sin bloqueo',hint:'El equipo no tiene bloqueo'},
  {value:'pin',label:'PIN',hint:'Código numérico'}, {value:'pattern',label:'Patrón',hint:'Secuencia 3 × 3'},
  {value:'password',label:'Contraseña',hint:'Clave alfanumérica'},
  {value:'not_provided',label:'No lo proporcionó',hint:'El cliente no dejó el acceso'},
  {value:'not_verifiable',label:'No se puede verificar',hint:'El equipo no permite comprobarlo'},
]
type PhotoDraft = { file: File; preview: string }
type ProfileOption = { id:string; full_name?:string|null; email?:string|null; role?:string|null; permissions?:unknown }

function StepCard({ children }: { children: React.ReactNode }) { return <section className="card intake-step-card"><div className="card-body">{children}</div></section> }
function ChoiceGrid({ children }: { children: React.ReactNode }) { return <div className="intake-choice-grid">{children}</div> }

export function NewOrder() {
  const navigate = useNavigate()
  const { can } = usePermissions()
  const [step,setStep] = useState(0)
  const [draft,setDraft] = useState<IntakeDraft>(INITIAL_INTAKE_DRAFT)
  const [customers,setCustomers] = useState<Customer[]>([])
  const [search,setSearch] = useState('')
  const [profiles,setProfiles] = useState<ProfileOption[]>([])
  const [photos,setPhotos] = useState<PhotoDraft[]>([])
  const [quickOpen,setQuickOpen] = useState(false)
  const [scanner,setScanner] = useState<'serial'|'imei'|null>(null)
  const [error,setError] = useState('')
  const [submitting,setSubmitting] = useState(false)
  const [createdOrderId,setCreatedOrderId] = useState('')
  const [dirty,setDirty] = useState(false)
  const requestIdRef = useRef(crypto.randomUUID())
  const submitLock = useRef(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const photosRef = useRef<PhotoDraft[]>([])

  const update = (patch: Partial<IntakeDraft>) => { setDraft(previous => ({...previous,...patch})); setDirty(true); setError('') }
  const updateDevice = (patch: Partial<IntakeDraft['device']>) => update({device:{...draft.device,...patch}})

  useEffect(() => { Promise.all([customersService.getAll(),loadAssignableProfiles()]).then(([c,p])=>{
    setCustomers(c)
    setProfiles(p.filter(profile=>effectivePermissions(profile.role,profile.role==='owner',profile.permissions).orders_create))
  }).catch(e=>setError(e.message)) },[])
  useEffect(() => { headingRef.current?.focus() },[step])
  useEffect(() => {
    const handler=(event:BeforeUnloadEvent)=>{if(dirty&&!submitting){event.preventDefault();event.returnValue=''}}
    window.addEventListener('beforeunload',handler); return()=>window.removeEventListener('beforeunload',handler)
  },[dirty,submitting])
  useEffect(()=>{photosRef.current=photos},[photos])
  useEffect(() => () => { photosRef.current.forEach(photo=>URL.revokeObjectURL(photo.preview)) },[])

  const selectedCustomer=customers.find(customer=>customer.id===draft.customerId)
  const filteredCustomers=useMemo(()=>{
    const q=search.trim().toLowerCase(); if(!q)return customers.slice(0,20)
    // El documento se busca contra TODAS sus representaciones. En la tabla
    // conviven filas canónicas (`DNI 30123456`) con históricas (`DNI: 30.123.456`)
    // y este lote no las migra, así que la búsqueda tiene que encontrar ambas
    // se tipee con separadores o sin ellos.
    const qDoc=q.replace(/[^a-z0-9]/g,'')
    return customers.filter(customer=>
      [customer.name,customer.phone,customer.business_name].some(value=>value?.toLowerCase().includes(q))
      ||(qDoc!==''&&documentSearchTokens(customer.document).some(token=>token.toLowerCase().replace(/[^a-z0-9]/g,'').includes(qDoc)))
    ).slice(0,20)
  },[customers,search])
  const models=DEFAULT_MODELS_BY_BRAND[Object.keys(DEFAULT_MODELS_BY_BRAND).find(key=>key.toLowerCase()===draft.device.brand.toLowerCase())||'']||[]

  const stepError = () => {
    if(step===0&&!draft.customerId)return 'Seleccioná o creá un cliente.'
    if(step===1&&(!draft.device.brand.trim()||!draft.device.model.trim()))return 'Completá marca y modelo.'
    if(step===2&&draft.device.imei&&!isValidImei(draft.device.imei))return 'El IMEI debe tener 15 dígitos y un dígito verificador válido.'
    if(step===5&&draft.accessMode==='pin'&&!/^\d{4,12}$/.test(draft.accessSecret))return 'El PIN debe tener entre 4 y 12 dígitos.'
    if(step===5&&draft.accessMode==='password'&&!draft.accessSecret.trim())return 'Ingresá la contraseña.'
    if(step===5&&draft.accessMode==='pattern'&&draft.pattern.length<2)return 'Marcá al menos 2 puntos del patrón.'
    if(step===6&&!draft.problem.trim())return 'Describí el problema informado.'
    if(step===8&&draft.budgetAmount&&parseLocalizedAmount(draft.budgetAmount)===null)return 'Ingresá un presupuesto válido.'
    return ''
  }
  const next=()=>{const message=stepError();if(message){setError(message);return}setStep(value=>Math.min(STEPS.length-1,value+1))}
  const back=()=>setStep(value=>Math.max(0,value-1))
  const cancel=()=>{if(!dirty||window.confirm('¿Salir? Los datos cargados no se guardarán.'))navigate('/orders')}

  const addPhotos=(files:FileList|null)=>{
    if(!files)return
    const accepted=Array.from(files).filter(file=>file.type.startsWith('image/')&&file.size<=10*1024*1024)
    const slots=Math.max(0,8-photos.length)
    if(accepted.length!==files.length||accepted.length>slots)setError('Se admiten hasta 8 imágenes de 10 MB cada una.')
    setPhotos(previous=>[...previous,...accepted.slice(0,slots).map(file=>({file,preview:URL.createObjectURL(file)}))]);setDirty(true)
    if(fileRef.current)fileRef.current.value=''
  }
  const removePhoto=(index:number)=>setPhotos(previous=>{URL.revokeObjectURL(previous[index].preview);return previous.filter((_,i)=>i!==index)})

  const submit=async()=>{
    if(submitLock.current)return
    submitLock.current=true;setSubmitting(true);setError('')
    let orderId=createdOrderId
    try{
      if(!orderId){const created=await createOrderIntake(requestIdRef.current,draft);orderId=created.order_id;setCreatedOrderId(orderId)}
      const upload=await uploadIntakePhotos(orderId,photos.map(photo=>photo.file))
      setDraft(previous=>({...previous,accessSecret:'',pattern:[]}));setDirty(false)
      if(upload.failed.length){
        setPhotos(previous=>previous.filter(photo=>upload.failed.includes(photo.file.name)))
        setError(`La orden fue creada. No se pudieron subir ${upload.failed.length} foto(s). Tocá “Reintentar fotos” para completar la evidencia.`)
        submitLock.current=false;return
      }
      navigate(`/orders/${orderId}`,{replace:true,state:{intakeCreated:true}})
    }catch(cause){setError(cause instanceof Error?cause.message:'No se pudo crear la orden.');if(!orderId)submitLock.current=false}
    finally{setSubmitting(false)}
  }

  if(!can('orders_create'))return <div className="card"><div className="card-body"><h1>Nueva orden</h1><p>No tenés permiso para registrar recepciones.</p><AppButton onClick={()=>navigate('/orders')}>Volver</AppButton></div></div>

  return <>
    <div className="animate-fade-in intake-page">
    <header className="intake-header">
      <button type="button" className="btn btn-ghost" onClick={cancel} aria-label="Salir de nueva orden"><ArrowLeft size={20}/></button>
      <div><p className="intake-eyebrow">Nueva orden · Paso {step+1} de {STEPS.length}</p><h1 ref={headingRef} tabIndex={-1}>{STEPS[step]}</h1></div>
    </header>
    <div className="intake-progress" role="progressbar" aria-label="Progreso de la recepción" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step+1}><span style={{width:`${((step+1)/STEPS.length)*100}%`}}/></div>
    {error&&<div className="alert-inline alert-error" role="alert">{error}</div>}

    {step===0&&<StepCard><AppInput semantic="search" label="Buscar cliente" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Nombre, teléfono, DNI/CUIT o empresa"/>
      <div className="intake-customer-list">{filteredCustomers.map(customer=><button type="button" key={customer.id} className={draft.customerId===customer.id?'is-selected':''} onClick={()=>update({customerId:customer.id})}><span>{customer.business_name||customer.name}</span><small>{customer.name} · {customer.phone}</small>{draft.customerId===customer.id&&<Check size={18}/>}</button>)}</div>
      {!filteredCustomers.length&&<p className="form-hint">No encontramos coincidencias.</p>}
      <AppButton variant="secondary" fullWidth leftIcon={<UserPlus size={18}/>} onClick={()=>setQuickOpen(true)}>Crear cliente rápido</AppButton>
    </StepCard>}

    {step===1&&<StepCard><AppSelect label="Tipo de equipo" value={draft.device.type} onChange={e=>updateDevice({type:e.target.value as IntakeDraft['device']['type']})} options={[{value:'smartphone',label:'Teléfono'},{value:'tablet',label:'Tablet'},{value:'laptop',label:'Notebook'},{value:'smartwatch',label:'Smartwatch'},{value:'other',label:'Otro'}]}/>
      <FormGrid><div><AppInput label="Marca" required value={draft.device.brand} onChange={e=>updateDevice({brand:e.target.value,model:''})} list="intake-brands"/><datalist id="intake-brands">{DEFAULT_BRANDS.map(item=><option key={item} value={item}/>)}</datalist></div><div><AppInput label="Modelo" required value={draft.device.model} onChange={e=>updateDevice({model:e.target.value})} list="intake-models"/><datalist id="intake-models">{models.map(item=><option key={item} value={item}/>)}</datalist></div></FormGrid>
    </StepCard>}

    {step===2&&<StepCard><div className="intake-field-action"><AppInput label="Número de serie" value={draft.device.serial} onChange={e=>updateDevice({serial:e.target.value})} autoCapitalize="characters"/><AppButton variant="secondary" leftIcon={<ScanLine size={17}/>} onClick={()=>setScanner('serial')}>Escanear</AppButton></div>
      <div className="intake-field-action"><AppInput semantic="numeric" label="IMEI (opcional)" value={draft.device.imei} error={draft.device.imei&&!isValidImei(draft.device.imei)?'Debe ser un IMEI válido de 15 dígitos.':''} onChange={e=>updateDevice({imei:normalizeImei(e.target.value)})} maxLength={15}/><AppButton variant="secondary" leftIcon={<ScanLine size={17}/>} onClick={()=>setScanner('imei')}>Escanear</AppButton></div>
    </StepCard>}

    {step===3&&<StepCard><AppSelect label="Estado general" value={draft.condition.general} onChange={e=>update({condition:{...draft.condition,general:e.target.value}})} options={['Excelente','Bueno','Regular','Dañado'].map(value=>({value,label:value}))}/>
      <AppSelect label="¿Enciende?" value={draft.condition.powersOn} onChange={e=>update({condition:{...draft.condition,powersOn:e.target.value as IntakeDraft['condition']['powersOn']}})} options={[{value:'yes',label:'Sí'},{value:'no',label:'No'},{value:'not_verified',label:'No verificado'}]}/>
      <fieldset><legend>Condiciones visibles</legend><ChoiceGrid>{['Pantalla rota','Rayones','Golpes','Humedad','Tapa dañada','Faltantes'].map(item=><label key={item} className="intake-check"><input type="checkbox" checked={draft.condition.physical.includes(item)} onChange={e=>update({condition:{...draft.condition,physical:e.target.checked?[...draft.condition.physical,item]:draft.condition.physical.filter(value=>value!==item)}})}/>{item}</label>)}</ChoiceGrid></fieldset>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e=>addPhotos(e.target.files)}/><AppButton variant="secondary" leftIcon={<Camera size={18}/>} onClick={()=>fileRef.current?.click()} disabled={photos.length>=8}>Agregar fotos ({photos.length}/8)</AppButton>
      <div className="intake-photo-grid">{photos.map((photo,index)=><div key={photo.preview}><img src={photo.preview} alt={`Foto de recepción ${index+1}`}/><button type="button" onClick={()=>removePhoto(index)} aria-label={`Quitar foto ${index+1}`}><Trash2 size={16}/></button></div>)}</div>
    </StepCard>}

    {step===4&&<StepCard><p className="form-hint">Marcá qué se verificó al recibir el equipo. “No probado” evita asumir que algo funciona.</p>{CHECKS.map(([key,label])=><AppSelect key={key} label={label} value={draft.checklist[key]||'not_tested'} onChange={e=>update({checklist:{...draft.checklist,[key]:e.target.value as CheckResult}})} options={CHECK_OPTIONS}/>)}</StepCard>}

    {step===5&&<StepCard><div className="intake-security-note"><ShieldCheck size={20}/><span>El acceso se cifra en Vault. No aparece en el resumen ni se guarda en el navegador.</span></div><ChoiceGrid>{ACCESS.map(option=><button type="button" key={option.value} className={`intake-choice ${draft.accessMode===option.value?'is-selected':''}`} onClick={()=>update({accessMode:option.value,accessSecret:'',pattern:[]})}><strong>{option.label}</strong><small>{option.hint}</small></button>)}</ChoiceGrid>
      {draft.accessMode==='pin' && (
        <AppInput semantic="password" inputMode="numeric" autoComplete="new-password" label="PIN" value={draft.accessSecret} onChange={e=>update({accessSecret:e.target.value.replace(/\D/g,'').slice(0,12)})}/>
      )}
      {draft.accessMode==='password' && (
        <AppInput semantic="password" autoComplete="new-password" label="Contraseña" value={draft.accessSecret} onChange={e=>update({accessSecret:e.target.value.slice(0,256)})}/>
      )}
      {draft.accessMode==='pattern'&&<PatternGrid value={draft.pattern} onChange={pattern=>update({pattern})}/>}</StepCard>}

    {step===6&&<StepCard><AppTextarea label="Problema informado por el cliente" required value={draft.problem} onChange={e=>update({problem:e.target.value})} minRows={4}/><AppTextarea label="Observaciones de recepción" value={draft.observations} onChange={e=>update({observations:e.target.value})} hint="Estado, accesorios o aclaraciones que no forman parte del problema."/></StepCard>}

    {step===7&&<StepCard><AppSelect label="Técnico / responsable" value={draft.assignedProfileId} onChange={e=>update({assignedProfileId:e.target.value})} placeholder="Sin asignar" options={profiles.map(profile=>({value:profile.id,label:profile.full_name||profile.email||'Integrante'}))}/><AppSelect label="Prioridad" value={draft.priority} onChange={e=>update({priority:e.target.value as IntakeDraft['priority']})} options={[{value:'medium',label:'Normal'},{value:'high',label:'Importante'},{value:'urgent',label:'Urgente'}]}/></StepCard>}

    {step===8&&<StepCard><p className="form-hint">El presupuesto es opcional y no registra pagos ni movimientos financieros.</p><FormGrid><AppInput semantic="decimal" label="Presupuesto estimado" value={draft.budgetAmount} onChange={e=>update({budgetAmount:e.target.value})} placeholder="Ej. 100.000,50"/><AppSelect label="Moneda" value={draft.budgetCurrency} onChange={e=>update({budgetCurrency:e.target.value as 'ARS'|'USD'})} options={[{value:'ARS',label:'ARS — Pesos'},{value:'USD',label:'USD — Dólares'}]}/></FormGrid></StepCard>}

    {step===9&&<StepCard><div className="intake-summary">
      <Summary title="Cliente" onEdit={()=>setStep(0)}>{selectedCustomer?.business_name||selectedCustomer?.name}</Summary>
      <Summary title="Equipo" onEdit={()=>setStep(1)}>{draft.device.brand} {draft.device.model} · {draft.device.type}</Summary>
      <Summary title="Identificación" onEdit={()=>setStep(2)}>Serie: {draft.device.serial||'No informada'} · IMEI: {draft.device.imei||'No informado'}</Summary>
      <Summary title="Estado y fotos" onEdit={()=>setStep(3)}>{draft.condition.general} · {photos.length} foto(s)</Summary>
      <Summary title="Checklist" onEdit={()=>setStep(4)}>{Object.values(draft.checklist).filter(value=>value==='fail').length} falla(s) marcada(s)</Summary>
      <Summary title="Acceso" onEdit={()=>setStep(5)}>{['pin','pattern','password'].includes(draft.accessMode)?`${ACCESS.find(a=>a.value===draft.accessMode)?.label} configurado`:ACCESS.find(a=>a.value===draft.accessMode)?.label}</Summary>
      <Summary title="Problema" onEdit={()=>setStep(6)}>{draft.problem}</Summary>
      <Summary title="Asignación" onEdit={()=>setStep(7)}>{profiles.find(profile=>profile.id===draft.assignedProfileId)?.full_name||'Sin asignar'} · {draft.priority==='medium'?'Normal':draft.priority==='high'?'Importante':'Urgente'}</Summary>
      <Summary title="Presupuesto" onEdit={()=>setStep(8)}>{draft.budgetAmount?`${draft.budgetCurrency} ${draft.budgetAmount}`:'Sin presupuesto'}</Summary>
    </div></StepCard>}

    <div className="intake-desktop-actions"><AppButton variant="secondary" onClick={step===0?cancel:back} leftIcon={<ChevronLeft size={18}/>}>{step===0?'Cancelar':'Anterior'}</AppButton>{step<9?<AppButton variant="primary" onClick={next} rightIcon={<ChevronRight size={18}/>}>Continuar</AppButton>:<AppButton variant="primary" loading={submitting} onClick={submit}>{createdOrderId?'Reintentar fotos':'Crear orden'}</AppButton>}</div>
    </div>
    <MobileActionBar secondaryAction={<AppButton variant="secondary" fullWidth onClick={step===0?cancel:back}>{step===0?'Cancelar':'Anterior'}</AppButton>} primaryAction={step<9?<AppButton variant="primary" fullWidth onClick={next}>Continuar</AppButton>:<AppButton variant="primary" fullWidth loading={submitting} onClick={submit}>{createdOrderId?'Reintentar fotos':'Crear orden'}</AppButton>}/>
    <QuickCustomerDialog open={quickOpen} onClose={()=>setQuickOpen(false)} onCreated={customer=>{setCustomers(previous=>[customer,...previous]);update({customerId:customer.id});setQuickOpen(false)}}/>
    <BarcodeScannerDialog open={scanner!==null} onClose={()=>setScanner(null)} onDetected={value=>scanner&&updateDevice({[scanner]:scanner==='imei'?normalizeImei(value):value} as Partial<IntakeDraft['device']>)}/>
  </>
}

function Summary({title,onEdit,children}:{title:string;onEdit:()=>void;children:React.ReactNode}){return <section><div><h2>{title}</h2><button type="button" onClick={onEdit}>Editar</button></div><p>{children||'—'}</p></section>}

const QUICK_CUSTOMER_FORM_ID = 'quick-customer-form'

/** Alta rápida: shell de diálogo sobre el cuerpo canónico de creación. */
function QuickCustomerDialog({open,onClose,onCreated}:{open:boolean;onClose:()=>void;onCreated:(customer:Customer)=>void}){
  const {values,errors,setField,setCustomerType,toCreatePayload}=useCustomerCore()
  const [saving,setSaving]=useState(false);const [error,setError]=useState('')
  const submitLock=useRef(false)
  const invalid=Object.keys(errors).length>0
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault()
    if(submitLock.current||firstCustomerCoreError(errors))return
    submitLock.current=true
    setSaving(true);setError('')
    try{const customer=await customersService.create(toCreatePayload());onCreated(customer)}
    catch(cause){setError(cause instanceof Error?cause.message:'No se pudo crear el cliente.')}
    finally{setSaving(false);submitLock.current=false}
  }
  return <ResponsiveDialog isOpen={open} onClose={onClose} title="Crear cliente rápido" subtitle="Queda disponible para esta orden y futuras recepciones." size="lg" mobilePresentation="fullscreen" footer={<div className="customer-create-dialog-actions"><AppButton variant="secondary" onClick={onClose}>Cancelar</AppButton><AppButton type="submit" form={QUICK_CUSTOMER_FORM_ID} variant="primary" loading={saving} disabled={invalid} data-testid="quick-customer-save-button">Crear cliente</AppButton></div>}>
    <form id={QUICK_CUSTOMER_FORM_ID} className="customer-create-form customer-create-form--quick" onSubmit={save} noValidate>
      {error&&<p className="form-error customer-create-server-error" role="alert">{error}</p>}
      <CustomerCreateFields values={values} errors={errors} setField={setField} setCustomerType={setCustomerType} additionalInitiallyOpen={false}/>
    </form>
  </ResponsiveDialog>
}
