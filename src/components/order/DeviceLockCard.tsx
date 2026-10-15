import { useEffect, useState } from 'react'
import { AlertTriangle, Edit2, Eye, EyeOff, Lock, RotateCcw, Save, Trash2 } from 'lucide-react'
import { usePermissions } from '../../hooks/usePermissions'
import { AppButton, AppInput, AppSelect } from '../../ui'
import { PatternGrid } from '../../features/order-intake/PatternGrid'
import { PatternPreview } from '../../features/order-intake/PatternPreview'
import { PATTERN_MIN_POINTS, PIN_MAX_DIGITS, readStoredPattern, serializePattern } from '../../features/order-intake/model'
import { deleteDeviceAccess, revealDeviceAccess, setDeviceAccess } from '../../features/order-intake/service'

type SecretMode = 'pin'|'pattern'|'password'
type AccessMode = SecretMode|'none'|'not_provided'|'not_verifiable'|null

const LABELS: Record<string,string> = {
  pin:'PIN',pattern:'Patrón',password:'Contraseña',none:'Sin bloqueo',
  not_provided:'No proporcionado',not_verifiable:'No verificable',
}

/** «empieza arriba a la izquierda» — para el texto que acompaña la grilla. */
const POSICION = ['arriba a la izquierda','arriba al centro','arriba a la derecha','al centro a la izquierda','en el centro','al centro a la derecha','abajo a la izquierda','abajo al centro','abajo a la derecha']

/**
 * BETA-UX-2 · hotfix — lo que se muestra al revelar.
 *
 * Antes: el JSON crudo como texto («Patrón: 1 → 4 → 7 → 8»). Además hubo un
 * cambio de contrato (grilla 1–9 → servidor 0–8) y los patrones guardados antes
 * no siempre pueden leerse con certeza (`readStoredPattern`). Regla: sólo se
 * DIBUJA lo que se lee exacto; lo ambiguo o ilegible es un aviso con su CTA,
 * sin ningún número que pueda tomarse por el patrón. Nunca bloquea la orden.
 */
function RevealedAccess({ mode, value, onReconfigure }: { mode: AccessMode; value: string; onReconfigure: () => void }) {
  if (mode !== 'pattern') {
    return <div className="device-access-reveal" role="status" data-testid="device-lock-reveal">
      <div className="device-access-reveal__info">
        <p className="device-access-reveal__meta">{mode==='pin'?'PIN':'Contraseña'} · se oculta solo en 30 segundos</p>
        <p className="device-access-reveal__secret">{value}</p>
      </div>
    </div>
  }
  const lectura = readStoredPattern(value)
  if (lectura.kind === 'exact') {
    return <div className="device-access-reveal" role="status" data-testid="device-lock-reveal">
      <PatternPreview points={lectura.points} testId="device-lock-pattern"/>
      <div className="device-access-reveal__info">
        <p className="device-access-reveal__title">Patrón de {lectura.points.length} puntos</p>
        <p className="device-access-reveal__meta">Empieza {POSICION[lectura.points[0]-1]} (aro) y sigue el orden de los números.</p>
        <p className="device-access-reveal__meta">Se oculta solo en 30 segundos.</p>
      </div>
    </div>
  }
  const ambiguo = lectura.kind === 'ambiguous'
  return <div data-testid="device-lock-reveal">
    <div className="device-access-legacy" role="status" data-testid="device-lock-legacy">
      <AlertTriangle size={18} aria-hidden="true"/>
      <div>
        <p className="device-access-legacy__title">{ambiguo?'Patrón guardado con formato anterior':'No pudimos leer el patrón guardado'}</p>
        <p className="device-access-legacy__body">{ambiguo
          ? 'Se cargó antes de un cambio en la numeración de la grilla y no podemos garantizar que se vea exacto, así que no lo mostramos. Recomendamos reconfigurarlo: confirmalo con el cliente y volvé a cargarlo.'
          : 'Está guardado en un formato que no reconocemos. Confirmalo con el cliente y volvé a cargarlo.'}</p>
        <AppButton variant="secondary" leftIcon={<RotateCcw size={16} aria-hidden="true"/>} onClick={onReconfigure}>Reconfigurar patrón</AppButton>
      </div>
    </div>
  </div>
}

