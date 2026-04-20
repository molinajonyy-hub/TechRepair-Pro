import { useState, useRef, useEffect } from 'react'
import { Search, X, ChevronDown } from 'lucide-react'

interface AutocompleteProps {
  value: string
  onChange: (value: string) => void
  options: string[]
  placeholder?: string
  label?: string
  required?: boolean
  allowCreate?: boolean
  /** Si retorna un string, ese string se usa como valor final (útil para corregir capitalización) */
  onCreate?: (value: string) => Promise<string | void>
  isLoading?: boolean
  disabled?: boolean
}

export function Autocomplete({
  value,
  onChange,
  options,
  placeholder = 'Buscar o escribir...',
  label,
  required = false,
  allowCreate = true,
  onCreate,
  isLoading = false,
  disabled = false,
}: AutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [filteredOptions, setFilteredOptions] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen && searchTerm) {
      const filtered = options.filter(option =>
        option.toLowerCase().includes(searchTerm.toLowerCase())
      )
      setFilteredOptions(filtered)
    } else {
      setFilteredOptions(options)
    }
  }, [searchTerm, options, isOpen])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = (option: string) => {
    onChange(option)
    setSearchTerm('')
    setIsOpen(false)
  }

  const handleCreate = async () => {
    if (!searchTerm.trim()) return

    setIsCreating(true)
    try {
      // onCreate puede devolver el nombre corregido (ej. capitalización correcta)
      const result = onCreate ? await onCreate(searchTerm.trim()) : undefined
      const finalValue = typeof result === 'string' ? result : searchTerm.trim()
      onChange(finalValue)
      setSearchTerm('')
      setIsOpen(false)
    } catch (error) {
      console.error('Error creating option:', error)
    } finally {
      setIsCreating(false)
    }
  }

  const handleClear = () => {
    onChange('')
    setSearchTerm('')
  }

  const showCreateOption =
    allowCreate &&
    searchTerm.trim() !== '' &&
    !filteredOptions.some(o => o.toLowerCase() === searchTerm.trim().toLowerCase())

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      {label && (
        <label style={{
          display: 'block',
          fontSize: '0.875rem',
          fontWeight: 500,
          color: 'var(--text-primary)',
          marginBottom: '0.5rem'
        }}>
          {label}
          {required && <span style={{ color: '#ef4444', marginLeft: '0.25rem' }}>*</span>}
        </label>
      )}
      
      <div style={{ position: 'relative' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          position: 'relative'
        }}>
          <Search size={18} style={{
            position: 'absolute',
            left: '0.75rem',
            color: 'var(--text-muted)',
            pointerEvents: 'none'
          }} />
          
          <input
            type="text"
            value={isOpen ? searchTerm : value}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => {
              setSearchTerm('')
              setIsOpen(true)
            }}
            placeholder={value || placeholder}
            disabled={disabled || isLoading || isCreating}
            required={required}
            style={{
              width: '100%',
              padding: '0.625rem 2.5rem 0.625rem 2.5rem',
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: '0.5rem',
              color: 'var(--text-primary)',
              outline: 'none',
              fontSize: '0.875rem',
              cursor: disabled ? 'not-allowed' : 'text',
              opacity: disabled || isLoading || isCreating ? 0.6 : 1
            }}
          />
          
          {value && !isOpen && (
            <button
              type="button"
              onClick={handleClear}
              disabled={disabled || isLoading}
              style={{
                position: 'absolute',
                right: '0.75rem',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                padding: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                opacity: disabled ? 0.5 : 1
              }}
            >
              <X size={16} />
            </button>
          )}
          
          {!isOpen && (
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              disabled={disabled || isLoading}
              style={{
                position: 'absolute',
                right: value ? '2.25rem' : '0.75rem',
                background: 'none',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                padding: '0.25rem',
                display: 'flex',
                alignItems: 'center',
                opacity: disabled ? 0.5 : 1
              }}
            >
              <ChevronDown size={16} />
            </button>
          )}
        </div>

        {isOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '0.25rem',
            backgroundColor: 'var(--bg-sidebar)',
            border: '1px solid var(--border-color)',
            borderRadius: '0.5rem',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            maxHeight: '200px',
            overflowY: 'auto',
            zIndex: 1000
          }}>
            {isLoading ? (
              <div style={{
                padding: '1rem',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '0.875rem'
              }}>
                Cargando...
              </div>
            ) : filteredOptions.length === 0 && !showCreateOption ? (
              <div style={{
                padding: '1rem',
                textAlign: 'center',
                color: 'var(--text-muted)',
                fontSize: '0.875rem'
              }}>
                No hay resultados
              </div>
            ) : (
              <>
                {filteredOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => handleSelect(option)}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-primary)',
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      transition: 'background-color 0.2s',
                      borderBottom: '1px solid var(--border-color)'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.backgroundColor = 'var(--hover-bg)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }}
                  >
                    {option}
                  </button>
                ))}
                
                {showCreateOption && (
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={isCreating}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      textAlign: 'left',
                      background: 'none',
                      border: 'none',
                      color: '#6366f1',
                      cursor: isCreating ? 'not-allowed' : 'pointer',
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      opacity: isCreating ? 0.6 : 1
                    }}
                    onMouseEnter={(e) => {
                      if (!isCreating) {
                        e.currentTarget.style.backgroundColor = 'var(--hover-bg)'
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.backgroundColor = 'transparent'
                    }}
                  >
                    {isCreating ? 'Creando...' : `Crear "${searchTerm}"`}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
