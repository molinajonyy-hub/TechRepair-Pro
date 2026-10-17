import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Camera, ChevronLeft, ChevronRight, Info, ScanLine, ShieldCheck, Trash2 } from 'lucide-react'
import { customersService } from '../services/api'
import { ensureBrandAndModel } from '../services/deviceCatalogService'
import type { Customer } from '../lib/supabase'
import { AppButton, AppCombobox, AppInput, AppMoneyInput, AppSelect, AppStepper, AppTextarea, FormGrid, MobileActionBar, ResponsiveDialog } from '../ui'
import { formatMoney } from '../lib/money'
import { useAuth } from '../contexts/AuthContext'
import { effectivePermissions, usePermissions } from '../hooks/usePermissions'
import { BarcodeScannerDialog } from '../features/order-intake/BarcodeScannerDialog'
import { ChecklistField } from '../features/order-intake/ChecklistField'
import { PatternGrid } from '../features/order-intake/PatternGrid'
import { useDeviceCatalog } from '../features/order-intake/useDeviceCatalog'
import {
  INITIAL_INTAKE_DRAFT, PIN_MAX_DIGITS, accessNotice, effectiveAccessMode, intakeErrorMessage, isValidImei,
  normalizeImei, parseLocalizedAmount, type AccessMode, type CheckResult, type IntakeDraft,
} from '../features/order-intake/model'
import { createOrderIntake, loadAssignableProfiles, uploadIntakePhotos } from '../features/order-intake/service'
import { CustomerCreateFields, CustomerPicker, useCustomerCore, type CustomerPickerOption } from '../features/customer-core'
import { RECIPIENT_ROLE_LABEL, loadCustomerNoticeContact, setOrderNotificationRecipient, type NotificationRecipientKind } from '../features/order-notify'

/**
 * BETA-UX-2 — la recepción pasó de 10 pasos a 4.
 *
 * Antes: Cliente · Equipo · Identificación · Estado y fotos · Checklist ·
 * Acceso · Problema · Asignación · Presupuesto · Resumen. Una recepción mínima
 * eran nueve «Continuar», siete de ellos sobre pasos opcionales.
 *
 * Ahora cada paso agrupa lo que se carga en el mismo momento del mostrador:
 *   1. Cliente   — quién trae el equipo.
 *   2. Equipo    — qué es (tipo, marca, modelo, serie/IMEI) y cómo se desbloquea.
 *   3. Ingreso   — qué le pasa y en qué estado llega (fotos; checklist plegado).
 *   4. Confirmar — técnico, prioridad y presupuesto opcionales + resumen.
 *
 * Lo obligatorio (cliente, marca/modelo, problema) quedó al principio de cada
 * paso; lo opcional, después o plegado. No se quitó ningún dato: el payload de
 * `create_order_intake` es el mismo. El acceso (PIN, patrón, contraseña) nunca
 * frena la orden: ver `accessNotice` / `effectiveAccessMode` en model.ts.
 */
const STEPS = [
  { label: 'Cliente', title: 'Cliente' },
  { label: 'Equipo', title: 'Equipo y acceso' },
  { label: 'Ingreso', title: 'Problema y estado' },
  { label: 'Confirmar', title: 'Confirmar recepción' },
] as const
const LAST_STEP = STEPS.length - 1
const STEP_LABELS = STEPS.map(step => step.label)

