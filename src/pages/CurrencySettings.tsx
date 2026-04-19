import { useState, useEffect } from 'react';
import { DollarSign, RefreshCw, Save, History, Cloud, MapPin, Globe } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { currencyService, BusinessSettings, ExchangeRate } from '../services/currencyService';
import { exchangeRateService, DolarSource } from '../services/exchangeRateService';

export function CurrencySettings() {
  const { businessId, isOwner, isAdmin } = useAuth();
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(1000);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rateHistory, setRateHistory] = useState<ExchangeRate[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (businessId) {
      loadSettings();
      loadCurrentRate();
    }
  }, [businessId]);

  const loadSettings = async () => {
    if (!businessId) return;

    try {
      const data = await currencyService.getBusinessSettings();
      if (data) {
        setSettings({ ...data, business_id: data.business_id || businessId });
      } else {
        // Crear configuración por defecto si no existe
        const defaultSettings = await currencyService.upsertBusinessSettings({
          business_id: businessId,
          default_currency: 'ARS',
          show_usd_price: false,
          auto_update_rate: false,
          rate_update_frequency_hours: 24
        });
        setSettings(defaultSettings);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadCurrentRate = async () => {
    if (!businessId) return;

    try {
      const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS');
      setExchangeRate(rate);
    } catch (error) {
      console.error('Error loading rate:', error);
    }
  };

  const loadRateHistory = async () => {
    if (!businessId) return;

    try {
      const history = await currencyService.getExchangeRateHistory(businessId, 'USD', 'ARS');
      setRateHistory(history);
    } catch (error) {
      console.error('Error loading rate history:', error);
    }
  };

  const handleSaveSettings = async () => {
    if (!settings || !businessId) return;

    setSaving(true);
    try {
      const savedSettings = await currencyService.upsertBusinessSettings({
        ...settings,
        business_id: businessId,
      });
      setSettings(savedSettings);
      alert('Configuración guardada exitosamente');
    } catch (error) {
      console.error('Error saving settings:', error);
      const message = error instanceof Error ? error.message : 'Error al guardar configuración';
      alert(message);
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateRate = async () => {
    if (!businessId) return;

    setSaving(true);
    try {
      await currencyService.upsertExchangeRate({
        business_id: businessId,
        base_currency: 'USD',
        target_currency: 'ARS',
        rate: exchangeRate,
        is_manual: true,
        source: 'manual'
      });
      alert('Tipo de cambio actualizado exitosamente');
      loadRateHistory();
    } catch (error) {
      console.error('Error updating rate:', error);
      alert('Error al actualizar tipo de cambio');
    } finally {
      setSaving(false);
    }
  };

  const dolarSource: DolarSource = (settings?.dolar_source as DolarSource) ?? 'nacional'

  const handleUpdateFromAPI = async () => {
    if (!businessId) return;

    setSaving(true);
    try {
      const apiRate = await exchangeRateService.getDolarRate(dolarSource);

      if (!apiRate) {
        alert('No se pudo obtener el tipo de cambio. Verificá tu conexión o intentá más tarde.');
        return;
      }

      const sourceLabel = dolarSource === 'cordoba' ? 'Blue Córdoba (infodolar.com)' : 'Blue Nacional (Bluelytics)'

      await currencyService.upsertExchangeRate({
        business_id: businessId,
        base_currency: 'USD',
        target_currency: 'ARS',
        rate: apiRate,
        is_manual: false,
        source: dolarSource === 'cordoba' ? 'infodolar-cordoba' : 'bluelytics'
      });

      setExchangeRate(apiRate);
      alert(`✅ Cotización actualizada desde ${sourceLabel}:\n$${apiRate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      loadRateHistory();
    } catch (error) {
      console.error('Error updating rate from API:', error);
      alert('Error al actualizar tipo de cambio desde la fuente seleccionada');
    } finally {
      setSaving(false);
    }
  };

  const canManageSettings = isOwner || isAdmin;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <RefreshCw className="animate-spin" size={32} style={{ color: '#6366f1' }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: '#ffffff', marginBottom: '0.5rem' }}>
          Configuración de Moneda
        </h1>
        <p style={{ color: '#94a3b8' }}>
          Configura los tipos de cambio y preferencias de moneda
        </p>
      </div>

      <div style={{ display: 'grid', gap: '2rem', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))' }}>
        {/* Configuración de moneda */}
        <div style={{
          backgroundColor: '#111827',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '0.75rem',
          padding: '1.5rem'
        }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DollarSign size={24} style={{ color: '#6366f1' }} />
            Configuración General
          </h2>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
              Moneda por defecto
            </label>
            <select
              value={settings?.default_currency || 'ARS'}
              onChange={(e) => setSettings({ ...settings!, default_currency: e.target.value })}
              disabled={!canManageSettings}
              style={{
                width: '100%',
                padding: '0.625rem 0.875rem',
                backgroundColor: '#1e293b',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '0.5rem',
                color: '#ffffff',
                outline: 'none',
                cursor: canManageSettings ? 'pointer' : 'not-allowed'
              }}
            >
              <option value="ARS">Pesos Argentinos (ARS)</option>
              <option value="USD">Dólares Estadounidenses (USD)</option>
              <option value="EUR">Euros (EUR)</option>
              <option value="GBP">Libras Esterlinas (GBP)</option>
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', cursor: canManageSettings ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={settings?.show_usd_price || false}
                onChange={(e) => setSettings({ ...settings!, show_usd_price: e.target.checked })}
                disabled={!canManageSettings}
                style={{ cursor: canManageSettings ? 'pointer' : 'not-allowed' }}
              />
              Mostrar precio en USD adicionalmente
            </label>
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem', cursor: canManageSettings ? 'pointer' : 'not-allowed' }}>
              <input
                type="checkbox"
                checked={settings?.auto_update_rate || false}
                onChange={(e) => setSettings({ ...settings!, auto_update_rate: e.target.checked })}
                disabled={!canManageSettings}
                style={{ cursor: canManageSettings ? 'pointer' : 'not-allowed' }}
              />
              Actualizar tipo de cambio automáticamente desde API
            </label>
          </div>

          {/* Selector de fuente del dólar */}
          <div style={{ marginBottom: '1.5rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.75rem', fontWeight: 500 }}>
              Fuente del Dólar Blue
            </label>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              {/* Opción Nacional */}
              <button
                onClick={() => canManageSettings && setSettings({ ...settings!, dolar_source: 'nacional' })}
                disabled={!canManageSettings}
                style={{
                  flex: 1,
                  padding: '0.75rem 1rem',
                  borderRadius: '0.625rem',
                  border: dolarSource === 'nacional'
                    ? '2px solid #6366f1'
                    : '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: dolarSource === 'nacional'
                    ? 'rgba(99,102,241,0.12)'
                    : '#1e293b',
                  color: dolarSource === 'nacional' ? '#a5b4fc' : '#94a3b8',
                  cursor: canManageSettings ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.375rem',
                  transition: 'all 0.18s',
                  opacity: canManageSettings ? 1 : 0.6,
                }}
              >
                <Globe size={20} style={{ color: dolarSource === 'nacional' ? '#818cf8' : '#64748b' }} />
                <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Blue Nacional</span>
                <span style={{ fontSize: '0.6875rem', color: '#64748b', textAlign: 'center', lineHeight: 1.3 }}>
                  Bluelytics API
                </span>
              </button>
              {/* Opción Córdoba */}
              <button
                onClick={() => canManageSettings && setSettings({ ...settings!, dolar_source: 'cordoba' })}
                disabled={!canManageSettings}
                style={{
                  flex: 1,
                  padding: '0.75rem 1rem',
                  borderRadius: '0.625rem',
                  border: dolarSource === 'cordoba'
                    ? '2px solid #10b981'
                    : '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: dolarSource === 'cordoba'
                    ? 'rgba(16,185,129,0.1)'
                    : '#1e293b',
                  color: dolarSource === 'cordoba' ? '#6ee7b7' : '#94a3b8',
                  cursor: canManageSettings ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.375rem',
                  transition: 'all 0.18s',
                  opacity: canManageSettings ? 1 : 0.6,
                }}
              >
                <MapPin size={20} style={{ color: dolarSource === 'cordoba' ? '#34d399' : '#64748b' }} />
                <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>Blue Córdoba</span>
                <span style={{ fontSize: '0.6875rem', color: '#64748b', textAlign: 'center', lineHeight: 1.3 }}>
                  infodolar.com
                </span>
              </button>
            </div>
            {dolarSource === 'cordoba' && (
              <div style={{
                marginTop: '0.625rem',
                padding: '0.5rem 0.75rem',
                backgroundColor: 'rgba(16,185,129,0.07)',
                border: '1px solid rgba(16,185,129,0.2)',
                borderRadius: '0.5rem',
                fontSize: '0.75rem',
                color: '#6ee7b7',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}>
                <MapPin size={13} />
                Valor de venta · Dólar Blue Córdoba · infodolar.com
              </div>
            )}
          </div>

          {canManageSettings && (
            <button
              onClick={handleSaveSettings}
              disabled={saving}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1.25rem',
                backgroundColor: '#4f46e5',
                border: 'none',
                color: '#ffffff',
                borderRadius: '0.5rem',
                cursor: saving ? 'not-allowed' : 'pointer',
                fontWeight: 500,
                opacity: saving ? 0.5 : 1
              }}
            >
              <Save size={18} />
              {saving ? 'Guardando...' : 'Guardar Configuración'}
            </button>
          )}
        </div>

        {/* Tipo de cambio */}
        <div style={{
          backgroundColor: '#111827',
          border: '1px solid rgba(255,255,255,0.05)',
          borderRadius: '0.75rem',
          padding: '1.5rem'
        }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#ffffff', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <RefreshCw size={24} style={{ color: '#6366f1' }} />
            Tipo de Cambio
          </h2>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
              USD a ARS
            </label>
            <input
              type="number"
              step="0.01"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(parseFloat(e.target.value) || 0)}
              disabled={!canManageSettings}
              style={{
                width: '100%',
                padding: '0.625rem 0.875rem',
                backgroundColor: '#1e293b',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: '0.5rem',
                color: '#ffffff',
                outline: 'none',
                fontSize: '1.25rem',
                fontWeight: 600
              }}
            />
          </div>

          <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#64748b' }}>
            Última actualización: {settings?.updated_at ? new Date(settings.updated_at).toLocaleString() : 'N/A'}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            {canManageSettings && (
              <button
                onClick={handleUpdateRate}
                disabled={saving}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  backgroundColor: '#4f46e5',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.5rem',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 500,
                  opacity: saving ? 0.5 : 1
                }}
              >
                <RefreshCw size={18} />
                {saving ? 'Actualizando...' : 'Actualizar Tipo de Cambio'}
              </button>
            )}

            {canManageSettings && (
              <button
                onClick={handleUpdateFromAPI}
                disabled={saving}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.625rem 1.25rem',
                  backgroundColor: dolarSource === 'cordoba' ? '#059669' : '#0284c7',
                  border: 'none',
                  color: '#ffffff',
                  borderRadius: '0.5rem',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: 500,
                  opacity: saving ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                }}
                title={dolarSource === 'cordoba'
                  ? 'Obtener valor de venta Blue Córdoba desde infodolar.com'
                  : 'Obtener Blue Nacional desde Bluelytics API'}
              >
                {dolarSource === 'cordoba' ? <MapPin size={18} /> : <Cloud size={18} />}
                {saving
                  ? 'Actualizando...'
                  : dolarSource === 'cordoba'
                    ? 'Actualizar · Blue Córdoba'
                    : 'Actualizar · Blue Nacional'}
              </button>
            )}

            <button
              onClick={() => {
                setShowHistory(!showHistory);
                if (!showHistory) loadRateHistory();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.625rem 1.25rem',
                backgroundColor: 'transparent',
                border: '1px solid rgba(255,255,255,0.1)',
                color: '#ffffff',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontWeight: 500
              }}
            >
              <History size={18} />
              {showHistory ? 'Ocultar' : 'Ver Historial'}
            </button>
          </div>

          {showHistory && (
            <div style={{ marginTop: '1rem', maxHeight: '200px', overflowY: 'auto' }}>
              {rateHistory.length === 0 ? (
                <div style={{ padding: '1rem', textAlign: 'center', color: '#64748b' }}>
                  No hay historial de tipos de cambio
                </div>
              ) : (
                <div style={{ fontSize: '0.875rem' }}>
                  {rateHistory.map((rate) => (
                    <div
                      key={rate.id}
                      style={{
                        padding: '0.5rem',
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        color: '#94a3b8'
                      }}
                    >
                      <span>${rate.rate.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      <span>{new Date(rate.updated_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
