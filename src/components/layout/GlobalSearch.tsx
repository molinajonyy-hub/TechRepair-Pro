import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X, User, Package, FileText, Wrench, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { tokenize } from '../../utils/searchUtils'

interface SearchResult {
  id: string
  type: 'order' | 'customer' | 'inventory' | 'comprobante'
  title: string
  subtitle?: string
  badge?: string
  path: string
}

function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>
  return ((...args: any[]) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

export function GlobalSearch() {
  const { businessId } = useAuth()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // ⌘K / Ctrl+K to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const performSearch = useCallback(
    debounce(async (q: string, bid: string | null) => {
      if (!q.trim() || q.length < 2 || !bid) {
        setResults([])
        setLoading(false)
        return
      }

      // Normalizar la query: minúsculas + sin acentos + token principal
      const tokens = tokenize(q)
      if (!tokens.length) { setResults([]); setLoading(false); return }
      // Supabase no normaliza acentos — usamos el token normalizado más largo
      const term = tokens.sort((a, b) => b.length - a.length)[0]
      const termPat = `%${term}%`
      const grouped: SearchResult[] = []

      try {
        // Run all searches in parallel
        const [
          customersRes,
          devicesRes,
          inventoryRes,
          comprobantesRes,
          ordersDirectRes,
        ] = await Promise.all([
          // 1. Customers: nombre, teléfono, email, documento, dirección
          supabase
            .from('customers')
            .select('id, name, phone, email, document, customer_type')
            .eq('business_id', bid)
            .or(`name.ilike.${termPat},phone.ilike.${termPat},email.ilike.${termPat},document.ilike.${termPat}`)
            .limit(5),

          // 2. Devices: IMEI, marca, modelo
          supabase
            .from('devices')
            .select('id, brand, model, imei, order_id')
            .or(`imei.ilike.${termPat},brand.ilike.${termPat},model.ilike.${termPat}`)
            .limit(8),

          // 3. Inventory: nombre, código, categoría
          supabase
            .from('inventory')
            .select('id, name, code, category, stock_quantity')
            .eq('business_id', bid)
            .eq('is_active', true)
            .or(`name.ilike.${termPat},code.ilike.${termPat},description.ilike.${termPat},category.ilike.${termPat}`)
            .limit(5),

          // 4. Comprobantes: número, tipo
          supabase
            .from('comprobantes')
            .select('id, numero, tipo, total, estado')
            .eq('business_id', bid)
            .ilike('numero', termPat)
            .limit(4),

          // 5. Órdenes directas por ID (número de orden)
          supabase
            .from('orders')
            .select('id, status, customer_id, customer:customers(name, phone)')
            .eq('business_id', bid)
            .ilike('id', `${termPat}`)
            .limit(3),
        ])

        // Build customer results
        if (customersRes.data && customersRes.data.length > 0) {
          for (const c of customersRes.data) {
            grouped.push({
              id: c.id,
              type: 'customer',
              title: c.name,
              subtitle: [c.phone, c.email].filter(Boolean).join(' · '),
              badge: 'Cliente',
              path: `/customers/${c.id}`,
            })
          }
        }

        // Build order results from devices (by IMEI/brand/model)
        if (devicesRes.data && devicesRes.data.length > 0) {
          const orderIds = [...new Set(devicesRes.data.map((d) => d.order_id).filter(Boolean))]
          if (orderIds.length > 0) {
            const { data: ordersData } = await supabase
              .from('orders')
              .select('id, status, created_at, customer:customers(name)')
              .eq('business_id', bid)
              .in('id', orderIds)
              .limit(5)

            if (ordersData) {
              for (const o of ordersData) {
                const dev = devicesRes.data.find((d) => d.order_id === o.id)
                const deviceLabel = dev
                  ? [dev.brand, dev.model, dev.imei ? `IMEI: ${dev.imei}` : '']
                      .filter(Boolean)
                      .join(' ')
                  : ''
                grouped.push({
                  id: o.id,
                  type: 'order',
                  title: `Orden #${o.id.slice(-6).toUpperCase()}`,
                  subtitle: [
                    (o.customer as any)?.name,
                    deviceLabel,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  badge: 'Orden',
                  path: `/orders/${o.id}`,
                })
              }
            }
          }
        }

        // Also search orders by customer name (if customer results found)
        if (customersRes.data && customersRes.data.length > 0) {
          const customerIds = customersRes.data.map((c) => c.id)
          const { data: ordersFromCustomers } = await supabase
            .from('orders')
            .select('id, status, customer_id, device:devices(brand, model)')
            .eq('business_id', bid)
            .in('customer_id', customerIds)
            .limit(5)

          if (ordersFromCustomers) {
            for (const o of ordersFromCustomers) {
              // Avoid duplicate order entries
              if (!grouped.find((r) => r.id === o.id && r.type === 'order')) {
                const cust = customersRes.data.find((c) => c.id === o.customer_id)
                const dev = o.device as any
                grouped.push({
                  id: o.id,
                  type: 'order',
                  title: `Orden #${o.id.slice(-6).toUpperCase()}`,
                  subtitle: [
                    cust?.name,
                    dev ? `${dev.brand} ${dev.model}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  badge: 'Orden',
                  path: `/orders/${o.id}`,
                })
              }
            }
          }
        }

        // Build inventory results
        if (inventoryRes.data && inventoryRes.data.length > 0) {
          for (const item of inventoryRes.data) {
            grouped.push({
              id: item.id,
              type: 'inventory',
              title: item.name,
              subtitle: [item.code, item.category].filter(Boolean).join(' · '),
              badge: 'Producto',
              path: `/inventory`,
            })
          }
        }

        // Build comprobante results
        if (comprobantesRes.data && comprobantesRes.data.length > 0) {
          for (const c of comprobantesRes.data) {
            const tipoLabel: Record<string, string> = {
              remito: 'Remito',
              factura_a: 'Factura A',
              factura_c: 'Factura C',
              nota_credito: 'Nota de Crédito',
            }
            grouped.push({
              id: c.id,
              type: 'comprobante',
              title: c.numero || `Comprobante`,
              subtitle: [tipoLabel[c.tipo] || c.tipo, c.estado].filter(Boolean).join(' · '),
              badge: 'Comprobante',
              path: `/comprobantes/${c.id}`,
            })
          }
        }

        // Direct order results (by order ID fragment)
        if (ordersDirectRes.data) {
          for (const o of ordersDirectRes.data) {
            if (!grouped.find(r => r.id === o.id && r.type === 'order')) {
              grouped.push({
                id: o.id,
                type: 'order',
                title: `Orden #${o.id.slice(-6).toUpperCase()}`,
                subtitle: (o.customer as any)?.name || '',
                badge: 'Orden',
                path: `/orders/${o.id}`,
              })
            }
          }
        }

        setResults(grouped)
        setOpen(grouped.length > 0 || q.length >= 2)
      } catch (err) {
        console.error('Search error:', err)
      } finally {
        setLoading(false)
      }
    }, 320),
    [businessId]
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setQuery(val)
    setActiveIndex(-1)
    if (val.length >= 2) {
      setLoading(true)
      performSearch(val, businessId)
    } else {
      setResults([])
      setOpen(false)
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      handleSelect(results[activeIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
    }
  }

  const handleSelect = (result: SearchResult) => {
    navigate(result.path)
    setQuery('')
    setResults([])
    setOpen(false)
    setActiveIndex(-1)
    inputRef.current?.blur()
  }

  const typeIcon = (type: SearchResult['type']) => {
    switch (type) {
      case 'order': return <Wrench size={14} style={{ color: '#60a5fa' }} />
      case 'customer': return <User size={14} style={{ color: '#34d399' }} />
      case 'inventory': return <Package size={14} style={{ color: '#fb923c' }} />
      case 'comprobante': return <FileText size={14} style={{ color: '#a78bfa' }} />
    }
  }

  const badgeColor = (type: SearchResult['type']) => {
    switch (type) {
      case 'order': return { background: 'rgba(96,165,250,0.15)', color: '#60a5fa' }
      case 'customer': return { background: 'rgba(52,211,153,0.15)', color: '#34d399' }
      case 'inventory': return { background: 'rgba(251,146,60,0.15)', color: '#fb923c' }
      case 'comprobante': return { background: 'rgba(167,139,250,0.15)', color: '#a78bfa' }
    }
  }

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      {/* Input */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {loading ? (
          <Loader2 size={16} style={{
            position: 'absolute', left: '0.75rem',
            color: 'var(--text-muted)',
            animation: 'spin 1s linear infinite',
          }} />
        ) : (
          <Search size={16} style={{
            position: 'absolute', left: '0.75rem',
            color: 'var(--text-muted)',
            pointerEvents: 'none',
          }} />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (results.length > 0) setOpen(true) }}
          placeholder="Buscar clientes, órdenes, IMEI, productos... (⌘K)"
          style={{
            backgroundColor: 'var(--input-bg)',
            border: '1px solid var(--input-border)',
            borderRadius: '0.75rem',
            padding: '0.625rem 2.25rem 0.625rem 2.25rem',
            color: 'var(--text-primary)',
            fontSize: '0.875rem',
            width: '300px',
            outline: 'none',
            boxShadow: 'var(--shadow-sm)',
            transition: 'border-color 0.2s, box-shadow 0.2s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--input-focus-border)'
          }}
          onMouseLeave={(e) => {
            if (document.activeElement !== e.currentTarget) {
              e.currentTarget.style.borderColor = 'var(--input-border)'
            }
          }}
          onBlurCapture={(e) => {
            e.currentTarget.style.borderColor = 'var(--input-border)'
            e.currentTarget.style.boxShadow = 'var(--shadow-sm)'
          }}
          onFocusCapture={(e) => {
            e.currentTarget.style.borderColor = 'var(--input-focus-border)'
            e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-primary-light)'
          }}
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setResults([]); setOpen(false); inputRef.current?.focus() }}
            style={{
              position: 'absolute', right: '0.65rem',
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--text-muted)', display: 'flex', alignItems: 'center', padding: 0,
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {open && results.length > 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.5rem)',
            left: 0,
            width: '420px',
            maxHeight: '420px',
            overflowY: 'auto',
            background: 'var(--bg-card, #111827)',
            border: '1px solid var(--border-color, #1e293b)',
            borderRadius: '0.875rem',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            zIndex: 1000,
            padding: '0.5rem',
          }}
        >
          {results.map((result, idx) => (
            <button
              key={`${result.type}-${result.id}`}
              onClick={() => handleSelect(result)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                width: '100%',
                padding: '0.625rem 0.75rem',
                borderRadius: '0.6rem',
                border: 'none',
                background: idx === activeIndex ? 'rgba(255,255,255,0.07)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'background 0.12s',
              }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {/* Icon */}
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: badgeColor(result.type).background,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {typeIcon(result.type)}
              </div>

              {/* Text */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '0.875rem', color: 'var(--text-primary, #f8fafc)',
                  fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {result.title}
                </div>
                {result.subtitle && (
                  <div style={{
                    fontSize: '0.75rem', color: 'var(--text-muted, #64748b)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {result.subtitle}
                  </div>
                )}
              </div>

              {/* Badge */}
              {result.badge && (
                <span style={{
                  fontSize: '0.7rem', fontWeight: 600,
                  padding: '0.2rem 0.5rem', borderRadius: '1rem',
                  flexShrink: 0,
                  ...badgeColor(result.type),
                }}>
                  {result.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* No results */}
      {open && !loading && query.length >= 2 && results.length === 0 && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute', top: 'calc(100% + 0.5rem)',
            left: 0,
            width: '320px',
            background: 'var(--bg-card, #111827)',
            border: '1px solid var(--border-color, #1e293b)',
            borderRadius: '0.875rem',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            zIndex: 1000,
            padding: '1.25rem',
            textAlign: 'center',
            color: 'var(--text-muted, #64748b)',
            fontSize: '0.875rem',
          }}
        >
          <div style={{ marginBottom: '0.375rem', color: '#94a3b8', fontSize: '0.875rem' }}>
            Sin resultados para "{query}"
          </div>
          <div style={{ fontSize: '0.72rem', color: '#475569', lineHeight: 1.7 }}>
            Probá: nombre · teléfono · IMEI · marca/modelo<br />
            número de orden · SKU del producto
          </div>
        </div>
      )}
    </div>
  )
}