const CHECKS = [['display','Pantalla'],['touch','Táctil'],['cameras','Cámaras'],['audio','Audio'],['charging','Carga'],['wifi','Wi‑Fi'],['buttons','Botones'],['biometrics','Biometría']] as const
const ACCESS: { value: AccessMode; label: string; hint: string }[] = [
  {value:'none',label:'Sin bloqueo',hint:'El equipo no tiene bloqueo'},
  {value:'pin',label:'PIN',hint:'Código numérico'}, {value:'pattern',label:'Patrón',hint:'Secuencia 3 × 3'},
  {value:'password',label:'Contraseña',hint:'Clave alfanumérica'},
  {value:'not_provided',label:'No lo proporcionó',hint:'El cliente no dejó el acceso'},
  {value:'not_verifiable',label:'No se puede verificar',hint:'El equipo no permite comprobarlo'},
]
const DEVICE_TYPES: { value: IntakeDraft['device']['type']; label: string }[] = [
  {value:'smartphone',label:'Teléfono'},{value:'tablet',label:'Tablet'},{value:'laptop',label:'Notebook'},
  {value:'smartwatch',label:'Smartwatch'},{value:'other',label:'Otro'},
]
const POWERS_ON_LABEL: Record<IntakeDraft['condition']['powersOn'], string> = { yes:'Enciende', no:'No enciende', not_verified:'Encendido no verificado' }

type PhotoDraft = { file: File; preview: string }
type ProfileOption = { id:string; full_name?:string|null; email?:string|null; role?:string|null; permissions?:unknown }
/** Campo que se enfoca cuando un paso no puede avanzar. */
type FieldKey = 'brand' | 'model' | 'imei' | 'problem' | 'budget'
const FIELD_TESTID: Record<FieldKey, string> = { brand:'intake-brand', model:'intake-model', imei:'intake-imei', problem:'intake-problem', budget:'intake-budget' }

function StepCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return <section className="card intake-step-card" aria-label={title}>
    <div className="card-body">{title && <h2 className="intake-section-title">{title}</h2>}{children}</div>
  </section>
}
function ChoiceGrid({ children }: { children: React.ReactNode }) { return <div className="intake-choice-grid">{children}</div> }

