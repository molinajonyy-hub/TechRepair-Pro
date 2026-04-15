import { supabase } from '../lib/supabase';

export interface ExchangeRate {
  id: string;
  business_id: string;
  base_currency: string;
  target_currency: string;
  rate: number;
  is_manual: boolean;
  source?: string;
  updated_at: string;
  created_at: string;
}

export interface BusinessSettings {
  id: string;
  business_id: string;
  default_currency: string;
  show_usd_price: boolean;
  auto_update_rate: boolean;
  rate_api_url?: string;
  rate_update_frequency_hours: number;
  updated_at: string;
  created_at: string;
}

const firstRow = <T,>(data: T[] | T | null): T | null => {
  if (!data) {
    return null;
  }

  return Array.isArray(data) ? data[0] ?? null : data;
};

export const currencyService = {
  async getCurrentExchangeRate(
    baseCurrency = 'USD',
    targetCurrency = 'ARS'
  ): Promise<number> {
    const { data, error } = await supabase.rpc('get_current_exchange_rate', {
      p_base_currency: baseCurrency,
      p_target_currency: targetCurrency,
    });

    if (error) {
      console.error('Error getting exchange rate:', error);
      return 1;
    }

    return data || 1;
  },

  async getBusinessSettings(): Promise<BusinessSettings | null> {
    const { data, error } = await supabase.rpc('get_business_settings');

    if (error) {
      console.error('Error getting business settings:', error);
      return null;
    }

    return firstRow(data) as BusinessSettings | null;
  },

  async upsertBusinessSettings(settings: Partial<BusinessSettings> & { business_id: string }): Promise<BusinessSettings> {
    const { data, error } = await supabase
      .from('business_settings')
      .upsert({
        business_id: settings.business_id,
        default_currency: settings.default_currency ?? 'ARS',
        show_usd_price: settings.show_usd_price ?? false,
        auto_update_rate: settings.auto_update_rate ?? false,
        rate_api_url: settings.rate_api_url ?? null,
        rate_update_frequency_hours: settings.rate_update_frequency_hours ?? 24,
      }, { onConflict: 'business_id' })
      .select();

    if (error) {
      throw new Error(error.message || 'Error al guardar configuracion');
    }

    const row = firstRow(data);

    if (!row) {
      throw new Error('No se recibio la configuracion guardada');
    }

    return row as BusinessSettings;
  },

  async upsertExchangeRate(
    rate: Omit<ExchangeRate, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ExchangeRate> {
    const { data, error } = await supabase
      .from('exchange_rates')
      .upsert({
        business_id: rate.business_id,
        base_currency: rate.base_currency,
        target_currency: rate.target_currency,
        rate: rate.rate,
        is_manual: rate.is_manual,
        source: rate.source ?? null,
      }, { onConflict: 'business_id,base_currency,target_currency' })
      .select();

    if (error) {
      throw new Error(error.message || 'Error al guardar tipo de cambio');
    }

    const row = firstRow(data);

    if (!row) {
      throw new Error('No se recibio el tipo de cambio guardado');
    }

    return row as ExchangeRate;
  },

  async getExchangeRateHistory(
    businessId: string,
    baseCurrency = 'USD',
    targetCurrency = 'ARS'
  ): Promise<ExchangeRate[]> {
    const { data, error } = await supabase
      .from('exchange_rates')
      .select('*')
      .eq('business_id', businessId)
      .eq('base_currency', baseCurrency)
      .eq('target_currency', targetCurrency)
      .order('updated_at', { ascending: false })
      .limit(30);

    if (error) {
      console.error('Error getting exchange rate history:', error);
      return [];
    }

    return data || [];
  },

  async convertFromUSD(
    priceUSD: number,
    _businessId: string,
    targetCurrency = 'ARS'
  ): Promise<{ localPrice: number; rate: number; currency: string }> {
    const settings = await this.getBusinessSettings();
    const currency = settings?.default_currency || targetCurrency;
    const rate = await this.getCurrentExchangeRate('USD', currency);
    const localPrice = Math.round(priceUSD * rate * 100) / 100;

    return { localPrice, rate, currency };
  },

  async convertToUSD(
    localPrice: number,
    _businessId: string,
    sourceCurrency = 'ARS'
  ): Promise<{ usdPrice: number; rate: number }> {
    const rate = await this.getCurrentExchangeRate('USD', sourceCurrency);
    const usdPrice = Math.round((localPrice / rate) * 100) / 100;

    return { usdPrice, rate };
  },

  formatPrice(price: number, currency: string, showUSD = false, usdPrice?: number): string {
    const currencySymbols: Record<string, string> = {
      USD: '$',
      ARS: '$',
      EUR: 'EUR ',
      GBP: 'GBP ',
    };

    const symbol = currencySymbols[currency] || currency;
    const formattedLocal = `${symbol}${price.toLocaleString('es-AR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

    if (showUSD && usdPrice !== undefined) {
      return `${formattedLocal} (USD $${usdPrice.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })})`;
    }

    return formattedLocal;
  },

  /**
   * Actualizar precios de productos vinculados al dólar cuando cambia el tipo de cambio
   */
  async updateProductPricesByExchangeRate(
    businessId: string,
    newRate: number
  ): Promise<{ updated: number; error?: string }> {
    try {
      // Obtener productos vinculados al dólar
      const { data: products, error: fetchError } = await supabase
        .from('inventory')
        .select('id, price_usd')
        .eq('business_id', businessId)
        .eq('linked_to_dolar', true)
        .not('price_usd', 'is', null);

      if (fetchError) throw fetchError;

      if (!products || products.length === 0) {
        return { updated: 0 };
      }

      // Actualizar cada producto
      let updatedCount = 0;
      for (const product of products) {
        if (!product.price_usd) continue;

        const newPriceARS = Math.round(product.price_usd * newRate * 100) / 100;

        const { error: updateError } = await supabase
          .from('inventory')
          .update({
            sale_price: newPriceARS,
            exchange_rate_used: newRate,
            updated_at: new Date().toISOString()
          })
          .eq('id', product.id);

        if (!updateError) {
          updatedCount++;
        }
      }

      return { updated: updatedCount };
    } catch (error: any) {
      console.error('Error updating product prices:', error);
      return { updated: 0, error: error.message };
    }
  },

  /**
   * Vincular producto al dólar (guardar precio en USD)
   */
  async linkProductToDolar(
    productId: string,
    priceUSD: number,
    currentRate: number
  ): Promise<void> {
    try {
      const priceARS = Math.round(priceUSD * currentRate * 100) / 100;

      const { error } = await supabase
        .from('inventory')
        .update({
          price_usd: priceUSD,
          exchange_rate_used: currentRate,
          linked_to_dolar: true,
          sale_price: priceARS,
          updated_at: new Date().toISOString()
        })
        .eq('id', productId);

      if (error) throw error;
    } catch (error: any) {
      console.error('Error linking product to dollar:', error);
      throw error;
    }
  },

  /**
   * Desvincular producto del dólar
   */
  async unlinkProductFromDolar(productId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('inventory')
        .update({
          linked_to_dolar: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', productId);

      if (error) throw error;
    } catch (error: any) {
      console.error('Error unlinking product from dollar:', error);
      throw error;
    }
  },
};
