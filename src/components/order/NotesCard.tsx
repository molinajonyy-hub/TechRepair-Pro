import { MessageSquare, Send, Trash2, User } from 'lucide-react'
import { useState } from 'react'

interface Note {
  id: string
  author: string
  text: string
  is_internal: boolean
  created_at: string
}

interface NotesCardProps {
  notes: Note[]
  currentUser?: string
  onAddNote?: (note: { text: string; is_internal: boolean }) => void
  onDeleteNote?: (id: string) => void
}

export function NotesCard({ 
  notes, 
  currentUser: _currentUser = 'Técnico', 
  onAddNote,
  onDeleteNote 
}: NotesCardProps) {
  const [newNote, setNewNote] = useState('')
  const [isInternal, setIsInternal] = useState(true)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!newNote.trim() || !onAddNote) return

    onAddNote({
      text: newNote,
      is_internal: isInternal
    })
    setNewNote('')
  }

  const internalNotes = notes.filter(n => n.is_internal)
  const externalNotes = notes.filter(n => !n.is_internal)

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <MessageSquare size={18} color="#6366f1" />
        <h3 className="card-title">Notas y Comunicaciones</h3>
      </div>
      <div className="card-body">
        {/* Add Note Form */}
        <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem' }}>
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            className="form-control"
            rows={3}
            placeholder="Agregar una nota..."
            style={{ marginBottom: '0.75rem' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#a0aec0', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isInternal}
                onChange={(e) => setIsInternal(e.target.checked)}
              />
              Nota interna (no visible para cliente)
            </label>
            <button 
              type="submit" 
              className="btn btn-primary btn-sm"
              disabled={!newNote.trim()}
            >
              <Send size={14} />
              Agregar Nota
            </button>
          </div>
        </form>

        {/* Notes List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {/* External Notes */}
          {externalNotes.length > 0 && (
            <div>
              <h4 style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                Comunicaciones con Cliente
              </h4>
              {externalNotes.map((note) => (
                <NoteItem 
                  key={note.id} 
                  note={note} 
                  onDelete={onDeleteNote}
                />
              ))}
            </div>
          )}

          {/* Internal Notes */}
          {internalNotes.length > 0 && (
            <div>
              <h4 style={{ fontSize: '0.75rem', color: '#64748b', textTransform: 'uppercase', marginBottom: '0.75rem' }}>
                Notas Internas
              </h4>
              {internalNotes.map((note) => (
                <NoteItem 
                  key={note.id} 
                  note={note} 
                  onDelete={onDeleteNote}
                  isInternal
                />
              ))}
            </div>
          )}

          {notes.length === 0 && (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
              <MessageSquare size={48} style={{ opacity: 0.5, marginBottom: '1rem' }} />
              <p>No hay notas registradas</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Note Item Component
function NoteItem({ 
  note, 
  onDelete,
  isInternal = false 
}: { 
  note: Note
  onDelete?: (id: string) => void
  isInternal?: boolean 
}) {
  return (
    <div 
      style={{ 
        padding: '1rem', 
        backgroundColor: isInternal ? '#1e293b' : 'rgba(99, 102, 241, 0.1)', 
        borderRadius: '0.5rem',
        borderLeft: `3px solid ${isInternal ? '#f59e0b' : '#6366f1'}`
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{
            width: '28px',
            height: '28px',
            borderRadius: '50%',
            backgroundColor: isInternal ? '#f59e0b' : '#6366f1',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.75rem',
            color: '#0a0e1a'
          }}>
            <User size={14} />
          </div>
          <div>
            <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#f8fafc' }}>
              {note.author}
            </span>
            {isInternal && (
              <span 
                className="badge badge-warning" 
                style={{ marginLeft: '0.5rem', fontSize: '0.625rem' }}
              >
                Interno
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
            {new Date(note.created_at).toLocaleString('es-ES', { 
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit'
            })}
          </span>
          {onDelete && (
            <button 
              className="btn btn-sm btn-outline" 
              style={{ color: '#dc2626', padding: '0.25rem' }}
              onClick={() => onDelete(note.id)}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <p style={{ color: '#a0aec0', fontSize: '0.875rem', lineHeight: 1.6, margin: 0 }}>
        {note.text}
      </p>
    </div>
  )
}
