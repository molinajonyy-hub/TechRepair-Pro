import { Plus, Trash2, Package, DollarSign } from 'lucide-react'
import { useState } from 'react'

interface PartUsed {
  id: string
  code: string
  description: string
  quantity: number
  unit_price: number
  subtotal: number
}

interface PartsUsedCardProps {
  parts: PartUsed[]
  onAddPart?: (part: Omit<PartUsed, 'id' | 'subtotal'>) => void
  onDeletePart?: (id: string) => void
  editable?: boolean
}

export function PartsUsedCard({ 
  parts, 
  onAddPart, 
  onDeletePart,
  editable = true 
}: PartsUsedCardProps) {
  const [showForm, setShowForm] = useState(false)
  const [newPart, setNewPart] = useState({
    code: '',
    description: '',
    quantity: 1,
    unit_price: 0
  })

  const total = parts.reduce((sum, part) => sum + part.subtotal, 0)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (onAddPart) {
      onAddPart(newPart)
    }
    setNewPart({ code: '', description: '', quantity: 1, unit_price: 0 })
    setShowForm(false)
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Package size={18} color="#6366f1" />
          <h3 className="card-title">Repuestos Utilizados</h3>
        </div>
        {editable && (
          <button 
            className="btn btn-sm btn-primary"
            onClick={() => setShowForm(!showForm)}
          >
            <Plus size={16} />
            Agregar
          </button>
        )}
      </div>
      <div className="card-body">
        {showForm && editable && (
          <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: '#1e293b', borderRadius: '0.5rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr 1fr auto', gap: '0.75rem', alignItems: 'end' }}>
              <div>
                <label className="form-label" style={{ fontSize: '0.75rem' }}>Código</label>
                <input
                  type="text"
                  value={newPart.code}
                  onChange={(e) => setNewPart({ ...newPart, code: e.target.value })}
                  className="form-control"
                  placeholder="SCR-001"
                  required
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '0.75rem' }}>Descripción</label>
                <input
                  type="text"
                  value={newPart.description}
                  onChange={(e) => setNewPart({ ...newPart, description: e.target.value })}
                  className="form-control"
                  placeholder="Descripción del repuesto"
                  required
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '0.75rem' }}>Cantidad</label>
                <input
                  type="number"
                  value={newPart.quantity}
                  onChange={(e) => setNewPart({ ...newPart, quantity: parseInt(e.target.value) || 1 })}
                  className="form-control"
                  min="1"
                  required
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '0.75rem' }}>Precio Unit.</label>
                <input
                  type="number"
                  value={newPart.unit_price}
                  onChange={(e) => setNewPart({ ...newPart, unit_price: parseFloat(e.target.value) || 0 })}
                  className="form-control"
                  min="0"
                  step="0.01"
                  required
                />
              </div>
              <div>
                <button type="submit" className="btn btn-primary">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </form>
        )}

        {parts.length > 0 ? (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ fontSize: '0.875rem' }}>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Descripción</th>
                  <th>Cantidad</th>
                  <th>Precio Unit.</th>
                  <th>Subtotal</th>
                  {editable && <th></th>}
                </tr>
              </thead>
              <tbody>
                {parts.map((part) => (
                  <tr key={part.id}>
                    <td style={{ fontFamily: 'monospace', color: '#6366f1' }}>{part.code}</td>
                    <td>{part.description}</td>
                    <td>{part.quantity}</td>
                    <td>${part.unit_price}</td>
                    <td style={{ fontWeight: 600 }}>${part.subtotal}</td>
                    {editable && onDeletePart && (
                      <td>
                        <button 
                          className="btn btn-sm btn-outline" 
                          style={{ color: '#dc2626' }}
                          onClick={() => onDeletePart(part.id)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                <tr style={{ backgroundColor: '#1e293b', fontWeight: 600 }}>
                  <td colSpan={editable ? 4 : 4} style={{ textAlign: 'right' }}>
                    Total Repuestos:
                  </td>
                  <td colSpan={editable ? 2 : 1} style={{ color: '#6366f1' }}>
                    <DollarSign size={14} style={{ display: 'inline', marginRight: '0.25rem' }} />
                    {total}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
            <Package size={48} style={{ opacity: 0.5, marginBottom: '1rem' }} />
            <p>No hay repuestos registrados</p>
            {editable && (
              <button 
                className="btn btn-outline" 
                style={{ marginTop: '1rem' }}
                onClick={() => setShowForm(true)}
              >
                <Plus size={16} />
                Agregar Repuesto
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
