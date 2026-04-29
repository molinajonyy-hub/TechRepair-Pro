import { AlertTriangle } from 'lucide-react'
import { AppModal } from './AppModal'
import { AppButton } from './AppButton'

// ─── AppConfirmDialog ─────────────────────────────────────────────────────────
// Diálogo de confirmación estándar para acciones destructivas.
// Uso obligatorio para: eliminar, anular, cancelar definitivamente.

interface AppConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Si isDanger=true, el botón de confirmar es rojo */
  isDanger?: boolean
  loading?: boolean
}

export function AppConfirmDialog({
  isOpen, onClose, onConfirm, title, description,
  confirmLabel = 'Confirmar', cancelLabel = 'Cancelar',
  isDanger = true, loading = false,
}: AppConfirmDialogProps) {
  return (
    <AppModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      icon={<AlertTriangle size={18} />}
      size="sm"
      footer={
        <>
          <AppButton variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </AppButton>
          <AppButton
            variant={isDanger ? 'red' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </AppButton>
        </>
      }
    >
      {description && (
        <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {description}
        </p>
      )}
    </AppModal>
  )
}

// ─── useConfirm hook ──────────────────────────────────────────────────────────
// Alternativa imperativa: const { confirm, ConfirmDialogUI } = useConfirm()

import { useState, useCallback } from 'react'

interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  isDanger?: boolean
}

export function useConfirm() {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise(resolve => {
      setState({ ...opts, resolve })
    })
  }, [])

  const handleClose = () => { state?.resolve(false); setState(null) }
  const handleConfirm = () => { state?.resolve(true); setState(null) }

  const ConfirmDialogUI = state ? (
    <AppConfirmDialog
      isOpen={true}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={state.title}
      description={state.description}
      confirmLabel={state.confirmLabel}
      isDanger={state.isDanger}
    />
  ) : null

  return { confirm, ConfirmDialogUI }
}
