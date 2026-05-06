import { FileText, Upload, Trash2, Download, Image, File, FileSpreadsheet } from 'lucide-react'
import { useState, useRef } from 'react'

interface Document {
  id: string
  file_name: string
  file_url: string
  file_type: string
  file_size?: number
  uploaded_by?: string
  created_at: string
}

interface DocumentsCardProps {
  documents: Document[]
  onUpload?: (files: FileList) => void
  onDelete?: (id: string) => void
  orderId: string
}

const fileTypeIcons: Record<string, any> = {
  'image': Image,
  'application/pdf': FileText,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': FileSpreadsheet,
  'application/vnd.ms-excel': FileSpreadsheet,
  'text/plain': File,
  'default': File
}

function getFileIcon(fileType: string) {
  if (fileType.startsWith('image/')) return fileTypeIcons.image
  return fileTypeIcons[fileType] || fileTypeIcons.default
}

function formatFileSize(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileExtension(filename: string) {
  return filename.split('.').pop()?.toUpperCase() || ''
}

export function DocumentsCard({ 
  documents, 
  onUpload, 
  onDelete
}: DocumentsCardProps) {
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    
    if (e.dataTransfer.files && onUpload) {
      onUpload(e.dataTransfer.files)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && onUpload) {
      onUpload(e.target.files)
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={18} color="#6366f1" />
          <h3 className="card-title">Documentos y Archivos</h3>
        </div>
        <span style={{ fontSize: '0.875rem', color: '#64748b' }}>
          {documents.length} archivo{documents.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="card-body">
        {/* Upload Area */}
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? '#6366f1' : '#374151'}`,
            borderRadius: '0.5rem',
            padding: '1.5rem',
            textAlign: 'center',
            cursor: 'pointer',
            backgroundColor: isDragging ? 'rgba(99, 102, 241, 0.05)' : 'transparent',
            transition: 'all 0.2s ease',
            marginBottom: documents.length > 0 ? '1.5rem' : 0
          }}
        >
          <Upload size={32} color="#64748b" style={{ marginBottom: '0.75rem' }} />
          <p style={{ color: '#a0aec0', marginBottom: '0.5rem' }}>
            Arrastra archivos aquí o haz clic para seleccionar
          </p>
          <p style={{ color: '#64748b', fontSize: '0.75rem' }}>
            PDF, imágenes, Excel (máx. 10MB)
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            accept=".pdf,.png,.jpg,.jpeg,.gif,.xlsx,.xls,.doc,.docx,.txt"
          />
        </div>

        {/* Documents List */}
        {documents.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {documents.map((doc) => {
              const FileIcon = getFileIcon(doc.file_type)
              
              return (
                <div 
                  key={doc.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '1rem',
                    padding: '0.75rem',
                    backgroundColor: '#1e293b',
                    borderRadius: '0.5rem'
                  }}
                >
                  <div style={{
                    width: '40px',
                    height: '40px',
                    borderRadius: '0.5rem',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <FileIcon size={20} color="#6366f1" />
                  </div>
                  
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ 
                      fontWeight: 500, 
                      color: '#f8fafc', 
                      marginBottom: '0.125rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {doc.file_name}
                    </p>
                    <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.75rem', color: '#64748b' }}>
                      <span>{getFileExtension(doc.file_name)}</span>
                      <span>{formatFileSize(doc.file_size)}</span>
                      <span>{new Date(doc.created_at).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric' })}</span>
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <a
                      href={doc.file_url}
                      download
                      className="btn btn-sm btn-outline"
                      title="Descargar"
                    >
                      <Download size={16} />
                    </a>
                    {onDelete && (
                      <button
                        className="btn btn-sm btn-outline"
                        style={{ color: '#dc2626' }}
                        onClick={() => onDelete(doc.id)}
                        title="Eliminar"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
