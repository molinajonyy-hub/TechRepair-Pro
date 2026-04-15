import { useState, useRef } from 'react'
import { Upload, Download, X, FileSpreadsheet, AlertCircle, CheckCircle } from 'lucide-react'
import { ExcelService, ExcelRow } from '../services/excelService'

interface ModalImportExcelProps {
  isOpen: boolean
  onClose: () => void
  onImport: (data: ExcelRow[]) => Promise<{ created: number; updated: number }>
  title: string
  requiredColumns: string[]
  downloadTemplate?: () => void
}

export function ModalImportExcel({
  isOpen,
  onClose,
  onImport,
  title,
  requiredColumns,
  downloadTemplate
}: ModalImportExcelProps) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ExcelRow[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ created: number; updated: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!isOpen) return null

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (!selectedFile) return

    setFile(selectedFile)
    setErrors([])
    setResult(null)

    try {
      const importResult = await ExcelService.importFromExcel<ExcelRow>(
        selectedFile,
        requiredColumns
      )

      if (!importResult.success) {
        setErrors(importResult.errors)
        setPreview([])
        return
      }

      // Normalizar datos
      const normalizedData = ExcelService.normalizeData(importResult.data)
      setPreview(normalizedData.slice(0, 10)) // Mostrar solo primeros 10 filas
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Error al procesar el archivo'])
      setPreview([])
    }
  }

  const handleImport = async () => {
    if (!file || preview.length === 0) return

    setImporting(true)
    setErrors([])

    try {
      const importResult = await ExcelService.importFromExcel<ExcelRow>(
        file,
        requiredColumns
      )

      if (!importResult.success) {
        setErrors(importResult.errors)
        return
      }

      const normalizedData = ExcelService.normalizeData(importResult.data)
      const result = await onImport(normalizedData)
      setResult(result)
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Error al importar datos'])
    } finally {
      setImporting(false)
    }
  }

  const handleReset = () => {
    setFile(null)
    setPreview([])
    setErrors([])
    setResult(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleClose = () => {
    handleReset()
    onClose()
  }

  const getPreviewHeaders = () => {
    if (preview.length === 0) return []
    return Object.keys(preview[0])
  }

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.7)',
      zIndex: 10000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem'
    }}>
      <div style={{
        backgroundColor: '#1e293b',
        borderRadius: '0.75rem',
        maxWidth: '900px',
        width: '100%',
        maxHeight: '90vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column'
      }}>
        {/* Header */}
        <div style={{
          padding: '1.5rem',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <FileSpreadsheet size={24} style={{ color: '#6366f1' }} />
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', margin: 0 }}>
              {title}
            </h2>
          </div>
          <button
            onClick={handleClose}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              padding: '0.5rem',
              borderRadius: '0.375rem'
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
          {/* Download template */}
          {downloadTemplate && (
            <div style={{
              marginBottom: '1.5rem',
              padding: '1rem',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              border: '1px solid rgba(99, 102, 241, 0.2)',
              borderRadius: '0.5rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <Download size={20} style={{ color: '#6366f1' }} />
                <div>
                  <p style={{ color: '#e2e8f0', fontSize: '0.875rem', fontWeight: 500, margin: 0 }}>
                    Descargar plantilla
                  </p>
                  <p style={{ color: '#94a3b8', fontSize: '0.75rem', margin: 0 }}>
                    Usa esta plantilla para asegurarte de tener el formato correcto
                  </p>
                </div>
              </div>
              <button
                onClick={downloadTemplate}
                style={{
                  padding: '0.5rem 1rem',
                  backgroundColor: '#6366f1',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  fontWeight: 500
                }}
              >
                Descargar
              </button>
            </div>
          )}

          {/* Upload area */}
          {!file ? (
            <div
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: '2px dashed rgba(99, 102, 241, 0.5)',
                borderRadius: '0.75rem',
                padding: '3rem',
                textAlign: 'center',
                cursor: 'pointer',
                transition: 'all 0.2s ease'
              }}
              onMouseEnter={(e) => e.currentTarget.style.borderColor = '#6366f1'}
              onMouseLeave={(e) => e.currentTarget.style.borderColor = 'rgba(99, 102, 241, 0.5)'}
            >
              <Upload size={48} style={{ color: '#6366f1', marginBottom: '1rem' }} />
              <p style={{ color: '#e2e8f0', fontSize: '1rem', fontWeight: 500, margin: '0 0 0.5rem 0' }}>
                Arrastra tu archivo Excel aquí o haz clic para seleccionar
              </p>
              <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0 }}>
                Formatos aceptados: .xlsx, .xls (máx. 5MB)
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileChange}
                style={{ display: 'none' }}
              />
            </div>
          ) : (
            <div>
              {/* File info */}
              <div style={{
                padding: '1rem',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                border: '1px solid rgba(99, 102, 241, 0.2)',
                borderRadius: '0.5rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '1.5rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <FileSpreadsheet size={20} style={{ color: '#6366f1' }} />
                  <span style={{ color: '#e2e8f0', fontSize: '0.875rem' }}>
                    {file.name}
                  </span>
                  <span style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
                    ({(file.size / 1024).toFixed(2)} KB)
                  </span>
                </div>
                <button
                  onClick={handleReset}
                  style={{
                    padding: '0.25rem 0.5rem',
                    backgroundColor: 'rgba(239, 68, 68, 0.2)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#f87171',
                    borderRadius: '0.375rem',
                    cursor: 'pointer',
                    fontSize: '0.75rem'
                  }}
                >
                  Cambiar
                </button>
              </div>

              {/* Preview */}
              {preview.length > 0 && !result && (
                <div>
                  <h3 style={{ color: '#e2e8f0', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
                    Vista previa (primeras 10 filas)
                  </h3>
                  <div style={{
                    overflowX: 'auto',
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '0.5rem',
                    marginBottom: '1.5rem'
                  }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: 'rgba(99, 102, 241, 0.1)' }}>
                          {getPreviewHeaders().map((header, index) => (
                            <th
                              key={index}
                              style={{
                                padding: '0.75rem',
                                textAlign: 'left',
                                color: '#e2e8f0',
                                fontWeight: 600,
                                borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                              }}
                            >
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, rowIndex) => (
                          <tr key={rowIndex} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                            {getPreviewHeaders().map((header, colIndex) => (
                              <td
                                key={colIndex}
                                style={{
                                  padding: '0.75rem',
                                  color: '#94a3b8'
                                }}
                              >
                                {String(row[header] || '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Errors */}
              {errors.length > 0 && (
                <div style={{
                  padding: '1rem',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.2)',
                  borderRadius: '0.5rem',
                  marginBottom: '1.5rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <AlertCircle size={16} style={{ color: '#f87171' }} />
                    <span style={{ color: '#f87171', fontSize: '0.875rem', fontWeight: 600 }}>
                      Errores
                    </span>
                  </div>
                  {errors.map((error, index) => (
                    <p key={index} style={{ color: '#f87171', fontSize: '0.875rem', margin: '0.25rem 0 0 0' }}>
                      • {error}
                    </p>
                  ))}
                </div>
              )}

              {/* Success result */}
              {result && (
                <div style={{
                  padding: '1rem',
                  backgroundColor: 'rgba(34, 197, 94, 0.1)',
                  border: '1px solid rgba(34, 197, 94, 0.2)',
                  borderRadius: '0.5rem',
                  marginBottom: '1.5rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <CheckCircle size={16} style={{ color: '#22c55e' }} />
                    <span style={{ color: '#22c55e', fontSize: '0.875rem', fontWeight: 600 }}>
                      Importación exitosa
                    </span>
                  </div>
                  <p style={{ color: '#22c55e', fontSize: '0.875rem', margin: 0 }}>
                    {result.created} registros creados, {result.updated} registros actualizados
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '1.5rem',
          borderTop: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: '0.75rem'
        }}>
          <button
            onClick={handleClose}
            style={{
              padding: '0.625rem 1.25rem',
              backgroundColor: 'transparent',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              color: '#94a3b8',
              borderRadius: '0.375rem',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 500
            }}
          >
            Cancelar
          </button>
          {file && preview.length > 0 && !result && (
            <button
              onClick={handleImport}
              disabled={importing || errors.length > 0}
              style={{
                padding: '0.625rem 1.25rem',
                backgroundColor: importing || errors.length > 0 ? 'rgba(99, 102, 241, 0.5)' : '#6366f1',
                border: 'none',
                color: '#ffffff',
                borderRadius: '0.375rem',
                cursor: importing || errors.length > 0 ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500
              }}
            >
              {importing ? 'Importando...' : 'Importar'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
