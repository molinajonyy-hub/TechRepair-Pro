import { Smartphone, Edit, Save, X } from 'lucide-react'
import { useState } from 'react'

interface Device {
  type: string
  brand: string
  model: string
  serial: string
  issue: string
  diagnosis?: string
}

interface DeviceInfoCardProps {
  device: Device
}

export function DeviceInfoCard({ device }: DeviceInfoCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editedDevice, setEditedDevice] = useState(device)

  const handleSave = () => {
    setIsEditing(false)
    // Aquí iría la llamada a la API para guardar
  }

  const deviceIcons: Record<string, string> = {
    celular: 'fa-mobile-alt',
    tablet: 'fa-tablet-alt',
    laptop: 'fa-laptop',
    smartwatch: 'fa-clock',
    otro: 'fa-mobile-alt',
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Smartphone size={18} color="#6366f1" />
          <h3 className="card-title">Dispositivo</h3>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {isEditing ? (
            <>
              <button className="btn btn-sm btn-primary" onClick={handleSave}>
                <Save size={14} />
                Guardar
              </button>
              <button className="btn btn-sm btn-outline" onClick={() => setIsEditing(false)}>
                <X size={14} />
                Cancelar
              </button>
            </>
          ) : (
            <button className="btn btn-sm btn-outline" onClick={() => setIsEditing(true)}>
              <Edit size={14} />
              Editar
            </button>
          )}
        </div>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '1rem',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.5rem',
            color: '#6366f1'
          }}>
            <i className={`fas ${deviceIcons[device.type] || 'fa-mobile-alt'}`}></i>
          </div>
          <div>
            <h4 style={{ fontSize: '1.125rem', fontWeight: 600, color: '#f8fafc', marginBottom: '0.25rem' }}>
              {device.brand} {device.model}
            </h4>
            <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
              Serial: {device.serial}
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Marca</p>
            {isEditing ? (
              <input
                type="text"
                value={editedDevice.brand}
                onChange={(e) => setEditedDevice({ ...editedDevice, brand: e.target.value })}
                className="form-control"
              />
            ) : (
              <p style={{ fontWeight: 500, color: '#f8fafc' }}>{device.brand}</p>
            )}
          </div>
          <div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Modelo</p>
            {isEditing ? (
              <input
                type="text"
                value={editedDevice.model}
                onChange={(e) => setEditedDevice({ ...editedDevice, model: e.target.value })}
                className="form-control"
              />
            ) : (
              <p style={{ fontWeight: 500, color: '#f8fafc' }}>{device.model}</p>
            )}
          </div>
          <div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Tipo</p>
            <p style={{ fontWeight: 500, color: '#f8fafc' }}>{device.type}</p>
          </div>
          <div>
            <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.25rem' }}>Serial/IMEI</p>
            {isEditing ? (
              <input
                type="text"
                value={editedDevice.serial}
                onChange={(e) => setEditedDevice({ ...editedDevice, serial: e.target.value })}
                className="form-control"
              />
            ) : (
              <p style={{ fontWeight: 500, color: '#f8fafc', fontFamily: 'monospace' }}>{device.serial}</p>
            )}
          </div>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Problema Reportado</p>
          {isEditing ? (
            <textarea
              value={editedDevice.issue}
              onChange={(e) => setEditedDevice({ ...editedDevice, issue: e.target.value })}
              className="form-control"
              rows={3}
            />
          ) : (
            <p style={{ color: '#f8fafc', lineHeight: 1.6 }}>{device.issue}</p>
          )}
        </div>

        <div>
          <p style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.5rem' }}>Diagnóstico Técnico</p>
          {isEditing ? (
            <textarea
              value={editedDevice.diagnosis || ''}
              onChange={(e) => setEditedDevice({ ...editedDevice, diagnosis: e.target.value })}
              className="form-control"
              rows={3}
              placeholder="Ingresar diagnóstico..."
            />
          ) : (
            <p style={{ color: '#a0aec0', lineHeight: 1.6 }}>
              {device.diagnosis || 'Sin diagnóstico registrado'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
