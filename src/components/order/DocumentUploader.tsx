import { useState, useRef } from 'react'
import { FileText, Upload, Trash2, Download, Image, File, Loader2 } from 'lucide-react'
import { storageService } from '../../services/storage'
import { supabase } from '../../lib/supabase'

interface Document {
  id: string
  file_name: string
  file_url: string
  file_type: string
  file_size?: number
  storage_path: string
  created_at: string
}

interface DocumentUploaderProps {
  orderId: string
  documents: Document[]
  onDocumentsChange: (docs: Document[]) => void
}

const fileTypeIcons: Record<string, any> = {
  'image': Image,
  'application/pdf': FileText,
  'default': File
}

function getFileIcon(fileType: string) {
  if (fileType.startsWith('image/')) return fileTypeIcons.image
  return fileTypeIcons['application/pdf'] || fileTypeIcons.default
}

function formatFileSize(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DocumentUploader({ orderId, documents, onDocumentsChange }: DocumentUploaderProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = () => {
    setIsDragging(false)
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    
    if (e.dataTransfer.files) {
      await uploadFiles(e.dataTransfer.files)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await uploadFiles(e.target.files)
    }
  }

  const uploadFiles = async (files: FileList) => {
    setUploading(true)
    const newDocs: Document[] = []
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setUploadProgress(`Subiendo ${file.name}...`)
      
      try {
        // Upload to Storage
        const { path, url } = await storageService.uploadFile(file, orderId)
        
        // Save to database
        const { data: doc, error } = await supabase
          .from('documents')
          .insert({
            order_id: orderId,
            file_name: file.name,
            file_url: url,
            file_type: file.type,
            file_size: file.size,
            storage_path: path
          })
          .select()
          .single()
        
        if (error) throw error
        
        newDocs.push(doc)
      } catch (err: any) {
        console.error('Error uploading file:', err)
        alert(`Error al subir ${file.name}: ${err.message}`)
      }
    }
    
    setUploading(false)
    setUploadProgress('')
    
    if (newDocs.length > 0) {
      onDocumentsChange([...documents, ...newDocs])
    }
  }

  const handleDelete = async (doc: Document) => {
    if (!confirm(`¿Eliminar ${doc.file_name}?`)) return
    
    try {
      // Delete from Storage
      await storageService.deleteFile(doc.storage_path)
      
      // Delete from database
      const { error } = await supabase
        .from('documents')
        .delete()
        .eq('id', doc.id)
      
      if (error) throw error
      
      onDocumentsChange(documents.filter(d => d.id !== doc.id))
    } catch (err: any) {
      console.error('Error deleting file:', err)
      alert(`Error al eliminar: ${err.message}`)
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={18} color="#6366f1" />
          <h3 className="card-title">Documentos y Fotos</h3>
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
          onClick={() => !uploading && fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? '#6366f1' : uploading ? '#10b981' : '#374151'}`,
            borderRadius: '0.5rem',
            padding: '1.5rem',
            textAlign: 'center',
            cursor: uploading ? 'not-allowed' : 'pointer',
            backgroundColor: isDragging ? 'rgba(99, 102, 241, 0.05)' : uploading ? 'rgba(16, 185, 129, 0.05)' : 'transparent',
            transition: 'all 0.2s ease',
            marginBottom: documents.length > 0 ? '1.5rem' : 0,
            opacity: uploading ? 0.7 : 1
          }}
        >
          {uploading ? (
            <>
              <Loader2 size={32} color="#10b981" style={{ marginBottom: '0.75rem', animation: 'tr-spin 1s linear infinite' }} />
              <p style={{ color: '#10b981', marginBottom: '0.5rem' }}>
                {uploadProgress}
              </p>
            </>
          ) : (
            <>
              <Upload size={32} color="#64748b" style={{ marginBottom: '0.75rem' }} />
              <p style={{ color: '#a0aec0', marginBottom: '0.5rem' }}>
                Arrastra archivos aquí o haz clic para seleccionar
              </p>
              <p style={{ color: '#64748b', fontSize: '0.75rem' }}>
                Imágenes, PDF (máx. 10MB)
              </p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            accept="image/*,.pdf"
            disabled={uploading}
          />
        </div>

        {/* Documents Grid */}
        {documents.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem' }}>
            {documents.map((doc) => {
              const FileIcon = getFileIcon(doc.file_type)
              const isImage = doc.file_type.startsWith('image/')
              
              return (
                <div 
                  key={doc.id}
                  style={{
                    backgroundColor: '#1e293b',
                    borderRadius: '0.5rem',
                    overflow: 'hidden',
                    position: 'relative'
                  }}
                >
                  {/* Preview */}
                  {isImage ? (
                    <img 
                      src={doc.file_url} 
                      alt={doc.file_name}
                      style={{
                        width: '100%',
                        height: '120px',
                        objectFit: 'cover'
                      }}
                    />
                  ) : (
                    <div style={{
                      width: '100%',
                      height: '120px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: 'rgba(99, 102, 241, 0.1)'
                    }}>
                      <FileIcon size={48} color="#6366f1" />
                    </div>
                  )}
                  
                  {/* Info */}
                  <div style={{ padding: '0.75rem' }}>
                    <p style={{ 
                      fontSize: '0.875rem',
                      fontWeight: 500, 
                      color: '#f8fafc', 
                      marginBottom: '0.25rem',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis'
                    }}>
                      {doc.file_name}
                    </p>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {formatFileSize(doc.file_size)}
                      </span>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <a
                          href={doc.file_url}
                          download
                          className="btn btn-sm btn-outline"
                          style={{ padding: '0.25rem' }}
                          title="Descargar"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download size={14} />
                        </a>
                        <button
                          className="btn btn-sm btn-outline"
                          style={{ padding: '0.25rem', color: '#dc2626' }}
                          onClick={() => handleDelete(doc)}
                          title="Eliminar"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
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
