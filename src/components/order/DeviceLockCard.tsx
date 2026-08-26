import { useEffect, useState } from 'react'
import { Edit2, Eye, EyeOff, Lock, Save, Trash2 } from 'lucide-react'
import { usePermissions } from '../../hooks/usePermissions'
import { AppButton, AppInput, AppSelect } from '../../ui'
import { PatternGrid } from '../../features/order-intake/PatternGrid'
import { deleteDeviceAccess, revealDeviceAccess, setDeviceAccess } from '../../features/order-intake/service'

type SecretMode = 'pin'|'pattern'|'password'
type AccessMode = SecretMode|'none'|'not_provided'|'not_verifiable'|null

const LABELS: Record<string,string> = {
  pin:'PIN',pattern:'Patrón',password:'Contraseña',none:'Sin bloqueo',
  not_provided:'No proporcionado',not_verifiable:'No verificable',
}

function visibleSecret(mode: AccessMode, value: string) {
  if(mode!=='pattern') return value
  try { const points=JSON.parse(value); return Array.isArray(points)?`Patrón: ${points.join(' → ')}`:'Patrón configurado' }
  catch { return 'Patrón configurado' }
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

  useEffect(()=>{setRevealed(null)},[orderId,accessMode])
  useEffect(()=>{if(!revealed)return;const timer=window.setTimeout(()=>setRevealed(null),30000);return()=>window.clearTimeout(timer)},[revealed])
  useEffect(()=>()=>{setSecret('');setPattern([]);setRevealed(null)},[])

  const reveal=async()=>{if(revealed){setRevealed(null);return}setBusy(true);setError('');try{setRevealed(await revealDeviceAccess(orderId))}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo revelar el acceso.')}finally{setBusy(false)}}
  const save=async()=>{const value=mode==='pattern'?JSON.stringify(pattern):secret;if(!value||(mode==='pattern'&&pattern.length<2)){setError('Completá el acceso.');return}setBusy(true);setError('');try{await setDeviceAccess(orderId,mode,value);setSecret('');setPattern([]);setEditing(false);await onChanged?.()}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo guardar.')}finally{setBusy(false)}}
  const remove=async()=>{if(!window.confirm('¿Eliminar el acceso guardado?'))return;setBusy(true);setError('');try{await deleteDeviceAccess(orderId);setRevealed(null);await onChanged?.()}catch(cause){setError(cause instanceof Error?cause.message:'No se pudo eliminar.')}finally{setBusy(false)}}

  return <div className="card" style={{marginTop:'1rem'}}>
    <div className="card-header" style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:'.75rem'}}><div style={{display:'flex',alignItems:'center',gap:'.5rem'}}><Lock size={18}/><h3 className="card-title">Acceso del equipo</h3></div><span className="badge">Cifrado · interno</span></div>
    <div className="card-body" style={{display:'flex',flexDirection:'column',gap:'1rem'}}>
      {!allowed&&<p style={{margin:0,color:'var(--text-subtle)'}}>No tenés permiso para consultar el acceso del equipo.</p>}
      {allowed&&!editing&&<>
        <p style={{margin:0}}>{LABELS[accessMode||'']||'Sin información'}{hasSecret?' configurado':''}</p>
        {revealed&&<div className="intake-security-note" role="status"><span style={{fontFamily:'monospace',overflowWrap:'anywhere'}}>{visibleSecret(accessMode??null,revealed)}</span></div>}
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
          : <AppInput semantic="password" inputMode={mode==='pin'?'numeric':undefined} autoComplete="new-password" label={mode==='pin'?'PIN':'Contraseña'} value={secret} onChange={event=>setSecret(mode==='pin'?event.target.value.replace(/\D/g,'').slice(0,12):event.target.value.slice(0,256))}/>
        }
        <div style={{display:'flex',gap:'.5rem'}}><AppButton variant="primary" loading={busy} leftIcon={<Save size={16}/>} onClick={save}>Guardar</AppButton><AppButton variant="secondary" onClick={()=>{setEditing(false);setSecret('');setPattern([])}}>Cancelar</AppButton></div>
      </>}
      {error&&<p className="form-error" role="alert">{error}</p>}
    </div>
  </div>
}