export function NewOrder() {
  const navigate = useNavigate()
  const { can } = usePermissions()
  const { businessId } = useAuth()
  const [step,setStep] = useState(0)
  const [draft,setDraft] = useState<IntakeDraft>(INITIAL_INTAKE_DRAFT)
  /**
   * ORDERS-V2-0 — la lista completa de clientes ya no vive en el browser.
   * Sólo se conserva el cliente ELEGIDO (para el resumen) y los creados en
   * esta sesión, que se anteponen a los resultados del servidor.
   */
  const [selectedCustomer,setSelectedCustomer] = useState<CustomerPickerOption|null>(null)
  const [createdCustomers,setCreatedCustomers] = useState<CustomerPickerOption[]>([])
  /**
   * CLIENTES-UX-1B — a quién se avisa en esta orden. Por defecto el teléfono
   * principal; el contacto alternativo sólo se ofrece si el cliente lo tiene.
   * No va en el payload de `create_order_intake`: se guarda después con
   * `set_order_notification_recipient`, que copia el contacto en la orden.
   */
  const [noticeContact,setNoticeContact] = useState<{name:string;phone:string}|null>(null)
  const [notifyRecipient,setNotifyRecipient] = useState<NotificationRecipientKind>('customer')
  const noticeRequestRef = useRef('')
  const recipientWarningRef = useRef('')
  const [profiles,setProfiles] = useState<ProfileOption[]>([])
  const [photos,setPhotos] = useState<PhotoDraft[]>([])
  const [quickOpen,setQuickOpen] = useState(false)
  const [scanner,setScanner] = useState<'serial'|'imei'|null>(null)
  const [checklistOpen,setChecklistOpen] = useState(false)
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
  /** Elegir otro cliente vuelve a avisar al titular hasta saber si tiene contacto alternativo. */
  const chooseCustomer = (customer: CustomerPickerOption, knownNotice?: {name:string;phone:string}|null) => {
    setSelectedCustomer(customer);update({customerId:customer.id})
    setNotifyRecipient('customer');noticeRequestRef.current=customer.id
    if(knownNotice!==undefined){setNoticeContact(knownNotice);return}
    setNoticeContact(null)
    if(!businessId)return
    void loadCustomerNoticeContact(customer.id,businessId).then(contact=>{if(noticeRequestRef.current===customer.id)setNoticeContact(contact)})
  }
  const updateDevice = (patch: Partial<IntakeDraft['device']>) => update({device:{...draft.device,...patch}})

  useEffect(() => { loadAssignableProfiles()
    .then(p=>setProfiles(p.filter(profile=>effectivePermissions(profile.role,profile.role==='owner',profile.permissions).orders_create)))
    .catch(e=>setError(e.message)) },[])
  useEffect(() => { headingRef.current?.focus() },[step])
  useEffect(() => {
    const handler=(event:BeforeUnloadEvent)=>{if(dirty&&!submitting){event.preventDefault();event.returnValue=''}}
    window.addEventListener('beforeunload',handler); return()=>window.removeEventListener('beforeunload',handler)
  },[dirty,submitting])
  useEffect(()=>{photosRef.current=photos},[photos])
  useEffect(() => () => { photosRef.current.forEach(photo=>URL.revokeObjectURL(photo.preview)) },[])

  const {brands,models,brandsLoading,modelsLoading}=useDeviceCatalog(draft.device.brand)

  const imeiInvalid = Boolean(draft.device.imei) && !isValidImei(draft.device.imei)
  const notice = accessNotice(draft)

  /** Lo que impide avanzar en un paso. El acceso NUNCA está acá. */
  const stepIssue = (index: number): { message: string; field?: FieldKey } | null => {
    if(index===0&&!draft.customerId)return {message:'Seleccioná o creá un cliente.'}
    if(index===1&&!draft.device.brand.trim())return {message:'Completá marca y modelo.',field:'brand'}
    if(index===1&&!draft.device.model.trim())return {message:'Completá marca y modelo.',field:'model'}
    // El servidor rechaza un IMEI inválido (`INVALID_IMEI`): no se puede guardar
    // tal cual, pero es opcional — vaciarlo también deja seguir.
    if(index===1&&imeiInvalid)return {message:'El IMEI no es válido: tiene que tener 15 dígitos y un dígito verificador. Corregilo o dejalo vacío para seguir.',field:'imei'}
    if(index===2&&!draft.problem.trim())return {message:'Describí el problema informado.',field:'problem'}
    if(index===3&&draft.budgetAmount&&parseLocalizedAmount(draft.budgetAmount)===null)return {message:'Ingresá un presupuesto válido.',field:'budget'}
    return null
  }
  const block = (index: number, issue: { message: string; field?: FieldKey }) => {
    setStep(index); setError(issue.message)
    // El campo que falta se enfoca: en el celular el aviso de arriba puede no
    // estar a la vista cuando se toca «Continuar» al pie.
    if(issue.field){const testId=FIELD_TESTID[issue.field];requestAnimationFrame(()=>document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus())}
  }
  const next=()=>{const issue=stepIssue(step);if(issue){block(step,issue);return}setError('');setStep(value=>Math.min(LAST_STEP,value+1))}
  const back=()=>{setError('');setStep(value=>Math.max(0,value-1))}
  const goTo=(index:number)=>{if(index<step){setError('');setStep(index)}}
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
    // Los pasos ya validaron al avanzar; esto cubre volver atrás desde el
    // stepper y vaciar un campo obligatorio.
    for(let index=0;index<LAST_STEP;index+=1){const issue=stepIssue(index);if(issue){block(index,issue);return}}
    const budgetIssue=stepIssue(LAST_STEP);if(budgetIssue){block(LAST_STEP,budgetIssue);return}
    submitLock.current=true;setSubmitting(true);setError('')
    let orderId=createdOrderId
    try{
      if(!orderId){
        const created=await createOrderIntake(requestIdRef.current,draft);orderId=created.order_id;setCreatedOrderId(orderId)
        /**
         * ORDERS-V2-0 — el catálogo del negocio se autoalimenta con lo que se
         * carga a mano. Va DESPUÉS de la creación y sin `await`: la orden ya
         * existe y es lo que importa; el catálogo es una conveniencia y su
         * RPC no puede demorar ni hacer fallar una recepción. `ensureBrandAndModel`
         * deduplica server-side por `normalized_name` y devuelve null ante error.
         *
         * Sólo dentro de este `if`: en el reintento de fotos la orden ya existe
         * y no hay que volver a tocar el catálogo.
         */
        void ensureBrandAndModel(draft.device.brand,draft.device.model)
        // CLIENTES-UX-1B — la orden ya existe: si no se puede guardar el
        // destinatario, se avisa en la orden en vez de bloquear la recepción.
        if(notifyRecipient==='alternate'){
          try{await setOrderNotificationRecipient(orderId,'alternate')}
          catch(cause){recipientWarningRef.current=`La orden se creó, pero no se pudo guardar el aviso al contacto alternativo: ${cause instanceof Error?cause.message:'error desconocido'} Elegilo en la tarjeta Cliente.`}
        }
      }
      const upload=await uploadIntakePhotos(orderId,photos.map(photo=>photo.file))
      setDraft(previous=>({...previous,accessSecret:'',pattern:[]}));setDirty(false)
      if(upload.failed.length){
        setPhotos(previous=>previous.filter(photo=>upload.failed.includes(photo.file.name)))
        setError(`La orden fue creada. No se pudieron subir ${upload.failed.length} foto(s). Tocá “Reintentar fotos” para completar la evidencia.`)
        submitLock.current=false;return
      }
      navigate(`/orders/${orderId}`,{replace:true,state:{intakeCreated:true,...(recipientWarningRef.current?{notifyRecipientWarning:recipientWarningRef.current}:{})}})
    }catch(cause){setError(cause instanceof Error?intakeErrorMessage(cause.message):'No se pudo crear la orden.');if(!orderId)submitLock.current=false}
    finally{setSubmitting(false)}
  }

  if(!can('orders_create'))return <div className="card"><div className="card-body"><h1>Nueva orden</h1><p>No tenés permiso para registrar recepciones.</p><AppButton onClick={()=>navigate('/orders')}>Volver</AppButton></div></div>

  const accessLabel=(mode:AccessMode)=>ACCESS.find(option=>option.value===mode)?.label
  const finalAccessMode=effectiveAccessMode(draft)
  const accessSummary=finalAccessMode!==draft.accessMode
    ? `${accessLabel(finalAccessMode)} (el ${accessLabel(draft.accessMode)?.toLowerCase()} quedó sin cargar)`
    : ['pin','pattern','password'].includes(draft.accessMode)?`${accessLabel(draft.accessMode)} configurado`:accessLabel(draft.accessMode)
  const checklistValues=CHECKS.map(([key])=>draft.checklist[key]||'not_tested') as CheckResult[]
  const countOf=(result:CheckResult)=>checklistValues.filter(value=>value===result).length
  const checklistSummary=[`${countOf('ok')} OK`,`${countOf('fail')} con falla`,`${countOf('not_tested')} sin probar`].join(' · ')
  const reviewed=CHECKS.length-countOf('not_tested')

  const primaryAction=(fullWidth:boolean)=>step<LAST_STEP
    ?<AppButton variant="primary" fullWidth={fullWidth} onClick={next} rightIcon={fullWidth?undefined:<ChevronRight size={18}/>}>Continuar</AppButton>
    :<AppButton variant="primary" fullWidth={fullWidth} loading={submitting} onClick={submit}>{createdOrderId?'Reintentar fotos':'Crear orden'}</AppButton>

  return <>
    <div className="animate-fade-in intake-page">
    <header className="intake-header">
      <button type="button" className="btn btn-ghost intake-exit" onClick={cancel} aria-label="Salir de nueva orden"><ArrowLeft size={20}/></button>
      <div><p className="intake-eyebrow">Nueva orden</p><h1 ref={headingRef} tabIndex={-1}>{STEPS[step].title}</h1></div>
    </header>
    <AppStepper steps={STEP_LABELS} current={step} onSelect={goTo} label="Pasos de la recepción" data-testid="intake-stepper"/>
    {error&&<div className="alert-inline alert-error" role="alert">{error}</div>}

    {step===0&&<StepCard><CustomerPicker businessId={businessId} selectedId={draft.customerId} pinned={createdCustomers} onCreateNew={()=>setQuickOpen(true)} onSelect={customer=>chooseCustomer(customer)}/>
      {selectedCustomer&&noticeContact&&<fieldset className="intake-notify" data-testid="intake-notify">
        <legend>¿A quién avisamos por WhatsApp?</legend>
        <ChoiceGrid>{(['customer','alternate'] as const).map(kind=>{const who=kind==='customer'?{name:selectedCustomer.name,phone:selectedCustomer.phone??''}:noticeContact
          return <button type="button" key={kind} data-testid={`intake-notify-${kind}`} className={`intake-choice ${notifyRecipient===kind?'is-selected':''}`} aria-pressed={notifyRecipient===kind} onClick={()=>{setNotifyRecipient(kind);setDirty(true)}}>
            <strong>{kind==='customer'?'Al cliente':'Al contacto alternativo'}</strong><span className="intake-notify__who">{who.name}{who.phone?` · ${who.phone}`:''}</span></button>})}</ChoiceGrid>
        <p className="intake-notify__help">Se puede cambiar después desde la orden. El cliente sigue siendo el titular.</p>
      </fieldset>}
    </StepCard>}

    {step===1&&<>
      <StepCard title="Equipo">
        <AppSelect label="Tipo de equipo" value={draft.device.type} onChange={e=>updateDevice({type:e.target.value as IntakeDraft['device']['type']})} options={DEVICE_TYPES}/>
        {/* ORDERS-V2-0.1 — `<datalist>` no despliega sugerencias en WebKit móvil:
            en el celular esto era un campo de texto pelado. AppCombobox dibuja la
            lista con marcado propio y sigue aceptando texto libre. */}
        <FormGrid>
          <AppCombobox label="Marca" required value={draft.device.brand} options={brands} loading={brandsLoading}
            data-testid="intake-brand" autoCapitalize="words"
            emptyHint="No está en el catálogo. Podés escribirla igual."
            onChange={value=>updateDevice({brand:value,model:''})}/>
          <AppCombobox label="Modelo" required value={draft.device.model} options={models} loading={modelsLoading}
            data-testid="intake-model" autoCapitalize="words"
            emptyHint="No está en el catálogo. Podés escribirlo igual."
            onChange={value=>updateDevice({model:value})}/>
        </FormGrid>
        <div className="intake-id-grid">
          <div className="intake-field-action"><AppInput label="Número de serie (opcional)" value={draft.device.serial} onChange={e=>updateDevice({serial:e.target.value})} autoCapitalize="characters"/><AppButton variant="secondary" leftIcon={<ScanLine size={17}/>} onClick={()=>setScanner('serial')}>Escanear</AppButton></div>
          <div className="intake-field-action"><AppInput semantic="numeric" label="IMEI (opcional)" data-testid="intake-imei" value={draft.device.imei} error={imeiInvalid?'Debe ser un IMEI válido de 15 dígitos. Si no lo tenés a mano, dejalo vacío.':''} onChange={e=>updateDevice({imei:normalizeImei(e.target.value)})} maxLength={15}/><AppButton variant="secondary" leftIcon={<ScanLine size={17}/>} onClick={()=>setScanner('imei')}>Escanear</AppButton></div>
        </div>
      </StepCard>

      <StepCard title="Acceso al equipo">
        <div className="intake-security-note"><ShieldCheck size={20} aria-hidden="true"/><span>El acceso se cifra en Vault. No aparece en el resumen ni se guarda en el navegador.</span></div>
        <ChoiceGrid>{ACCESS.map(option=><button type="button" key={option.value} className={`intake-choice ${draft.accessMode===option.value?'is-selected':''}`} aria-pressed={draft.accessMode===option.value} onClick={()=>update({accessMode:option.value,accessSecret:'',pattern:[]})}><strong>{option.label}</strong><small>{option.hint}</small></button>)}</ChoiceGrid>
        {draft.accessMode==='pin' && (
          <AppInput semantic="password" inputMode="numeric" autoComplete="new-password" label="PIN" value={draft.accessSecret} onChange={e=>update({accessSecret:e.target.value.replace(/\D/g,'').slice(0,PIN_MAX_DIGITS)})}/>
        )}
        {draft.accessMode==='password' && (
          <AppInput semantic="password" autoComplete="new-password" label="Contraseña" value={draft.accessSecret} onChange={e=>update({accessSecret:e.target.value.slice(0,256)})}/>
        )}
        {draft.accessMode==='pattern'&&<PatternGrid value={draft.pattern} onChange={pattern=>update({pattern})}/>}
        {/* Ayuda, no bloqueo: «Continuar» sigue habilitado con cualquier acceso. */}
        {notice&&<p className="intake-access-notice" data-level={notice.level} role="status" data-testid="intake-access-notice">
          {notice.level==='warning'?<AlertTriangle size={16} aria-hidden="true"/>:<Info size={16} aria-hidden="true"/>}<span>{notice.message}</span>
        </p>}
      </StepCard>
    </>}

    {step===2&&<>
      <StepCard title="Problema">
        <AppTextarea label="Problema informado por el cliente" required data-testid="intake-problem" value={draft.problem} onChange={e=>update({problem:e.target.value})} minRows={4}/>
        <AppTextarea label="Observaciones de recepción" value={draft.observations} onChange={e=>update({observations:e.target.value})} hint="Estado, accesorios o aclaraciones que no forman parte del problema."/>
      </StepCard>

      <StepCard title="Estado del equipo">
        <FormGrid>
          <AppSelect label="Estado general" value={draft.condition.general} onChange={e=>update({condition:{...draft.condition,general:e.target.value}})} options={['Excelente','Bueno','Regular','Dañado'].map(value=>({value,label:value}))}/>
          <AppSelect label="¿Enciende?" value={draft.condition.powersOn} onChange={e=>update({condition:{...draft.condition,powersOn:e.target.value as IntakeDraft['condition']['powersOn']}})} options={[{value:'yes',label:'Sí'},{value:'no',label:'No'},{value:'not_verified',label:'No verificado'}]}/>
        </FormGrid>
        <fieldset><legend>Condiciones visibles</legend><ChoiceGrid>{['Pantalla rota','Rayones','Golpes','Humedad','Tapa dañada','Faltantes'].map(item=><label key={item} className="intake-check"><input type="checkbox" checked={draft.condition.physical.includes(item)} onChange={e=>update({condition:{...draft.condition,physical:e.target.checked?[...draft.condition.physical,item]:draft.condition.physical.filter(value=>value!==item)}})}/>{item}</label>)}</ChoiceGrid></fieldset>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e=>addPhotos(e.target.files)}/><AppButton variant="secondary" leftIcon={<Camera size={18}/>} onClick={()=>fileRef.current?.click()} disabled={photos.length>=8}>Agregar fotos ({photos.length}/8)</AppButton>
        <div className="intake-photo-grid">{photos.map((photo,index)=><div key={photo.preview}><img src={photo.preview} alt={`Foto de recepción ${index+1}`}/><button type="button" onClick={()=>removePhoto(index)} aria-label={`Quitar foto ${index+1}`}><Trash2 size={16}/></button></div>)}</div>
      </StepCard>

      {/* El checklist es opcional y largo (ocho filas): plegado no le roba la
          pantalla a quien recibe rápido, y el resumen dice cuánto se revisó. */}
      <details className="card intake-step-card intake-disclosure" open={checklistOpen} onToggle={event=>setChecklistOpen(event.currentTarget.open)} data-testid="intake-checklist">
        <summary className="intake-disclosure__summary">
          <span className="intake-disclosure__title">Checklist de funciones <small>(opcional)</small></span>
          <span className="intake-disclosure__meta">{reviewed} de {CHECKS.length} revisadas</span>
          <ChevronRight size={18} className="intake-disclosure__chevron" aria-hidden="true"/>
        </summary>
        <div className="card-body">
          <p className="form-hint">Marcá qué se verificó al recibir el equipo. “No probado” evita asumir que algo funciona.</p>
          <div className="intake-check-list">{CHECKS.map(([key,label])=><ChecklistField key={key} name={key} label={label} value={draft.checklist[key]||'not_tested'} onChange={result=>update({checklist:{...draft.checklist,[key]:result}})}/>)}</div>
        </div>
      </details>
    </>}

    {step===3&&<>
      <StepCard title="Asignación y presupuesto">
        <FormGrid>
          <AppSelect label="Técnico / responsable" value={draft.assignedProfileId} onChange={e=>update({assignedProfileId:e.target.value})} placeholder="Sin asignar" options={profiles.map(profile=>({value:profile.id,label:profile.full_name||profile.email||'Integrante'}))}/>
          <AppSelect label="Prioridad" value={draft.priority} onChange={e=>update({priority:e.target.value as IntakeDraft['priority']})} options={[{value:'medium',label:'Normal'},{value:'high',label:'Importante'},{value:'urgent',label:'Urgente'}]}/>
        </FormGrid>
        {/* ORDERS-V2-0.1 — moneda y monto eran dos controles sueltos y `85000` se
            veía igual en pesos que en dólares. AppMoneyInput los une y pone el
            prefijo adentro del campo. Cambiar de moneda NO convierte el importe. */}
        <AppMoneyInput label="Presupuesto estimado (opcional)" data-testid="intake-budget"
          value={draft.budgetAmount} onValueChange={value=>update({budgetAmount:value})}
          currency={draft.budgetCurrency} onCurrencyChange={currency=>update({budgetCurrency:currency})}
          hint="No registra pagos ni movimientos financieros. Cambiar la moneda no convierte el número."/>
      </StepCard>

      <StepCard title="Resumen">
        <div className="intake-summary">
          <Summary title="Cliente" onEdit={()=>goTo(0)}>{selectedCustomer?.name}</Summary>
          <Summary title="Avisos" onEdit={()=>goTo(0)}>{notifyRecipient==='alternate'&&noticeContact
            ?`${noticeContact.name} · ${noticeContact.phone} (${RECIPIENT_ROLE_LABEL.alternate})`
            :`${selectedCustomer?.name??''}${selectedCustomer?.phone?` · ${selectedCustomer.phone}`:''} (${RECIPIENT_ROLE_LABEL.customer})`}</Summary>
          <Summary title="Equipo" onEdit={()=>goTo(1)}>{draft.device.brand} {draft.device.model} · {DEVICE_TYPES.find(type=>type.value===draft.device.type)?.label} · Serie: {draft.device.serial||'No informada'} · IMEI: {draft.device.imei||'No informado'}</Summary>
          <Summary title="Acceso" onEdit={()=>goTo(1)}>{accessSummary}</Summary>
          <Summary title="Problema" onEdit={()=>goTo(2)}>{draft.problem}</Summary>
          <Summary title="Estado" onEdit={()=>goTo(2)}>{draft.condition.general} · {POWERS_ON_LABEL[draft.condition.powersOn]} · {photos.length} foto(s){draft.condition.physical.length?` · ${draft.condition.physical.join(', ')}`:''}</Summary>
          <Summary title="Checklist" onEdit={()=>{setChecklistOpen(true);goTo(2)}}>{checklistSummary}</Summary>
          {/* El presupuesto se carga arriba, en este mismo paso, pero se relee
              formateado: `85000` y `850000` se confunden en el campo y no acá
              (`$ 85.000,00` / `US$ …`, la autoridad de formato de ORDERS-V2-0.1). */}
          <Summary title="Presupuesto">{formatMoney(parseLocalizedAmount(draft.budgetAmount),draft.budgetCurrency,{fallback:'Sin presupuesto'})}</Summary>
        </div>
      </StepCard>
    </>}

    <div className="intake-desktop-actions"><AppButton variant="secondary" onClick={step===0?cancel:back} leftIcon={<ChevronLeft size={18}/>}>{step===0?'Cancelar':'Anterior'}</AppButton>{primaryAction(false)}</div>
    </div>
    <MobileActionBar secondaryAction={<AppButton variant="secondary" fullWidth onClick={step===0?cancel:back}>{step===0?'Cancelar':'Anterior'}</AppButton>} primaryAction={primaryAction(true)}/>
    <QuickCustomerDialog open={quickOpen} onClose={()=>setQuickOpen(false)} onCreated={customer=>{
      // El alta se antepone a los resultados del servidor y queda elegida:
      // el usuario acaba de crearla para ESTA orden.
      const option:CustomerPickerOption={id:customer.id,name:customer.name,phone:customer.phone,document:customer.document,customer_type:customer.customer_type}
      setCreatedCustomers(previous=>[option,...previous.filter(item=>item.id!==option.id)])
      const notice=customer.notification_contact_name&&customer.notification_contact_phone?{name:customer.notification_contact_name,phone:customer.notification_contact_phone}:null
      chooseCustomer(option,notice);setQuickOpen(false)
    }}/>
    {/* El IMEI escaneado pasa por la MISMA normalización que el tipeado; el
        serial no hereda la validación de IMEI, que es otro identificador. */}
    <BarcodeScannerDialog open={scanner!==null} target={scanner} onClose={()=>setScanner(null)} onDetected={value=>scanner&&updateDevice({[scanner]:scanner==='imei'?normalizeImei(value):value.trim()} as Partial<IntakeDraft['device']>)}/>
  </>
}

