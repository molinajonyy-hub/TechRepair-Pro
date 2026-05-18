import { useState, useEffect } from 'react';
import {
  Plus, Pencil, Trash2, Loader2, CheckCircle2, AlertCircle,
  Power, GripVertical, Wallet,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { paymentButtonService, PaymentButton, NewPaymentButton } from '../../services/paymentButtonService';
import { formatFeeLabel, PAYMENT_TYPE_LABELS, PROVIDER_LABELS, INTEGRATION_LABELS } from '../../services/paymentCalculator';
import { supabase } from '../../lib/supabase';
import { CloseButton } from '../ui/CloseButton';

// ─── Formulario de botón ──────────────────────────────────────────────────────

const EMPTY_BUTTON: Omit<NewPaymentButton, 'business_id'> = {
  name:                      '',
  code:                      '',
  payment_type:              'other',
  provider:                  'manual',
  channel:                   'manual',
  integration_kind:          'none',
  installments:              1,
  fee_percent:               0,
  fee_fixed:                 0,
  vat_percent:               0.21,
  installment_extra_percent: 0,
  absorbs_fee:               false,
  is_active:                 true,
  sort_order:                0,
  color:                     '#6366f1',
  icon:                      'wallet',
  notes:                     '',
};

interface ButtonFormProps {
  initial?: Partial<NewPaymentButton>;
  businessId: string;
  onSave: (btn: PaymentButton) => void;
  onCancel: () => void;
}

function ButtonForm({ initial, businessId, onSave, onCancel }: ButtonFormProps) {
  const [form, setForm] = useState<Omit<NewPaymentButton, 'business_id'>>({
    ...EMPTY_BUTTON,
    ...initial,
  });
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState<string | null>(null);

  const set = (key: keyof typeof form, val: any) =>
    setForm(p => ({ ...p, [key]: val }));

  const handleSave = async () => {
    if (!form.name.trim()) { setError('El nombre es obligatorio'); return; }
    setSaving(true);
    setError(null);
    try {
      let result: PaymentButton;
      if ((initial as any)?.id) {
        result = await paymentButtonService.update((initial as any).id, { ...form, business_id: businessId });
      } else {
        result = await paymentButtonService.create({ ...form, business_id: businessId });
      }
      onSave(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputS: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem',
    backgroundColor: 'rgba(15,23,42,0.8)',
    border: '1px solid rgba(51,65,85,0.6)',
    borderRadius: '0.375rem', color: '#f1f5f9',
    fontSize: '0.875rem', outline: 'none', boxSizing: 'border-box',
  };
  const labelS: React.CSSProperties = {
    display: 'block', fontSize: '0.7rem', fontWeight: 600,
    color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em',
    marginBottom: '0.3rem',
  };
  const rowS: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem',
  };

  return (
    <div style={{
      backgroundColor: '#0f1829',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: '0.75rem',
      padding: '1.25rem',
      display: 'flex', flexDirection: 'column', gap: '0.875rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f1f5f9' }}>
          {(initial as any)?.id ? 'Editar botón' : 'Nuevo botón de cobro'}
        </h3>
        <CloseButton onClick={onCancel} />
      </div>

      {error && (
        <div style={{ display: 'flex', gap: '0.5rem', padding: '0.625rem', backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '0.375rem', color: '#fca5a5', fontSize: '0.8rem' }}>
          <AlertCircle size={14} style={{ flexShrink: 0 }} /> {error}
        </div>
      )}

      {/* Nombre + Color */}
      <div style={rowS}>
        <div>
          <label style={labelS}>Nombre *</label>
          <input type="text" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ej: Débito bancario" style={inputS} />
        </div>
        <div>
          <label style={labelS}>Color</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="color" value={form.color} onChange={e => set('color', e.target.value)} style={{ width: '2.5rem', height: '2.2rem', borderRadius: '0.375rem', border: 'none', cursor: 'pointer', padding: 0 }} />
            <input type="text" value={form.color} onChange={e => set('color', e.target.value)} style={{ ...inputS, fontFamily: 'monospace', fontSize: '0.8rem' }} />
          </div>
        </div>
      </div>

      {/* Tipo + Proveedor */}
      <div style={rowS}>
        <div>
          <label style={labelS}>Tipo de pago</label>
          <select value={form.payment_type} onChange={e => set('payment_type', e.target.value)} style={inputS}>
            {Object.entries(PAYMENT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div>
          <label style={labelS}>Proveedor</label>
          <select value={form.provider} onChange={e => set('provider', e.target.value)} style={inputS}>
            {Object.entries(PROVIDER_LABELS).filter(([k]) => k !== 'mercadopago').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* Canal + Integración */}
      <div style={rowS}>
        <div>
          <label style={labelS}>Canal</label>
          <select value={form.channel} onChange={e => set('channel', e.target.value as any)} style={inputS}>
            <option value="manual">Manual</option>
            <option value="integrated">Integrado</option>
          </select>
        </div>
        <div>
          <label style={labelS}>Tipo integración</label>
          <select value={form.integration_kind} onChange={e => set('integration_kind', e.target.value as any)} style={inputS} disabled={form.channel === 'manual'}>
            {Object.entries(INTEGRATION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </div>

      {/* Tarifas */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.75rem' }}>
        {[
          { key: 'fee_percent',               label: 'Comisión %', placeholder: '0.0399', isPercent: true },
          { key: 'fee_fixed',                 label: 'Cargo fijo $', placeholder: '0' },
          { key: 'vat_percent',               label: 'IVA s/comisión', placeholder: '0.21', isPercent: true },
          { key: 'installment_extra_percent', label: 'Extra cuotas %', placeholder: '0', isPercent: true },
        ].map(f => (
          <div key={f.key}>
            <label style={labelS}>{f.label}</label>
            <input
              type="number" min="0" max={f.isPercent ? '1' : undefined} step="0.0001"
              value={(form as any)[f.key]}
              placeholder={f.placeholder}
              onChange={e => set(f.key as any, parseFloat(e.target.value) || 0)}
              style={{ ...inputS, fontFamily: 'monospace' }}
            />
          </div>
        ))}
      </div>

      {/* Cuotas + Absorbe fee + Orden */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', alignItems: 'end' }}>
        <div>
          <label style={labelS}>Cuotas</label>
          <input type="number" min="1" max="36" value={form.installments} onChange={e => set('installments', parseInt(e.target.value) || 1)} style={inputS} />
        </div>
        <div>
          <label style={labelS}>Orden visual</label>
          <input type="number" min="0" value={form.sort_order} onChange={e => set('sort_order', parseInt(e.target.value) || 0)} style={inputS} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.1rem' }}>
          <input
            type="checkbox"
            checked={form.absorbs_fee}
            onChange={e => set('absorbs_fee', e.target.checked)}
            style={{ accentColor: '#6366f1' }}
          />
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Negocio absorbe fee</span>
        </label>
      </div>

      {/* Notas */}
      <div>
        <label style={labelS}>Notas internas</label>
        <input type="text" value={form.notes ?? ''} onChange={e => set('notes', e.target.value)} placeholder="Descripción opcional..." style={inputS} />
      </div>

      <div style={{ display: 'flex', gap: '0.625rem', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ padding: '0.5rem 1rem', backgroundColor: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.375rem', color: '#94a3b8', cursor: 'pointer', fontSize: '0.8rem' }}>
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '0.5rem 1.25rem', backgroundColor: saving ? 'rgba(99,102,241,0.5)' : '#6366f1',
            border: 'none', borderRadius: '0.375rem', color: '#fff',
            cursor: saving ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: '0.8rem',
            display: 'flex', alignItems: 'center', gap: '0.375rem',
          }}
        >
          {saving ? <><Loader2 size={13} style={{ animation: 'tr-spin 1s linear infinite' }} /> Guardando...</> : <><CheckCircle2 size={13} /> Guardar</>}
        </button>
      </div>
    </div>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function PaymentMethodSettings() {
  const { businessId } = useAuth();

  const [buttons, setButtons]     = useState<PaymentButton[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [editing, setEditing]     = useState<PaymentButton | null>(null);
  const [deleting, setDeleting]   = useState<string | null>(null);

  const reload = async () => {
    if (!businessId) return;
    setLoading(true);
    try {
      // Consultar mp_accounts y payment_method_buttons directamente — más confiable que el Edge Function
      const btnsRes = await supabase
        .from('payment_method_buttons')
        .select('*')
        .eq('business_id', businessId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      setButtons((btnsRes.data || []) as PaymentButton[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [businessId]);



  const handleToggle = async (id: string, current: boolean) => {
    await paymentButtonService.toggle(id, !current);
    setButtons(prev => prev.map(b => b.id === id ? { ...b, is_active: !current } : b));
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este botón de cobro? No se puede deshacer.')) return;
    setDeleting(id);
    try {
      await paymentButtonService.delete(id);
      setButtons(prev => prev.filter(b => b.id !== id));
    } finally {
      setDeleting(null);
    }
  };

  const sectionS: React.CSSProperties = {
    backgroundColor: '#0f1829',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: '0.75rem',
    overflow: 'hidden',
  };
  const headerS: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '1rem 1.25rem',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>


      {/* ── Botones de cobro ─────────────────────────────────────────── */}
      <div style={sectionS}>
        <div style={headerS}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
            <Wallet size={16} style={{ color: '#818cf8' }} />
            <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f1f5f9' }}>
              Botones de cobro
            </span>
            <span style={{ fontSize: '0.7rem', color: '#475569', backgroundColor: 'rgba(255,255,255,0.06)', padding: '0.15rem 0.5rem', borderRadius: '9999px' }}>
              {buttons.length}
            </span>
          </div>
          <button
            onClick={() => { setEditing(null); setShowForm(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.4rem 0.875rem', backgroundColor: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', borderRadius: '0.375rem', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' }}
          >
            <Plus size={14} /> Nuevo botón
          </button>
        </div>

        {/* Formulario inline */}
        {showForm && businessId && (
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <ButtonForm
              businessId={businessId}
              initial={editing ?? undefined}
              onSave={saved => {
                setButtons(prev =>
                  editing
                    ? prev.map(b => b.id === saved.id ? saved : b)
                    : [saved, ...prev]
                );
                setShowForm(false);
                setEditing(null);
              }}
              onCancel={() => { setShowForm(false); setEditing(null); }}
            />
          </div>
        )}

        {/* Lista */}
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
            <Loader2 size={20} style={{ color: '#6366f1', animation: 'tr-spin 1s linear infinite' }} />
          </div>
        ) : buttons.length === 0 ? (
          <div style={{ padding: '2.5rem', textAlign: 'center', color: '#475569', fontSize: '0.85rem' }}>
            No hay botones configurados. Creá el primero para comenzar.
          </div>
        ) : (
          <div>
            {buttons.map(btn => (
              <div
                key={btn.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                  padding: '0.875rem 1.25rem',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  opacity: btn.is_active ? 1 : 0.45,
                }}
              >
                <GripVertical size={14} style={{ color: '#334155', cursor: 'grab', flexShrink: 0 }} />

                {/* Color dot */}
                <div style={{ width: '0.625rem', height: '0.625rem', borderRadius: '50%', backgroundColor: btn.color, flexShrink: 0 }} />

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#f1f5f9' }}>{btn.name}</span>
                    {btn.integration_kind !== 'none' && (
                      <span style={{ fontSize: '0.6rem', color: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.1)', padding: '0.1rem 0.375rem', borderRadius: '0.25rem', fontWeight: 700 }}>
                        {INTEGRATION_LABELS[btn.integration_kind]}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.7rem', color: '#475569', marginTop: '0.1rem' }}>
                    {PROVIDER_LABELS[btn.provider] ?? btn.provider}
                    {' · '}
                    {formatFeeLabel(btn)}
                    {btn.installments > 1 && ` · ${btn.installments} cuotas`}
                  </div>
                </div>

                {/* Acciones */}
                <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                  <button
                    onClick={() => handleToggle(btn.id, btn.is_active)}
                    title={btn.is_active ? 'Desactivar' : 'Activar'}
                    style={{ background: 'none', border: 'none', color: btn.is_active ? '#34d399' : '#475569', cursor: 'pointer', padding: '0.25rem', display: 'flex' }}
                  >
                    <Power size={15} />
                  </button>
                  <button
                    onClick={() => { setEditing(btn); setShowForm(true); }}
                    style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '0.25rem', display: 'flex' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#818cf8')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#64748b')}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    onClick={() => handleDelete(btn.id)}
                    disabled={deleting === btn.id}
                    style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: '0.25rem', display: 'flex' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#64748b')}
                  >
                    {deleting === btn.id
                      ? <Loader2 size={15} style={{ animation: 'tr-spin 1s linear infinite' }} />
                      : <Trash2 size={15} />
                    }
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
