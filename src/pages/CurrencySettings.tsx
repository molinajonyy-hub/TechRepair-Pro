import { useState, useEffect } from 'react';
import { DollarSign, RefreshCw, Save, History, Cloud, MapPin, Globe, Package, AlertTriangle } from 'lucide-react';
import { Loader } from '../components/ui/Loader';
import { useAuth } from '../contexts/AuthContext';
import { currencyService, BusinessSettings, ExchangeRate } from '../services/currencyService';
import { exchangeRateService, type CordobaRateDetail } from '../services/exchangeRateService';
import {
  type DolarSource,
  type QuoteOutcome,
  DOLAR_SOURCES,
  DOLAR_SOURCE_ORDER,
  DEFAULT_DOLAR_SOURCE,
  MANUAL_RATE_SOURCE_TAG,
  describeRateSource,
  rateSourceSpellings,
} from '../lib/dollar/quoteSource';
import { clearDollarCache } from '../services/dollarRateService';
import { logger } from '../lib/logger';

interface SyncResult {
  updated: number
  skipped: number
  rate: number
  prevRate: number | null
  source: string
  changed: boolean
  timestamp: string
  error?: string
  cordobaDetail?: CordobaRateDetail
}

interface TestResult {
  loading: boolean
  detail: CordobaRateDetail | null
  error: string | null
}

interface LastValidRate {
  rate: number
  updatedAt: string
}

/** Estado visible de la última operación (guardado o consulta de cotización). */
interface StatusBanner {
  kind: 'ok' | 'error' | 'info'
  message: string
}

