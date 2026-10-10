import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { productService, type ProductVariant } from '../../services/productService'
import './product-variants.css'

interface Props {
  isOpen: boolean
  productId: string
  productName: string
  businessId: string
  allowOutOfStock?: boolean
  onSelect: (variant: ProductVariant, inventoryItemId: string) => void
  onClose: () => void
}

export function VariantSelector({ isOpen, productId, productName, businessId, allowOutOfStock = false, onSelect, onClose }: Props) {
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!isOpen) return
    const previousFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previousFocus?.focus()
  }, [isOpen])
  useEffect(() => {
    if (!isOpen) return
    let alive = true
    setLoading(true); setError(''); setVariants([])
    productService.getVariants(productId, businessId).then(rows => {
      if (alive) setVariants(rows)
    }).catch(() => {
      if (alive) setError('No pudimos confirmar las variantes y su stock.')
    }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [isOpen, productId, businessId, attempt])
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0], last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])
  if (!isOpen) return null
  return <div className="variant-selector-overlay" onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className="variant-selector" role="dialog" aria-modal="true" aria-label="Seleccionar variante">
      <header><div><h3>Seleccionar variante</h3><p>{productName}</p></div>
        <button type="button" onClick={onClose} aria-label="Cerrar selector"><X size={20} /></button></header>
      <div className="variant-selector-list">
        {loading && <p role="status">Cargando variantes...</p>}
        {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setAttempt(n => n + 1)}>Reintentar</button></div>}
        {!loading && !error && !variants.length && <p>No hay variantes activas disponibles.</p>}
        {!loading && !error && variants.map(variant => {
          const stock = variant.inventory?.stock_quantity
          const disabled = !variant.inventory_item_id || stock == null || (!allowOutOfStock && stock <= 0)
          return <button className="variant-selector-option" type="button" key={variant.id} disabled={disabled}
            data-testid="variant-selector-option" data-inventory-id={variant.inventory_item_id}
            onClick={() => { if (!disabled && variant.inventory_item_id) onSelect(variant, variant.inventory_item_id) }}>
            <span><strong>{variant.name}</strong><small>SKU: {variant.sku || '—'}</small></span>
            <span><strong>${variant.inventory?.sale_price.toLocaleString('es-AR')}</strong>
              <small>{stock == null ? 'Stock sin confirmar' : stock <= 0 ? `Sin stock (${stock})` : `${stock} en stock`}</small></span>
          </button>
        })}
      </div>
      <footer><button type="button" onClick={onClose}>Cerrar sin seleccionar</button></footer>
    </section>
  </div>
}
