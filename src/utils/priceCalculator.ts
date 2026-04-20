// Utility para cálculo de precios con cotización de moneda

export type Currency = 'USD' | 'ARS';

export interface PriceCalculationResult {
  basePrice: number;
  baseCurrency: Currency;
  exchangeRate: number;
  calculatedPrice: number;
  formattedBasePrice: string;
  formattedCalculatedPrice: string;
  exchangeRateFormatted: string;
}

export interface ProductPriceData {
  baseCurrency: Currency;
  basePrice: number;
  exchangeRate?: number;
  autoUpdatePrice?: boolean;
}

/**
 * Convierte un valor a número con manejo de comas y validación
 */
function parseNumber(value: any): number {
  if (value === null || value === undefined || value === '') return 0;
  
  // Si es string, reemplazar coma por punto
  const stringValue = typeof value === 'string' ? value.replace(',', '.') : String(value);
  
  const parsed = parseFloat(stringValue);
  
  // Validar que sea un número válido
  if (isNaN(parsed)) return 0;
  
  return parsed;
}

/**
 * Convierte un valor de moneda usando la cotización
 */
export function convertirMoneda(valor: any, cotizacion: any): number {
  const amount = parseNumber(valor);
  const rate = parseNumber(cotizacion);
  
  return Number((amount * rate).toFixed(2));
}

/**
 * Calcula rentabilidad usando valores en la misma moneda
 */
export function calcularRentabilidad(costoARS: any, ventaARS: any): {
  margen: number;
  porcentaje: number;
} {
  const costo = parseNumber(costoARS);
  const venta = parseNumber(ventaARS);
  
  const margen = venta - costo;
  const porcentaje = costo > 0 ? (margen / costo) * 100 : 0;
  
  return {
    margen: Number(margen.toFixed(2)),
    porcentaje: Number(porcentaje.toFixed(2))
  };
}

/**
 * Función centralizada para calcular precio local desde USD
 * Maneja conversión de tipos, comas por puntos, y validaciones
 */
export function calcularPrecioLocal(precioUSD: any, cotizacion: any): number {
  const usd = parseNumber(precioUSD);
  const rate = parseNumber(cotizacion);

  // Validaciones
  if (usd <= 0 || rate <= 0) return 0;

  const resultado = usd * rate;

  return Number(resultado.toFixed(2));
}

/**
 * Calcula el precio local desde un precio base en USD
 */
export function calculateLocalPrice(
  basePrice: any,
  exchangeRate: any,
  decimals: number = 2
): number {
  const parsedBasePrice = parseNumber(basePrice);
  const parsedExchangeRate = parseNumber(exchangeRate);

  if (parsedBasePrice <= 0) return 0;
  if (parsedExchangeRate <= 0) return parsedBasePrice;

  const result = parsedBasePrice * parsedExchangeRate;
  
  return Math.round(result * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Calcula el precio base USD desde un precio local
 */
export function calculateUSDPrice(
  localPrice: any,
  exchangeRate: any,
  decimals: number = 2
): number {
  const parsedLocalPrice = parseNumber(localPrice);
  const parsedExchangeRate = parseNumber(exchangeRate);

  if (parsedLocalPrice <= 0) return 0;
  if (parsedExchangeRate <= 0) return parsedLocalPrice;

  const result = parsedLocalPrice / parsedExchangeRate;
  
  return Math.round(result * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Formatea un precio según la moneda
 */
export function formatPrice(price: number, currency: Currency = 'ARS'): string {
  if (currency === 'USD') {
    return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `$${price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Formatea la cotización
 */
export function formatExchangeRate(rate: number): string {
  return rate.toLocaleString('es-AR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/**
 * Realiza el cálculo completo de precio con cotización
 */
export function calculatePriceWithExchangeRate(
  data: ProductPriceData,
  currentExchangeRate: number
): PriceCalculationResult {
  const {
    baseCurrency,
    basePrice,
    exchangeRate = currentExchangeRate,
  } = data;

  let calculatedPrice: number;
  
  if (baseCurrency === 'USD') {
    calculatedPrice = calculateLocalPrice(basePrice, exchangeRate);
  } else {
    calculatedPrice = basePrice; // Si es ARS, el precio local es el mismo
  }

  return {
    basePrice,
    baseCurrency,
    exchangeRate,
    calculatedPrice,
    formattedBasePrice: formatPrice(basePrice, baseCurrency),
    formattedCalculatedPrice: formatPrice(calculatedPrice, 'ARS'),
    exchangeRateFormatted: formatExchangeRate(exchangeRate),
  };
}

/**
 * Valida datos de precio
 */
export function validatePriceData(data: ProductPriceData): { valid: boolean; error?: string } {
  if (!data.basePrice || data.basePrice <= 0) {
    return { valid: false, error: 'El precio base debe ser mayor a 0' };
  }

  if (!['USD', 'ARS'].includes(data.baseCurrency)) {
    return { valid: false, error: 'Moneda base no válida' };
  }

  if (data.baseCurrency === 'USD' && (!data.exchangeRate || data.exchangeRate <= 0)) {
    return { valid: false, error: 'La cotización debe ser mayor a 0 para productos en USD' };
  }

  return { valid: true };
}

/**
 * Genera un mensaje de cálculo para mostrar en UI
 */
export function getCalculationMessage(result: PriceCalculationResult): string {
  if (result.baseCurrency === 'ARS') {
    return 'Precio en moneda local';
  }
  
  return `USD $${result.formattedBasePrice} × ${result.exchangeRateFormatted} = $${result.formattedCalculatedPrice}`;
}