function Summary({title,onEdit,children}:{title:string;onEdit?:()=>void;children:React.ReactNode}){return <section><div><h3>{title}</h3>{onEdit&&<button type="button" onClick={onEdit} aria-label={`Editar ${title.toLowerCase()}`}>Editar</button>}</div><p>{children||'—'}</p></section>}

const QUICK_CUSTOMER_FORM_ID = 'quick-customer-form'

/**
 * Alta rápida: shell de diálogo sobre el cuerpo canónico de creación.
 *
 * PRE-BETA-3A-2 — NO se gatea por `customers`: la autoridad es la de la
 * recepción (`orders_create`), y un técnico sin el módulo Clientes necesita
 * crear al cliente que tiene enfrente. Lo único que se aplica acá es el gate
 * Mayorista, que ya resuelve el core.
 */
function QuickCustomerDialog({open,onClose,onCreated}:{open:boolean;onClose:()=>void;onCreated:(customer:Customer)=>void}){
  const {reset,attemptSubmit,toCreatePayload,fieldProps}=useCustomerCore()
  const [saving,setSaving]=useState(false);const [error,setError]=useState('')
  const submitLock=useRef(false)
  const close=()=>{reset();setError('');onClose()}
  const created=(customer:Customer)=>{reset();setError('');onCreated(customer)}
  const save=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault()
    if(submitLock.current)return
    // El CTA sólo lo bloquea el guardado en curso; el intento revela los bloqueos.
    if(!attemptSubmit())return
    submitLock.current=true
    setSaving(true);setError('')
    try{const customer=await customersService.create(toCreatePayload());created(customer)}
    catch(cause){setError(cause instanceof Error?cause.message:'No se pudo crear el cliente.')}
    finally{setSaving(false);submitLock.current=false}
  }
  return <ResponsiveDialog isOpen={open} onClose={close} title="Crear cliente rápido" subtitle="Queda disponible para esta orden y futuras recepciones." size="lg" mobilePresentation="fullscreen" footer={<div className="customer-create-dialog-actions"><AppButton variant="secondary" onClick={close}>Cancelar</AppButton><AppButton type="submit" form={QUICK_CUSTOMER_FORM_ID} variant="primary" loading={saving} data-testid="quick-customer-save-button">Crear cliente</AppButton></div>}>
    <form id={QUICK_CUSTOMER_FORM_ID} className="customer-create-form customer-create-form--quick" onSubmit={save} noValidate>
      {error&&<p className="form-error customer-create-server-error" role="alert">{error}</p>}
      <CustomerCreateFields {...fieldProps} additionalInitiallyOpen={false}/>
    </form>
  </ResponsiveDialog>
}
