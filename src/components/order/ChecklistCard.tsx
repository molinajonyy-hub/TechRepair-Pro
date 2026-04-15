import { useState } from 'react'
import { CheckSquare, Square, Loader2, AlertCircle, CheckCircle, PenLine } from 'lucide-react'
import { supabase } from '../../lib/supabase'

interface Checklist {
  id: string
  diagnosis_done: boolean
  diagnosis_notes?: string
  repair_done: boolean
  parts_replaced?: string[]
  final_test_passed: boolean
  cleaning_done: boolean
  quality_control: boolean
  retirement_signature?: string
  retirement_signature_date?: string
}

interface ChecklistCardProps {
  orderId: string
  checklist: Checklist | null | undefined
  onChecklistChange: () => void
}

export function ChecklistCard({ orderId, checklist, onChecklistChange }: ChecklistCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [formData, setFormData] = useState<Partial<Checklist>>({
    diagnosis_done: checklist?.diagnosis_done || false,
    diagnosis_notes: checklist?.diagnosis_notes || '',
    repair_done: checklist?.repair_done || false,
    final_test_passed: checklist?.final_test_passed || false,
    cleaning_done: checklist?.cleaning_done || false,
    quality_control: checklist?.quality_control || false,
    retirement_signature: checklist?.retirement_signature || ''
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    setError('')
    setSuccess('')

    try {
      if (checklist?.id) {
        // Actualizar existente
        const { error: updateError } = await supabase
          .from('order_checklists')
          .update({
            ...formData,
            updated_at: new Date().toISOString()
          })
          .eq('id', checklist.id)

        if (updateError) throw updateError
      } else {
        // Crear nuevo
        const { error: insertError } = await supabase
          .from('order_checklists')
          .insert({
            order_id: orderId,
            ...formData
          })

        if (insertError) throw insertError
      }

      setSuccess('Checklist guardado correctamente')
      setIsEditing(false)
      onChecklistChange()
      
      setTimeout(() => setSuccess(''), 3000)
    } catch (err: any) {
      setError(err.message || 'Error al guardar checklist')
    } finally {
      setIsSubmitting(false)
    }
  }

  const toggleCheckbox = (field: keyof Checklist) => {
    setFormData(prev => ({ ...prev, [field]: !prev[field] }))
  }

  const allTasksDone = 
    formData.diagnosis_done && 
    formData.repair_done && 
    formData.final_test_passed && 
    formData.cleaning_done && 
    formData.quality_control

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <CheckSquare size={20} color="#6366f1" />
          <h3 className="card-title">Checklist de Reparación</h3>
        </div>
        <button 
          onClick={() => setIsEditing(!isEditing)}
          className="btn btn-sm btn-outline"
        >
          <PenLine size={16} />
          {isEditing ? 'Cancelar' : 'Editar'}
        </button>
      </div>
      
      <div className="card-body">
        {error && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(220, 38, 38, 0.1)',
            border: '1px solid rgba(220, 38, 38, 0.3)',
            borderRadius: '0.5rem',
            color: '#dc2626',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {success && (
          <div style={{
            padding: '0.75rem 1rem',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '0.5rem',
            color: '#10b981',
            marginBottom: '1rem',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}>
            <CheckCircle size={16} />
            {success}
          </div>
        )}

        {/* Progreso visual */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontSize: '0.875rem', color: '#a0aec0' }}>Progreso</span>
            <span style={{ fontSize: '0.875rem', color: allTasksDone ? '#10b981' : '#f59e0b' }}>
              {allTasksDone ? 'Completo' : 'Pendiente'}
            </span>
          </div>
          <div style={{ 
            height: '8px', 
            backgroundColor: '#1e293b', 
            borderRadius: '4px',
            overflow: 'hidden'
          }}>
            <div style={{
              height: '100%',
              width: `${[
                formData.diagnosis_done,
                formData.repair_done,
                formData.final_test_passed,
                formData.cleaning_done,
                formData.quality_control
              ].filter(Boolean).length / 5 * 100}%`,
              backgroundColor: allTasksDone ? '#10b981' : '#6366f1',
              borderRadius: '4px',
              transition: 'all 0.3s ease'
            }} />
          </div>
        </div>

        {isEditing ? (
          <form onSubmit={handleSubmit}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Diagnóstico */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                  onClick={() => toggleCheckbox('diagnosis_done')}
                >
                  {formData.diagnosis_done ? (
                    <CheckSquare size={24} color="#10b981" />
                  ) : (
                    <Square size={24} color="#64748b" />
                  )}
                  <span style={{ color: '#f8fafc', fontWeight: 500 }}>Diagnóstico completado</span>
                </div>
                {formData.diagnosis_done && (
                  <textarea
                    value={formData.diagnosis_notes}
                    onChange={(e) => setFormData({ ...formData, diagnosis_notes: e.target.value })}
                    placeholder="Notas del diagnóstico..."
                    className="form-control"
                    style={{ marginTop: '0.75rem' }}
                    rows={2}
                  />
                )}
              </div>

              {/* Reparación */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                  onClick={() => toggleCheckbox('repair_done')}
                >
                  {formData.repair_done ? (
                    <CheckSquare size={24} color="#10b981" />
                  ) : (
                    <Square size={24} color="#64748b" />
                  )}
                  <span style={{ color: '#f8fafc', fontWeight: 500 }}>Reparación completada</span>
                </div>
              </div>

              {/* Pruebas finales */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                  onClick={() => toggleCheckbox('final_test_passed')}
                >
                  {formData.final_test_passed ? (
                    <CheckSquare size={24} color="#10b981" />
                  ) : (
                    <Square size={24} color="#64748b" />
                  )}
                  <span style={{ color: '#f8fafc', fontWeight: 500 }}>Pruebas finales aprobadas</span>
                </div>
              </div>

              {/* Limpieza */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                  onClick={() => toggleCheckbox('cleaning_done')}
                >
                  {formData.cleaning_done ? (
                    <CheckSquare size={24} color="#10b981" />
                  ) : (
                    <Square size={24} color="#64748b" />
                  )}
                  <span style={{ color: '#f8fafc', fontWeight: 500 }}>Limpieza realizada</span>
                </div>
              </div>

              {/* Control de calidad */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <div 
                  style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}
                  onClick={() => toggleCheckbox('quality_control')}
                >
                  {formData.quality_control ? (
                    <CheckSquare size={24} color="#10b981" />
                  ) : (
                    <Square size={24} color="#64748b" />
                  )}
                  <span style={{ color: '#f8fafc', fontWeight: 500 }}>Control de calidad</span>
                </div>
              </div>

              {/* Firma de retiro */}
              <div style={{ padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
                <label style={{ display: 'block', color: '#f8fafc', fontWeight: 500, marginBottom: '0.5rem' }}>
                  Firma de Retiro
                </label>
                <input
                  type="text"
                  value={formData.retirement_signature}
                  onChange={(e) => setFormData({ ...formData, retirement_signature: e.target.value })}
                  placeholder="URL o referencia de la firma..."
                  className="form-control"
                />
                <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.5rem' }}>
                  Requerido para completar la orden
                </p>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} style={{ marginRight: '0.5rem', animation: 'spin 1s linear infinite' }} />
                    Guardando...
                  </>
                ) : (
                  'Guardar Checklist'
                )}
              </button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Vista de solo lectura */}
            {[
              { label: 'Diagnóstico', done: checklist?.diagnosis_done },
              { label: 'Reparación', done: checklist?.repair_done },
              { label: 'Pruebas Finales', done: checklist?.final_test_passed },
              { label: 'Limpieza', done: checklist?.cleaning_done },
              { label: 'Control de Calidad', done: checklist?.quality_control }
            ].map((item, index) => (
              <div 
                key={index}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.75rem',
                  padding: '0.75rem',
                  backgroundColor: '#1e293b',
                  borderRadius: '0.5rem'
                }}
              >
                {item.done ? (
                  <CheckSquare size={20} color="#10b981" />
                ) : (
                  <Square size={20} color="#64748b" />
                )}
                <span style={{ color: item.done ? '#f8fafc' : '#64748b' }}>
                  {item.label}
                </span>
                {item.done && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#10b981' }}>
                    Completado
                  </span>
                )}
              </div>
            ))}

            {checklist?.retirement_signature && (
              <div style={{ 
                marginTop: '1rem',
                padding: '1rem',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderRadius: '0.5rem',
                border: '1px solid rgba(16, 185, 129, 0.3)'
              }}>
                <p style={{ color: '#10b981', margin: 0, fontSize: '0.875rem' }}>
                  ✓ Firma de retiro registrada
                </p>
                <p style={{ color: '#a0aec0', margin: '0.25rem 0 0 0', fontSize: '0.75rem' }}>
                  {checklist.retirement_signature}
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
