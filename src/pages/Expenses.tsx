import { useState, useEffect } from 'react'
import { Plus, Receipt, Calendar, DollarSign, Wallet, RefreshCw } from 'lucide-react'
import { ModalCrearGasto } from '../components/expenses/ModalCrearGasto'
import { useAuth } from '../contexts/AuthContext'
import { useLoading } from '../contexts/LoadingContext'
import { supabase } from '../lib/supabase'

type Expense = {
  id: string
  description: string
  category: string
  amount: number
  date: string
  supplier?: string
  business_id: string
}

const categories = ['Inventario', 'Operativos', 'Equipamiento', 'Marketing', 'Otros']

export function Expenses() {
  const { businessId, user } = useAuth()
  const { showLoading, hideLoading } = useLoading()
  const [activeFilter, setActiveFilter] = useState('all')
  const [showModal, setShowModal] = useState(false)
  const [creando, setCreando] = useState(false)
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (loading) {
      showLoading('Cargando gastos...')
    } else {
      hideLoading()
    }
  }, [loading, showLoading, hideLoading])

  useEffect(() => {
    if (businessId) {
      loadExpenses()
    }
  }, [businessId])

  const loadExpenses = async () => {
    try {
      setLoading(true)
      let query = supabase.from('expenses').select('*').order('date', { ascending: false })
      if (businessId) query = query.eq('business_id', businessId)
      const { data, error } = await query
      if (error && (error.code === '42703' || error.message?.includes('business_id'))) {
        // fallback: load without business_id filter
        const { data: fallback } = await supabase.from('expenses').select('*').order('date', { ascending: false })
        setExpenses(fallback || [])
      } else {
        setExpenses(data || [])
      }
    } catch (error) {
      console.error('Error loading expenses:', error)
    } finally {
      setLoading(false)
    }
  }

  const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0)

  const handleCrearGasto = async (data: {
    descripcion: string;
    categoria: string;
    monto: number;
    fecha: string;
    proveedor: string;
  }) => {
    setCreando(true)
    try {
      const { error } = await supabase
        .from('expenses')
        .insert({
          description: data.descripcion,
          category: data.categoria,
          amount: data.monto,
          date: data.fecha,
          business_id: businessId
        })
      
      if (error) throw error
      
      setShowModal(false)
      loadExpenses()
    } catch (error) {
      console.error('Error creando gasto:', error)
    } finally {
      setCreando(false)
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.875rem' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '0.75rem',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(139,92,246,0.2))',
            border: '1px solid rgba(99,102,241,0.3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
          }}>
            <Receipt size={22} style={{ color: '#818cf8' }} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f8fafc' }}>Gastos</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#475569' }}>Registra y controla todos los gastos del negocio</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button onClick={loadExpenses} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.875rem',
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8', borderRadius: '0.5rem', cursor: 'pointer', fontWeight: 500, fontSize: '0.8rem'
          }}>
            <RefreshCw size={15} />
            Actualizar
          </button>
          <button onClick={() => setShowModal(true)} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.625rem 1.25rem',
            background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
            border: 'none', color: '#ffffff', borderRadius: '0.625rem',
            cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem',
            boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
          }}>
            <Plus size={16} />
            Nuevo Gasto
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40vh' }}>
          <RefreshCw size={32} className="animate-spin" style={{ color: '#6366f1' }} />
        </div>
      ) : (
        <>
      {/* Summary Card */}
      <div style={{
        marginBottom: '1.5rem',
        padding: '1.5rem',
        backgroundColor: '#0f1829',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: '0.75rem',
        position: 'relative',
        overflow: 'hidden'
      }}>
        <div style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '120px',
          height: '120px',
          background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, transparent 70%)',
          borderRadius: '0 0.75rem 0 0'
        }} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              width: '40px',
              height: '40px',
              borderRadius: '0.5rem',
              backgroundColor: 'rgba(239, 68, 68, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <Receipt size={20} style={{ color: '#ef4444' }} />
            </div>
            <span style={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 500 }}>Total Gastos</span>
          </div>
          <h2 style={{ fontSize: '2rem', fontWeight: 700, color: '#ef4444', margin: '0 0 0.5rem 0' }}>
            ${totalExpenses.toLocaleString()}
          </h2>
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            {expenses.length} {expenses.length === 1 ? 'gasto registrado' : 'gastos registrados'}
          </p>
        </div>
      </div>

      {/* Empty State */}
      {expenses.length === 0 ? (
        <div style={{
          padding: '4rem 2rem',
          backgroundColor: '#0f1829',
          border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: '0.75rem',
          textAlign: 'center'
        }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            backgroundColor: '#1e293b',
            margin: '0 auto 1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <Wallet size={32} style={{ color: '#64748b' }} />
          </div>
          <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '0.5rem' }}>
            Todavía no tenés gastos
          </h3>
          <p style={{ color: '#94a3b8', fontSize: '0.9375rem', marginBottom: '1.5rem', maxWidth: '400px', margin: '0 auto 1.5rem' }}>
            Comenzá registrando tu primer gasto para controlar los egresos del negocio.
          </p>
          <button
            onClick={() => setShowModal(true)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.75rem 1.5rem',
              background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '0.625rem',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.875rem',
              boxShadow: '0 4px 12px rgba(99,102,241,0.35)'
            }}
          >
            <Plus size={16} />
            Registrar Primer Gasto
          </button>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div style={{
            marginBottom: '1.5rem',
            padding: '1rem',
            backgroundColor: '#0f1829',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '0.75rem',
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap'
          }}>
            <button
              onClick={() => setActiveFilter('all')}
              style={{
                padding: '0.5rem 1rem',
                background: activeFilter === 'all' ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : undefined,
                backgroundColor: activeFilter === 'all' ? undefined : 'rgba(255,255,255,0.04)',
                border: activeFilter === 'all' ? 'none' : '1px solid rgba(255,255,255,0.08)',
                color: activeFilter === 'all' ? '#ffffff' : '#94a3b8',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontWeight: 500,
                fontSize: '0.875rem'
              }}
            >
              Todos
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveFilter(cat)}
                style={{
                  padding: '0.5rem 1rem',
                  background: activeFilter === cat ? 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)' : undefined,
                  backgroundColor: activeFilter === cat ? undefined : 'rgba(255,255,255,0.04)',
                  border: activeFilter === cat ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  color: activeFilter === cat ? '#ffffff' : '#94a3b8',
                  borderRadius: '0.375rem',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  fontWeight: 500,
                  fontSize: '0.875rem'
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          <div style={{
            backgroundColor: '#0f1829',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '0.75rem',
            overflow: 'hidden'
          }}>
            <div style={{ padding: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <th style={{ 
                      padding: '1rem', 
                      textAlign: 'left', 
                      fontSize: '0.875rem', 
                      fontWeight: 500, 
                      color: '#94a3b8' 
                    }}>
                      Gasto
                    </th>
                    <th style={{ 
                      padding: '1rem', 
                      textAlign: 'left', 
                      fontSize: '0.875rem', 
                      fontWeight: 500, 
                      color: '#94a3b8' 
                    }}>
                      Categoría
                    </th>
                    <th style={{ 
                      padding: '1rem', 
                      textAlign: 'left', 
                      fontSize: '0.875rem', 
                      fontWeight: 500, 
                      color: '#94a3b8' 
                    }}>
                      Proveedor
                    </th>
                    <th style={{ 
                      padding: '1rem', 
                      textAlign: 'left', 
                      fontSize: '0.875rem', 
                      fontWeight: 500, 
                      color: '#94a3b8' 
                    }}>
                      Fecha
                    </th>
                    <th style={{ 
                      padding: '1rem', 
                      textAlign: 'right', 
                      fontSize: '0.875rem', 
                      fontWeight: 500, 
                      color: '#94a3b8' 
                    }}>
                      Monto
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {expenses
                    .filter(e => activeFilter === 'all' || e.category === activeFilter)
                    .map((expense) => (
                    <tr key={expense.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '0.375rem',
                            backgroundColor: 'rgba(239, 68, 68, 0.2)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}>
                            <Receipt size={16} style={{ color: '#ef4444' }} />
                          </div>
                          <span style={{ color: '#ffffff', fontWeight: 500, fontSize: '0.875rem' }}>{expense.description}</span>
                        </div>
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <span style={{
                          padding: '0.25rem 0.75rem',
                          backgroundColor: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#94a3b8',
                          borderRadius: '9999px',
                          fontSize: '0.75rem',
                          fontWeight: 500
                        }}>
                          {expense.category}
                        </span>
                      </td>
                      <td style={{ padding: '1rem', color: '#94a3b8', fontSize: '0.875rem' }}>
                        {expense.supplier || '-'}
                      </td>
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#64748b', fontSize: '0.875rem' }}>
                          <Calendar size={14} />
                          {new Date(expense.date).toLocaleDateString('es-AR', {
                            day: '2-digit',
                            month: 'short',
                            year: 'numeric'
                          })}
                        </div>
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
                          <DollarSign size={16} style={{ color: '#ef4444' }} />
                          <span style={{ fontWeight: 600, color: '#ef4444', fontSize: '0.875rem' }}>
                            ${expense.amount.toLocaleString()}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Modal Crear Gasto */}
      <ModalCrearGasto
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        onCrear={handleCrearGasto}
        onSuccess={() => { setShowModal(false); loadExpenses() }}
        loading={creando}
        businessId={businessId}
        userId={user?.id}
      />
      </>
      )}
    </div>
  )
}
