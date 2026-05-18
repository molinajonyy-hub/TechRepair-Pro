import { useState } from 'react'
import { CheckSquare, Square, Camera, PenLine, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'

// Items del checklist
const CHECKLIST_ITEMS = [
  { id: 'face_id', label: 'Face ID / Touch ID' },
  { id: 'touch_screen', label: 'Táctil funciona correctamente' },
  { id: 'display_image', label: 'Imagen en pantalla (sin líneas/manchas)' },
  { id: 'front_camera', label: 'Cámara frontal' },
  { id: 'back_camera', label: 'Cámara trasera' },
  { id: 'microphone', label: 'Micrófono' },
  { id: 'speaker', label: 'Parlante / Auricular' },
  { id: 'wifi', label: 'Wi-Fi' },
  { id: 'bluetooth', label: 'Bluetooth' },
  { id: 'charging', label: 'Carga (puerto/cable)' },
  { id: 'battery_health', label: 'Batería / Salud de batería' },
  { id: 'sensors', label: 'Sensores (proximidad, luz, giroscopio)' },
  { id: 'buttons', label: 'Botones (volumen, power, mute)' },
  { id: 'vibration', label: 'Vibración' },
]

const AESTHETIC_CONDITIONS = [
  { id: 'screen_condition', label: 'Pantalla', options: ['Perfecto', 'Rayones leves', 'Rayones marcados', 'Grieta', 'Roto'] },
  { id: 'back_condition', label: 'Tapa trasera', options: ['Perfecto', 'Rayones leves', 'Rayones marcados', 'Grieta', 'Roto'] },
  { id: 'frame_condition', label: 'Marco', options: ['Perfecto', 'Rayones leves', 'Rayones marcados', 'Abolladuras', 'Deformado'] },
  { id: 'camera_lens', label: 'Lente de cámara', options: ['Perfecto', 'Rayones', 'Roto', 'Sucio'] },
]

const ACCESSORIES = [
  { id: 'cable', label: 'Cable USB' },
  { id: 'charger', label: 'Cargador de pared' },
  { id: 'case', label: 'Funda/Case' },
  { id: 'screen_protector', label: 'Vidrio templado' },
  { id: 'sim', label: 'Chip/SIM' },
  { id: 'box', label: 'Caja original' },
  { id: 'earphones', label: 'Auriculares' },
]

interface DeviceInspectionCardProps {
  orderId: string
  checklist: any
  type: 'reception' | 'final'
  onChecklistChange: () => void
}

export function DeviceInspectionCard({ orderId, checklist, type, onChecklistChange }: DeviceInspectionCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  
  const [formData, setFormData] = useState(() => {
    const defaults: any = {}
    CHECKLIST_ITEMS.forEach(item => {
      defaults[item.id] = checklist?.[item.id] ?? (type === 'final')
    })
    AESTHETIC_CONDITIONS.forEach(item => {
      defaults[item.id] = checklist?.[item.id] || 'Perfecto'
    })
    defaults.accessories = checklist?.accessories || []
    defaults.customer_notes = checklist?.customer_notes || ''
    defaults.technician_notes = checklist?.technician_notes || ''
    defaults.customer_signature = checklist?.customer_signature || ''
    return defaults
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')
    setSuccess('')

    try {
      const payload = {
        order_id: orderId,
        type,
        ...formData,
      }

      if (checklist?.id) {
        await supabase.from('device_inspections').update(payload).eq('id', checklist.id)
      } else {
        await supabase.from('device_inspections').insert(payload)
      }

      setSuccess(type === 'reception' ? 'Checklist de recepción guardado' : 'Checklist final guardado')
      setIsEditing(false)
      onChecklistChange()
      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const toggleCheck = (id: string) => {
    setFormData({ ...formData, [id]: !formData[id] })
  }

  const toggleAccessory = (id: string) => {
    const current = formData.accessories || []
    const updated = current.includes(id) ? current.filter((a: string) => a !== id) : [...current, id]
    setFormData({ ...formData, accessories: updated })
  }

  const completed = CHECKLIST_ITEMS.filter(item => formData[item.id]).length
  const percentage = Math.round((completed / CHECKLIST_ITEMS.length) * 100)

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <CheckSquare size={20} color={type === 'reception' ? '#f59e0b' : '#10b981'} />
          <h3 className="card-title">
            {type === 'reception' ? 'Checklist de Recepción' : 'Checklist Final de Entrega'}
          </h3>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{ width: '60px', height: '6px', backgroundColor: '#1e293b', borderRadius: '3px' }}>
            <div style={{ height: '100%', width: `${percentage}%`, backgroundColor: percentage === 100 ? '#10b981' : '#6366f1', borderRadius: '3px' }} />
          </div>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{percentage}%</span>
          <button onClick={() => setIsEditing(!isEditing)} className="btn btn-sm btn-outline">
            {isEditing ? 'Cancelar' : checklist ? 'Editar' : 'Completar'}
          </button>
        </div>
      </div>
      
      <div className="card-body">
        {error && <div style={{ padding: '0.75rem', backgroundColor: 'rgba(220, 38, 38, 0.1)', borderRadius: '0.5rem', color: '#dc2626', marginBottom: '1rem' }}>{error}</div>}
        {success && <div style={{ padding: '0.75rem', backgroundColor: 'rgba(16, 185, 129, 0.1)', borderRadius: '0.5rem', color: '#10b981', marginBottom: '1rem' }}>{success}</div>}

        {isEditing ? (
          <form onSubmit={handleSubmit}>
            {/* 1. FUNCIONALIDAD */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem' }}>
                1. Funcionalidad del Dispositivo
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {CHECKLIST_ITEMS.map((item) => (
                  <div key={item.id} onClick={() => toggleCheck(item.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', backgroundColor: formData[item.id] ? 'rgba(16, 185, 129, 0.1)' : '#1e293b', borderRadius: '0.375rem', cursor: 'pointer', border: formData[item.id] ? '1px solid #10b981' : '1px solid transparent' }}>
                    {formData[item.id] ? <CheckSquare size={18} color="#10b981" /> : <Square size={18} color="#64748b" />}
                    <span style={{ fontSize: '0.875rem', color: formData[item.id] ? '#f8fafc' : '#a0aec0' }}>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 2. ESTADO ESTETICO */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem' }}>
                2. Estado Estético
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {AESTHETIC_CONDITIONS.map((item) => (
                  <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span style={{ fontSize: '0.875rem', color: '#a0aec0', minWidth: '120px' }}>{item.label}</span>
                    <select value={formData[item.id]} onChange={(e) => setFormData({ ...formData, [item.id]: e.target.value })} className="form-select" style={{ flex: 1 }}>
                      {item.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {/* 3. ACCESORIOS */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem' }}>
                3. Accesorios {type === 'reception' ? 'Recibidos' : 'Entregados'}
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                {ACCESSORIES.map((item) => (
                  <div key={item.id} onClick={() => toggleAccessory(item.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', backgroundColor: formData.accessories?.includes(item.id) ? '#6366f120' : '#1e293b', borderRadius: '0.375rem', cursor: 'pointer' }}>
                    {formData.accessories?.includes(item.id) ? <CheckSquare size={16} color="#6366f1" /> : <Square size={16} color="#64748b" />}
                    <span style={{ fontSize: '0.875rem', color: formData.accessories?.includes(item.id) ? '#f8fafc' : '#a0aec0' }}>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 4. NOTAS */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem' }}>4. Notas</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <textarea value={formData.customer_notes} onChange={(e) => setFormData({ ...formData, customer_notes: e.target.value })} placeholder="Condiciones reportadas por el cliente..." className="form-control" rows={2} />
                <textarea value={formData.technician_notes} onChange={(e) => setFormData({ ...formData, technician_notes: e.target.value })} placeholder="Observaciones del técnico..." className="form-control" rows={2} />
              </div>
            </div>

            {/* 5. FIRMA (solo checklist final) */}
            {type === 'final' && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <PenLine size={16} /> 5. Firma del Cliente
                </h4>
                <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.5rem' }}>
                  El cliente declara haber recibido el dispositivo en las condiciones indicadas.
                </p>
                <input type="text" value={formData.customer_signature} onChange={(e) => setFormData({ ...formData, customer_signature: e.target.value })} placeholder="Nombre completo del cliente" className="form-control" />
              </div>
            )}

            {/* 6. FOTOS */}
            <div style={{ marginBottom: '1.5rem' }}>
              <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Camera size={16} /> 6. Evidencia Fotográfica
              </h4>
              <div style={{ padding: '2rem', backgroundColor: '#1e293b', borderRadius: '0.5rem', border: '2px dashed #374151', textAlign: 'center' }}>
                <p style={{ color: '#64748b', margin: 0 }}>📷 Sube fotos del estado del dispositivo</p>
                <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.5rem' }}>(Integrar con DocumentUploader)</p>
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={isSubmitting} style={{ width: '100%' }}>
              {isSubmitting ? <><Loader2 size={16} style={{ marginRight: '0.5rem', animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : `Guardar ${type === 'reception' ? 'Recepción' : 'Entrega'}`}
            </button>
          </form>
        ) : (
          <div>
            {!checklist ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                <CheckSquare size={48} style={{ opacity: 0.3, marginBottom: '1rem' }} />
                <p>No hay checklist completado</p>
                <button onClick={() => setIsEditing(true)} className="btn btn-primary" style={{ marginTop: '1rem' }}>Completar Checklist</button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Resumen funcionalidad */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                  {CHECKLIST_ITEMS.map((item) => (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', backgroundColor: checklist[item.id] ? 'rgba(16, 185, 129, 0.1)' : '#1e293b', borderRadius: '0.375rem' }}>
                      {checklist[item.id] ? <CheckSquare size={16} color="#10b981" /> : <Square size={16} color="#64748b" />}
                      <span style={{ fontSize: '0.75rem', color: checklist[item.id] ? '#10b981' : '#64748b' }}>{item.label}</span>
                    </div>
                  ))}
                </div>

                {/* Estado estético */}
                <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                  <h5 style={{ fontSize: '0.75rem', color: '#64748b', margin: '0 0 0.5rem 0' }}>Estado Estético</h5>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.25rem', fontSize: '0.75rem' }}>
                    {AESTHETIC_CONDITIONS.map((item) => (
                      <div key={item.id}><span style={{ color: '#a0aec0' }}>{item.label}:</span> <span style={{ color: '#f8fafc' }}>{checklist[item.id] || 'No especificado'}</span></div>
                    ))}
                  </div>
                </div>

                {/* Accesorios */}
                {checklist.accessories?.length > 0 && (
                  <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                    <h5 style={{ fontSize: '0.75rem', color: '#64748b', margin: '0 0 0.5rem 0' }}>Accesorios</h5>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                      {checklist.accessories.map((accId: string) => {
                        const acc = ACCESSORIES.find(a => a.id === accId)
                        return acc ? <span key={accId} style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem', backgroundColor: '#6366f120', color: '#6366f1', borderRadius: '0.25rem' }}>{acc.label}</span> : null
                      })}
                    </div>
                  </div>
                )}

                {/* Notas */}
                {(checklist.customer_notes || checklist.technician_notes) && (
                  <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                    {checklist.customer_notes && <p style={{ fontSize: '0.75rem', color: '#a0aec0', margin: '0 0 0.5rem 0' }}><strong>Cliente:</strong> {checklist.customer_notes}</p>}
                    {checklist.technician_notes && <p style={{ fontSize: '0.75rem', color: '#a0aec0', margin: 0 }}><strong>Técnico:</strong> {checklist.technician_notes}</p>}
                  </div>
                )}

                {/* Firma */}
                {checklist.customer_signature && (
                  <div style={{ padding: '1rem', backgroundColor: 'rgba(16, 185, 129, 0.1)', borderRadius: '0.5rem', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                    <p style={{ fontSize: '0.75rem', color: '#10b981', margin: 0 }}>✓ Firmado por: {checklist.customer_signature}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
