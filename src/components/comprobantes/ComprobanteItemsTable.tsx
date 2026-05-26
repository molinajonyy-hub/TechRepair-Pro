import { useState } from 'react';
import { Plus, Trash2, Edit2, Check, X, Package } from 'lucide-react';
import { ComprobanteItem } from '../../hooks/useComprobantes';
import { parseUnitQuantity, formatUnitQuantity } from '../../utils/quantityUtils';

interface ComprobanteItemsTableProps {
  items: ComprobanteItem[];
  editable?: boolean;
  onAddItem?: (item: { descripcion: string; cantidad: number; precio_unitario: number }) => void;
  onUpdateItem?: (itemId: string, updates: Partial<ComprobanteItem>) => void;
  onDeleteItem?: (itemId: string) => void;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(value);
}

const INPUT_STYLE = {
  padding: '0.25rem 0.5rem',
  background: 'var(--input-bg)',
  border: '1px solid var(--accent-primary)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: '0.875rem',
  outline: 'none',
  width: '100%',
};

export function ComprobanteItemsTable({
  items,
  editable = false,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
}: ComprobanteItemsTableProps) {
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<ComprobanteItem>>({});
  const [newItem, setNewItem] = useState({ descripcion: '', cantidad: 1, precio_unitario: 0 });
  const [showAddForm, setShowAddForm] = useState(false);

  const handleEdit = (item: ComprobanteItem) => {
    setEditingItem(item.id);
    setEditForm({ descripcion: item.descripcion, cantidad: item.cantidad, precio_unitario: item.precio_unitario });
  };

  const handleSave = (itemId: string) => {
    onUpdateItem?.(itemId, editForm);
    setEditingItem(null);
  };

  const handleAdd = () => {
    if (newItem.descripcion.trim()) {
      onAddItem?.(newItem);
      setNewItem({ descripcion: '', cantidad: 1, precio_unitario: 0 });
      setShowAddForm(false);
    }
  };

  return (
    <div style={{ borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
      {/* Table header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.75rem 1rem',
        background: 'var(--bg-tertiary)',
        borderBottom: '1px solid var(--border-color)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Package size={15} style={{ color: 'var(--accent-primary)' }} />
          <span style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.875rem' }}>
            Detalle de ítems
          </span>
          <span style={{
            fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.4rem',
            borderRadius: 9999, background: 'var(--accent-primary-light)', color: 'var(--accent-primary)',
          }}>
            {items.length}
          </span>
        </div>
        {editable && !showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="btn btn-primary btn-sm"
          >
            <Plus size={13} /> Agregar ítem
          </button>
        )}
      </div>

      {/* Add item form */}
      {showAddForm && editable && (
        <div style={{
          padding: '0.875rem 1rem',
          background: 'var(--accent-primary-subtle)',
          borderBottom: '1px solid var(--border-color)',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 120px auto', gap: '0.75rem', alignItems: 'flex-end' }}>
            <div>
              <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: '0.25rem' }}>Descripción</label>
              <input
                type="text"
                value={newItem.descripcion}
                onChange={e => setNewItem({ ...newItem, descripcion: e.target.value })}
                placeholder="Descripción del ítem..."
                style={INPUT_STYLE}
                onKeyDown={e => e.key === 'Enter' && handleAdd()}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: '0.25rem' }}>Cantidad</label>
              <input
                type="number"
                value={newItem.cantidad}
                onChange={e => setNewItem({ ...newItem, cantidad: parseUnitQuantity(e.target.value) })}
                min="1" step="1"
                style={INPUT_STYLE}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem', marginBottom: '0.25rem' }}>Precio unit.</label>
              <input
                type="number"
                value={newItem.precio_unitario}
                onChange={e => setNewItem({ ...newItem, precio_unitario: Number(e.target.value) })}
                min="0" step="0.01"
                style={INPUT_STYLE}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.375rem' }}>
              <button
                onClick={handleAdd}
                style={{
                  width: 32, height: 32, borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: 'var(--success-light)', color: 'var(--success)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                style={{
                  width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-color)', cursor: 'pointer',
                  background: 'var(--bg-card)', color: 'var(--text-muted)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--bg-surface)' }}>
              {['#', 'Descripción', 'Cantidad', 'Precio unit.', 'Subtotal'].map((h, i) => (
                <th
                  key={h}
                  style={{
                    padding: '0.5rem 0.875rem',
                    fontSize: '0.7rem', fontWeight: 600,
                    textTransform: 'uppercase', letterSpacing: '0.08em',
                    color: 'var(--text-subtle)',
                    textAlign: i === 0 ? 'center' : i <= 1 ? 'left' : 'right',
                    borderBottom: '1px solid var(--border-color)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ))}
              {editable && (
                <th style={{ padding: '0.5rem 0.875rem', fontSize: '0.7rem', color: 'var(--text-subtle)', textAlign: 'center', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>
                  Acciones
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr
                key={item.id}
                style={{ borderBottom: '1px solid var(--border-subtle)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover-bg)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* # */}
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.8rem' }}>
                  {index + 1}
                </td>

                {/* Descripción */}
                <td style={{ padding: '0.625rem 0.875rem' }}>
                  {editingItem === item.id ? (
                    <input
                      type="text"
                      value={editForm.descripcion || ''}
                      onChange={e => setEditForm({ ...editForm, descripcion: e.target.value })}
                      style={INPUT_STYLE}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontSize: '0.875rem' }}>
                      {item.descripcion}
                    </span>
                  )}
                </td>

                {/* Cantidad */}
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  {editingItem === item.id ? (
                    <input
                      type="number"
                      value={editForm.cantidad || 0}
                      onChange={e => setEditForm({ ...editForm, cantidad: parseUnitQuantity(e.target.value) })}
                      min="1" step="1"
                      style={{ ...INPUT_STYLE, width: 80, textAlign: 'right' }}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{formatUnitQuantity(item.cantidad)}</span>
                  )}
                </td>

                {/* Precio unit. */}
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  {editingItem === item.id ? (
                    <input
                      type="number"
                      value={editForm.precio_unitario || 0}
                      onChange={e => setEditForm({ ...editForm, precio_unitario: Number(e.target.value) })}
                      min="0" step="0.01"
                      style={{ ...INPUT_STYLE, width: 110, textAlign: 'right' }}
                    />
                  ) : (
                    <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace', fontSize: '0.875rem' }}>
                      {formatCurrency(item.precio_unitario)}
                    </span>
                  )}
                </td>

                {/* Subtotal */}
                <td style={{ padding: '0.625rem 0.875rem', textAlign: 'right' }}>
                  <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', fontWeight: 600, fontSize: '0.875rem' }}>
                    {formatCurrency(item.subtotal)}
                  </span>
                </td>

                {/* Actions */}
                {editable && (
                  <td style={{ padding: '0.625rem 0.875rem', textAlign: 'center' }}>
                    {editingItem === item.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                        <button
                          onClick={() => handleSave(item.id)}
                          style={{ width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--success-light)', color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Check size={13} />
                        </button>
                        <button
                          onClick={() => setEditingItem(null)}
                          style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-color)', cursor: 'pointer', background: 'var(--bg-card)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.375rem' }}>
                        <button
                          onClick={() => handleEdit(item)}
                          style={{ width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--accent-primary-subtle)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Edit2 size={13} />
                        </button>
                        <button
                          onClick={() => onDeleteItem?.(item.id)}
                          style={{ width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'var(--error-subtle)', color: 'var(--error)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}

            {/* Empty state */}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={editable ? 6 : 5}
                  style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-subtle)', fontSize: '0.875rem' }}
                >
                  No hay ítems en este comprobante
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