export function DeviceLockCard({ orderId, accessMode, onChanged }: { orderId:string; accessMode?:AccessMode; onChanged?:()=>Promise<void>|void }) {
  const { can } = usePermissions()
  const allowed = can('device_access_secret')
  const [editing,setEditing] = useState(false)
  const [mode,setMode] = useState<SecretMode>(accessMode==='pin'||accessMode==='pattern'||accessMode==='password'?accessMode:'pin')
  const [secret,setSecret] = useState('')
  const [pattern,setPattern] = useState<number[]>([])
  const [revealed,setRevealed] = useState<string|null>(null)
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState('')
  const hasSecret = accessMode==='pin'||accessMode==='pattern'||accessMode==='password'
  const reconfigurePattern=()=>{setRevealed(null);setError('');setMode('pattern');setSecret('');setPattern([]);setEditing(true)}

  useEffect(()=>{setRevealed(null)},[orderId,accessMode])
  useEffect(()=>{if(!revealed)return;const timer=window.setTimeout(()=>setRevealed(null),30000);return()=>window.clearTimeout(timer)},[revealed])
  useEffect(()=>()=>{setSecret('');setPattern([]);setRevealed(null)},[])

  const reveal=async()=>{if(revealed){setRevealed(null);return}setBusy(true);setError('');try{setRevealed(await revealDeviceAccess(orderId))}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo revelar el acceso.')}finally{setBusy(false)}}
  const save=async()=>{
    if(mode==='pattern'&&pattern.length<PATTERN_MIN_POINTS){setError(`Marcá al menos ${PATTERN_MIN_POINTS} puntos del patrón.`);return}
    const value=mode==='pattern'?serializePattern(pattern):secret;if(!value){setError('Completá el acceso.');return}setBusy(true);setError('');try{await setDeviceAccess(orderId,mode,value);setSecret('');setPattern([]);setEditing(false);await onChanged?.()}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo guardar.')}finally{setBusy(false)}}
  const remove=async()=>{if(!window.confirm('¿Eliminar el acceso guardado?'))return;setBusy(true);setError('');try{await deleteDeviceAccess(orderId);setRevealed(null);await onChanged?.()}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo eliminar.')}finally{setBusy(false)}}

  // BETA-UX-1E — sólo presentación. Tres textos de esta tarjeta no declaraban
  // color y quedaban con el de Bootstrap, que no sigue al tema: la etiqueta
  // (`.badge` a secas, blanca) no se veía en claro, y el ícono y el estado
  // (gris casi negro) no se veían en oscuro. Ahora toman tokens de tema.
  // «Guardar» lleva además `btn-primary-aa`: sobre el gradiente de
  // `.btn-primary` el texto blanco no llega a AA (2,77:1 en oscuro).
  return <div className="card" style={{marginTop:'1rem'}}>
    <div className="card-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'.75rem'}}><div style={{display:'flex',alignItems:'center',gap:'.5rem'}}><Lock size={18} style={{color:'var(--text-secondary)'}}/><h3 className="card-title">Acceso del equipo</h3></div><span className="badge device-lock-badge" data-testid="device-lock-badge">Cifrado · interno</span></div>
    <div className="card-body" style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
      {!allowed&&<p style={{margin:0,color:'var(--text-subtle)'}}>No tenés permiso para consultar el acceso del equipo.</p>}
      {allowed&&!editing&&<>
        <p data-testid="device-lock-status" style={{margin:0,color:'var(--text-primary)'}}>{LABELS[accessMode||'']||'Sin información'}{hasSecret?' configurado':''}</p>
        {revealed&&<RevealedAccess mode={accessMode??null} value={revealed} onReconfigure={reconfigurePattern}/>}
        <div style={{display:'flex',gap:'.5rem',flexWrap:'wrap'}}>
          {hasSecret&&<AppButton variant="secondary" loading={busy} leftIcon={revealed?<EyeOff size={16}/>:<Eye size={16}/>} onClick={reveal}>{revealed?'Ocultar':'Revelar'}</AppButton>}
          <AppButton variant="secondary" leftIcon={<Edit2 size={16}/>} onClick={()=>setEditing(true)}>Configurar</AppButton>
          {hasSecret&&<AppButton variant="danger" leftIcon={<Trash2 size={16}/>} onClick={remove}>Eliminar</AppButton>}
        </div>
      </>}
      {allowed&&editing&&<>
        <AppSelect label="Tipo" value={mode} onChange={event=>{setMode(event.target.value as SecretMode);setSecret('');setPattern([])}} options={[{value:'pin',label:'PIN'},{value:'pattern',label:'Patrón'},{value:'password',label:'Contraseña'}]}/>
        {mode==='pattern'
          ? <PatternGrid value={pattern} onChange={setPattern}/>
          : <AppInput semantic="password" inputMode={mode==='pin'?'numeric':undefined} autoComplete="new-password" label={mode==='pin'?'PIN':'Contraseña'} value={secret} onChange={event=>setSecret(mode==='pin'?event.target.value.replace(/\D/g,'').slice(0,PIN_MAX_DIGITS):event.target.value.slice(0,256))}/>
        }
        <div style={{display:'flex',gap:'.5rem'}}><AppButton variant="primary" className="btn-primary-aa" loading={busy} leftIcon={<Save size={16}/>} onClick={save}>Guardar</AppButton><AppButton variant="secondary" onClick={()=>{setEditing(false);setSecret('');setPattern([])}}>Cancelar</AppButton></div>
      </>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
  </div>
}
