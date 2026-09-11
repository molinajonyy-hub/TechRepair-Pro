// API canónica del calendario fiscal argentino para frontend/servicios. La
// implementación pura vive en functions/_shared para que afip-cae use el mismo
// algoritmo (día civil de America/Argentina/Buenos_Aires) sin duplicarlo.
export * from '../../supabase/functions/_shared/fiscalCalendar.ts'