export function CurrencySettings() {
  const { businessId, isOwner, isAdmin } = useAuth();
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [exchangeRate, setExchangeRate] = useState<number>(1000);
  const [prevRate, setPrevRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [cordobaTest, setCordobaTest] = useState<TestResult>({ loading: false, detail: null, error: null });
  const [lastValidCordoba, setLastValidCordoba] = useState<LastValidRate | null>(null);
  const [status, setStatus] = useState<StatusBanner | null>(null);
  const [reapplyConfirm, setReapplyConfirm] = useState(false);
  const [rateHistory, setRateHistory] = useState<ExchangeRate[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (businessId) {
      loadSettings();
      loadCurrentRate();
      loadLastValidCordoba();
    }
  }, [businessId]);

  const loadSettings = async () => {
    if (!businessId) return;

    try {
      const data = await currencyService.getBusinessSettings();
      if (data) {
        setSettings({ ...data, business_id: data.business_id || businessId });
      } else {
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
      logger.error('INVENTORY', 'Error al cargar configuración de moneda', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Carga el último rate válido de InfoDolar Córdoba para mostrarlo como referencia.
   *
   * Filtra por TODAS las grafías históricas de la columna: la consulta original
   * pedía exactamente 'infodolar-cordoba' y en producción la mayoría de las
   * filas se escribieron como 'INFODOLAR_CORDOBA', así que el bloque
   * "Último valor válido" quedaba vacío casi siempre.
   */
  const loadLastValidCordoba = async () => {
    if (!businessId) return
    try {
      const { data } = await import('../lib/supabase').then(m =>
        m.supabase.from('exchange_rates')
          .select('rate, updated_at')
          .eq('business_id', businessId)
          .eq('base_currency', 'USD')
          .eq('target_currency', 'ARS')
          .in('source', rateSourceSpellings('infodolar-cordoba'))
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      )
      if (data) setLastValidCordoba({ rate: Number(data.rate), updatedAt: data.updated_at })
    } catch { /* silencioso */ }
  }

  const loadCurrentRate = async () => {
    if (!businessId) return;

    try {
      const rate = await currencyService.getCurrentExchangeRate('USD', 'ARS');
      setExchangeRate(rate);
      setPrevRate(rate);  // Inicializar prevRate desde DB — es lo que los productos tienen hoy
    } catch (error) {
      logger.error('INVENTORY', 'Error al cargar cotización actual', error);
    }
  };

  const loadRateHistory = async () => {
    if (!businessId) return;

    try {
      const history = await currencyService.getExchangeRateHistory(businessId, 'USD', 'ARS');
      setRateHistory(history);
    } catch (error) {
      logger.error('INVENTORY', 'Error al cargar historial de cotizaciones', error);
    }
  };

  const handleSaveSettings = async () => {
    if (!settings || !businessId) return;

    setSaving(true);
    setStatus(null);
    try {
      const savedSettings = await currencyService.upsertBusinessSettings({
        ...settings,
        business_id: businessId,
        // Explícita SIEMPRE: la RPC interpreta null como "no cambiar", así que
        // mandarla evita depender de un default del lado del servicio.
        dolar_source: dolarSource,
      });
      setSettings(savedSettings);
      // Se invalida el caché de cotización: la fuente pudo haber cambiado.
      clearDollarCache(businessId);
      setStatus({
        kind: 'ok',
        message: `Configuración guardada. Fuente de cotización: ${DOLAR_SOURCES[savedSettings.dolar_source].label}.`,
      });
    } catch (error) {
      logger.error('INVENTORY', 'Error al guardar configuración de moneda', error);
      const message = error instanceof Error ? error.message : 'No pudimos guardar la configuración.';
      setStatus({ kind: 'error', message });
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
        source: MANUAL_RATE_SOURCE_TAG
      });
      clearDollarCache(businessId);
      loadRateHistory();
      setStatus({ kind: 'ok', message: `Cotización manual aplicada: $${exchangeRate.toLocaleString('es-AR')}.` });
      await syncProductPrices(exchangeRate, MANUAL_RATE_SOURCE_TAG);
    } catch (error) {
      logger.error('INVENTORY', 'Error al actualizar cotización manual', error);
      setStatus({ kind: 'error', message: 'No pudimos guardar la cotización manual.' });
    } finally {
      setSaving(false);
    }
  };

  /** Prueba InfoDolar Córdoba y muestra compra/venta sin aplicar nada. */
  const handleTestCordoba = async () => {
    setCordobaTest({ loading: true, detail: null, error: null })
    const outcome = await exchangeRateService.fetchCordoba()
    if (!outcome.ok) {
      // Mensaje ya redactado para el usuario — nunca el error crudo del proveedor.
      setCordobaTest({ loading: false, detail: null, error: outcome.message })
      return
    }
    setCordobaTest({
      loading: false,
      error:   null,
      detail: {
        compra:    outcome.buy ?? 0,
        venta:     outcome.sell,
        mode:      'venta',
        strategy:  outcome.strategy ?? 'unknown',
        fetchedAt: outcome.fetchedAt,
      },
    })
  }

  /**
   * Sincroniza precios ARS de productos dolarizados con la cotización recibida.
   * Detecta si la cotización cambió realmente; si no cambió, omite el sync (idempotente).
   * force=true omite la comparación — para el botón manual "Reaplicar dólar ahora".
   */
  const syncProductPrices = async (rate: number, source: string, force = false, cordobaDetail?: CordobaRateDetail) => {
    if (!businessId) return
    setSyncing(true)
    try {
      const result = await currencyService.syncDollarizedProducts(businessId, rate, prevRate, source, force)
      setSyncResult({
        updated:      result.updated,
        skipped:      result.skipped,
        rate,
        prevRate,
        source,
        changed:      result.changed,
        timestamp:    new Date().toLocaleString('es-AR'),
        error:        result.error,
        cordobaDetail,
      })
      if (result.changed && !result.error) setPrevRate(rate)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      logger.error('INVENTORY', 'Error en syncProductPrices', e)
      setSyncResult({ updated: 0, skipped: 0, rate, prevRate, source, changed: false, timestamp: new Date().toLocaleString('es-AR'), error: msg })
    } finally {
      setSyncing(false)
    }
  }

  // `settings.dolar_source` ya viene normalizada desde currencyService.
  const dolarSource: DolarSource = settings?.dolar_source ?? DEFAULT_DOLAR_SOURCE
  const sourceInfo = DOLAR_SOURCES[dolarSource]

  const handleUpdateFromAPI = async () => {
    if (!businessId) return;

    setSaving(true);
    setStatus(null);
    try {
      // Se consulta EXACTAMENTE la fuente configurada. Si falla, falla — no se
      // sustituye por la otra ni se inventa un valor.
      const outcome: QuoteOutcome = await exchangeRateService.fetchQuote(dolarSource)

      if (!outcome.ok) {
        setStatus({ kind: 'error', message: outcome.message })
        if (dolarSource === 'cordoba') {
          setCordobaTest({ loading: false, detail: null, error: outcome.message })
        }
        return
      }

      const apiRate = outcome.sell
      let cordobaDetail: CordobaRateDetail | undefined

      if (dolarSource === 'cordoba') {
        cordobaDetail = {
          compra:    outcome.buy ?? 0,
          venta:     outcome.sell,
          mode:      'venta',
          strategy:  outcome.strategy ?? 'unknown',
          fetchedAt: outcome.fetchedAt,
        }
        setCordobaTest({ loading: false, detail: cordobaDetail, error: null })
      }

      await currencyService.upsertExchangeRate({
        business_id: businessId,
        base_currency: 'USD',
        target_currency: 'ARS',
        rate: apiRate,
        is_manual: false,
        source: sourceInfo.rateSourceTag,
      });

      setExchangeRate(apiRate);
      clearDollarCache(businessId);
      loadRateHistory();
      loadLastValidCordoba();
      setStatus({
        kind: 'ok',
        message: `Cotización actualizada · ${sourceInfo.label} · venta $${apiRate.toLocaleString('es-AR')}`,
      });
      // Auto-sync con change detection: solo actualiza productos si la cotización cambió
      await syncProductPrices(apiRate, sourceInfo.rateSourceTag, false, cordobaDetail);
    } catch (error) {
      logger.error('INVENTORY', 'Error al actualizar cotización desde API', error);
      setStatus({ kind: 'error', message: `No pudimos obtener ${sourceInfo.label}. Intentá de nuevo en unos minutos.` });
    } finally {
      setSaving(false);
    }
  };

  const canManageSettings = isOwner || isAdmin;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' }}>
        <Loader size="lg" />
      </div>
    );
  }

  return (
    <div>
      <div className="page-hdr">
        <div className="page-hdr-left">
          <div className="page-hdr-icon">
            <DollarSign size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div>
            <h1 className="page-hdr-title">Configuración de Moneda</h1>
            <p className="page-hdr-subtitle">Configura los tipos de cambio y preferencias de moneda</p>
          </div>
        </div>
      </div>

      {/* Estado explícito de la última operación. Reemplaza a los alert() que
          volcaban el mensaje crudo de Postgres o "Failed to fetch". */}
      {status && (
        <div
          role="status"
          data-testid="currency-status"
          data-status-kind={status.kind}
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            borderRadius: '0.625rem',
            fontSize: '0.8125rem',
            lineHeight: 1.45,
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            border: `1px solid ${status.kind === 'error' ? 'rgba(248,113,113,0.35)' : status.kind === 'ok' ? 'rgba(52,211,153,0.3)' : 'rgba(148,163,184,0.25)'}`,
            background: status.kind === 'error' ? 'rgba(248,113,113,0.08)' : status.kind === 'ok' ? 'rgba(52,211,153,0.07)' : 'rgba(148,163,184,0.06)',
            color: status.kind === 'error' ? '#f87171' : status.kind === 'ok' ? '#34d399' : '#94a3b8',
          }}
        >
          {status.kind === 'error' && <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '0.15rem' }} />}
          <span>{status.message}</span>
        </div>
      )}

      {/* minmax(min(400px,100%)) — con 400px fijo la grilla forzaba 400px de
          ancho y desbordaba horizontalmente en viewports de 360/390. */}
      <div style={{ display: 'grid', gap: '2rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(400px, 100%), 1fr))' }}>
        {/* Configuración de moneda */}
        <div className="surface-raised" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DollarSign size={18} style={{ color: 'var(--accent-primary)' }} />
            Configuración General
          </h2>

          <div style={{ marginBottom: '1rem' }}>
            <label className="label-caps">Moneda por defecto</label>
            <select
              value={settings?.default_currency || 'ARS'}
              onChange={(e) => setSettings({ ...settings!, default_currency: e.target.value })}
              disabled={!canManageSettings}
              className="form-select"
            >
              {/*
                Sólo ARS y USD: `business_settings_default_currency_check` no
                acepta otra cosa. EUR y GBP eran opciones seleccionables sin
                backend — al guardarlas la DB devolvía un 23514 crudo.
              */}
              <option value="ARS">Pesos Argentinos (ARS)</option>
              <option value="USD">Dólares Estadounidenses (USD)</option>
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
            <label className="label-caps" id="dolar-source-label">Fuente del Dólar Blue</label>
            {/*
              Renderizado desde DOLAR_SOURCES — una sola fuente de verdad para
              valor persistido, etiqueta y proveedor. Antes cada opción estaba
              escrita a mano y su valor se repetía en cuatro lugares distintos.
            */}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }} role="radiogroup" aria-labelledby="dolar-source-label">
              {DOLAR_SOURCE_ORDER.map(option => {
                const info     = DOLAR_SOURCES[option]
                const selected = dolarSource === option
                const accent   = option === 'cordoba'
                  ? { border: '#10b981', bg: 'rgba(16,185,129,0.1)', text: '#6ee7b7', icon: '#34d399' }
                  : { border: '#6366f1', bg: 'rgba(99,102,241,0.12)', text: '#a5b4fc', icon: '#818cf8' }
                const Icon = option === 'cordoba' ? MapPin : Globe
                return (
                  <button
                    key={option}
                    role="radio"
                    aria-checked={selected}
                    data-dolar-source={option}
                    onClick={() => canManageSettings && setSettings({ ...settings!, dolar_source: option })}
                    disabled={!canManageSettings}
                    style={{
                      flex: '1 1 8.5rem',
                      minWidth: '8.5rem',
                      minHeight: '44px',
                      padding: '0.75rem 1rem',
                      borderRadius: '0.625rem',
                      border: selected ? `2px solid ${accent.border}` : '1px solid rgba(255,255,255,0.1)',
                      backgroundColor: selected ? accent.bg : '#1e293b',
                      color: selected ? accent.text : '#94a3b8',
                      cursor: canManageSettings ? 'pointer' : 'not-allowed',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.375rem',
                      transition: 'all 0.18s',
                      opacity: canManageSettings ? 1 : 0.6,
                    }}
                  >
                    <Icon size={20} style={{ color: selected ? accent.icon : '#64748b' }} />
                    <span style={{ fontSize: '0.8125rem', fontWeight: 600 }}>{info.label}</span>
                    <span style={{ fontSize: '0.6875rem', color: '#64748b', textAlign: 'center', lineHeight: 1.3 }}>
                      {info.providerLabel}
                    </span>
                  </button>
                )
              })}
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
            <button onClick={handleSaveSettings} disabled={saving} className="btn btn-primary btn-lift">
              <Save size={16} />
              {saving ? 'Guardando...' : 'Guardar Configuración'}
            </button>
          )}
        </div>

        {/* Tipo de cambio */}
        <div className="surface-raised" style={{ padding: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <RefreshCw size={18} style={{ color: 'var(--accent-primary)' }} />
            Tipo de Cambio
          </h2>

          <div style={{ marginBottom: '1rem' }}>
            <label className="label-caps">USD a ARS</label>
            <input
              type="number"
              step="0.01"
              value={exchangeRate}
              onChange={(e) => setExchangeRate(parseFloat(e.target.value) || 0)}
              disabled={!canManageSettings}
              className="form-control"
              style={{ fontSize: '1.25rem', fontWeight: 600 }}
            />
          </div>

          <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: '#64748b' }}>
            Última actualización: {settings?.updated_at ? new Date(settings.updated_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'N/A'}
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {canManageSettings && (
              <button onClick={handleUpdateRate} disabled={saving || syncing} className="btn btn-primary btn-lift">
                <RefreshCw size={15} />
                {saving ? 'Actualizando...' : 'Actualizar Tipo de Cambio'}
              </button>
            )}

            {canManageSettings && (
              <button
                onClick={handleUpdateFromAPI}
                disabled={saving || syncing}
                className="btn btn-lift"
                style={{
                  background: dolarSource === 'cordoba' ? '#059669' : '#0284c7',
                  color: '#fff', border: 'none', whiteSpace: 'nowrap',
                  opacity: saving || syncing ? 0.55 : 1,
                }}
                title={`Obtener valor de venta de ${sourceInfo.label} desde ${sourceInfo.providerLabel}`}
              >
                {dolarSource === 'cordoba' ? <MapPin size={15} /> : <Cloud size={15} />}
                {saving ? 'Actualizando...' : `Actualizar · ${sourceInfo.label}`}
              </button>
            )}

            <button
              onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadRateHistory(); }}
              className="btn btn-ghost"
            >
              <History size={15} />
              {showHistory ? 'Ocultar' : 'Ver Historial'}
            </button>
          </div>

          {/* ── Panel "Probar InfoDolar Córdoba" (solo cuando fuente = cordoba) ── */}
          {dolarSource === 'cordoba' && (
            <div style={{ marginTop: '1.25rem', padding: '1rem', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.15)', borderRadius: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap', marginBottom: cordobaTest.detail || cordobaTest.error ? '0.75rem' : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <MapPin size={15} style={{ color: '#10b981', flexShrink: 0 }} />
                  <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#6ee7b7' }}>InfoDolar Córdoba</span>
                  <span style={{ fontSize: '0.72rem', color: '#475569' }}>— siempre usa precio de VENTA</span>
                </div>
                <button
                  onClick={handleTestCordoba}
                  disabled={cordobaTest.loading}
                  className="btn btn-ghost btn-sm"
                  style={{ borderColor: 'rgba(16,185,129,0.3)', color: '#34d399' }}
                >
                  {cordobaTest.loading
                    ? <><RefreshCw size={13} style={{ animation: 'tr-spin 1s linear infinite' }} /> Consultando...</>
                    : <><MapPin size={13} /> Probar InfoDolar Córdoba</>}
                </button>
              </div>

              {cordobaTest.error && (
                <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'flex-start', fontSize: '0.775rem', color: '#f87171' }}>
                  <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
                  {cordobaTest.error}
                </div>
              )}

              {cordobaTest.detail && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.625rem' }}>
                  {[
                    { label: 'Compra detectada', value: `$${cordobaTest.detail.compra.toLocaleString('es-AR')}`, color: '#94a3b8' },
                    { label: 'Venta detectada',  value: `$${cordobaTest.detail.venta.toLocaleString('es-AR')}`,  color: '#34d399' },
                    { label: 'Valor aplicado',   value: `$${cordobaTest.detail.venta.toLocaleString('es-AR')} · Venta`, color: '#34d399' },
                  ].map(item => (
                    <div key={item.label} style={{ padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.025)', borderRadius: '0.5rem', textAlign: 'center' }}>
                      <div style={{ fontSize: '0.66rem', color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.2rem' }}>{item.label}</div>
                      <div style={{ fontSize: '0.9rem', fontWeight: 800, fontFamily: 'monospace', color: item.color }}>{item.value}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Último valor válido guardado + Reaplicar */}
              {lastValidCordoba && (
                <div style={{ marginTop: '0.75rem', padding: '0.625rem 0.875rem', background: 'rgba(255,255,255,0.025)', borderRadius: '0.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.75rem', color: '#475569' }}>
                    Último valor válido Córdoba:{' '}
                    <strong style={{ color: '#34d399', fontFamily: 'monospace' }}>
                      ${lastValidCordoba.rate.toLocaleString('es-AR')}
                    </strong>
                    {' · '}
                    <span style={{ color: '#334155' }}>
                      {new Date(lastValidCordoba.updatedAt).toLocaleString('es-AR', {
                        timeZone: 'America/Argentina/Cordoba',
                        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                      })}
                    </span>
                  </span>
                  {canManageSettings && !syncing && (
                    reapplyConfirm ? (
                      <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.72rem', color: '#fbbf24' }}>
                          ¿Reaplicar ${lastValidCordoba.rate.toLocaleString('es-AR')} a productos?
                        </span>
                        <button onClick={() => setReapplyConfirm(false)} className="btn btn-ghost btn-sm" style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}>Cancelar</button>
                        <button
                          onClick={async () => {
                            setReapplyConfirm(false)
                            await syncProductPrices(lastValidCordoba.rate, 'infodolar-cordoba', true)
                          }}
                          className="btn btn-sm"
                          style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem', background: 'rgba(251,191,36,0.15)', border: '1px solid rgba(251,191,36,0.3)', color: '#fbbf24' }}
                        >
                          Confirmar
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setReapplyConfirm(true)}
                        className="btn btn-ghost btn-sm"
                        style={{ fontSize: '0.72rem', color: '#fbbf24', borderColor: 'rgba(251,191,36,0.2)' }}
                        title="Aplica el último rate válido de Córdoba a todos los productos dolarizados"
                      >
                        <RefreshCw size={11} /> Reaplicar último valor válido
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Sync status y botón Reaplicar ── */}
          <div style={{ marginTop: '1.25rem', padding: '1rem', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Package size={15} style={{ color: syncing ? '#fbbf24' : '#475569', flexShrink: 0 }} />
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>
                  {syncing ? 'Actualizando precios de productos...' : 'Precios dolarizados'}
                </span>
              </div>
              {canManageSettings && !syncing && (
                <button
                  onClick={() => syncProductPrices(exchangeRate, 'manual', true)}
                  disabled={syncing || exchangeRate <= 0}
                  className="btn btn-ghost btn-sm"
                  title="Forzar reaplicación de la cotización actual a todos los productos dolarizados con auto-actualización activa"
                >
                  <RefreshCw size={13} />
                  Reaplicar dólar ahora
                </button>
              )}
            </div>

            {syncing && (
              <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#fbbf24' }}>
                Verificando cambio de cotización
                {prevRate ? <> (${prevRate.toLocaleString('es-AR')} → ${exchangeRate.toLocaleString('es-AR')})</> : null}
                {' '}y actualizando productos...
              </div>
            )}

            {syncResult && !syncing && (
              <div style={{ marginTop: '0.625rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                {syncResult.error ? (
                  <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', fontSize: '0.775rem', color: '#f87171' }}>
                    <AlertTriangle size={13} />
                    Error al sincronizar: {syncResult.error}
                  </div>
                ) : !syncResult.changed ? (
                  <div style={{ fontSize: '0.775rem', color: '#64748b' }}>
                    ℹ️ Cotización sin cambio (${syncResult.rate.toLocaleString('es-AR')}) — precios no modificados.
                    <span style={{ marginLeft: '0.5rem', color: '#334155' }}>{syncResult.timestamp}</span>
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: '0.775rem', color: '#64748b', display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                      <span>
                        ✅ <strong style={{ color: '#34d399' }}>{syncResult.updated} productos</strong> actualizados
                        {syncResult.prevRate && syncResult.prevRate !== syncResult.rate
                          ? <> de <span style={{ fontFamily: 'monospace', color: '#94a3b8' }}>${syncResult.prevRate.toLocaleString('es-AR')}</span> a <span style={{ fontFamily: 'monospace', color: '#34d399' }}>${syncResult.rate.toLocaleString('es-AR')}</span></>
                          : <> a <span style={{ fontFamily: 'monospace', color: '#34d399' }}>${syncResult.rate.toLocaleString('es-AR')}</span></>
                        }
                      </span>
                      {syncResult.skipped > 0 && <span style={{ color: '#475569' }}>{syncResult.skipped} omitidos (sin precio USD base)</span>}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#334155', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                      {/* describeRateSource normaliza las grafías históricas —
                          antes cualquier cosa que no fuera exactamente
                          'infodolar-cordoba' o 'bluelytics' se rotulaba "Manual". */}
                      <span>Fuente: <strong style={{ color: '#475569' }}>
                        {describeRateSource(syncResult.source)}
                      </strong></span>
                      <span>{syncResult.timestamp}</span>
                    </div>
                    {syncResult.cordobaDetail && (
                      <div style={{ fontSize: '0.72rem', color: '#475569' }}>
                        InfoDolar Córdoba: compra ${syncResult.cordobaDetail.compra.toLocaleString('es-AR')} ·{' '}
                        <strong style={{ color: '#34d399' }}>venta ${syncResult.cordobaDetail.venta.toLocaleString('es-AR')}</strong>
                        {' · '}modo: <strong style={{ color: '#34d399' }}>Venta</strong>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
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
                      <span>{new Date(rate.updated_at).toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
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
