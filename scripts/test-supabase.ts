// Script para probar conexión con Supabase y cargar datos iniciales
import { supabase } from './src/lib/supabase'

async function testConnection() {
  console.log('🔄 Probando conexión con Supabase...')
  
  try {
    // Probar conexión listando usuarios
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .limit(1)
    
    if (error) {
      console.error('❌ Error de conexión:', error.message)
      console.log('')
      console.log('📋 Para reconstruir el esquema localmente:')
      console.log('1. supabase start && supabase db reset')
      console.log('   (aplica el baseline en supabase/migrations/)')
      console.log('2. Ver supabase/MIGRATION_BASELINE_PLAN.md para el flujo completo')
      console.log('')
      console.log('📁 Esquema histórico (NO usar para nuevos entornos):')
      console.log('- supabase/_archive/loose-scripts/  (scripts sueltos legacy)')
      console.log('- supabase/migrations/_legacy/       (migraciones pre-baseline)')
      return false
    }
    
    console.log('✅ Conexión exitosa!')
    console.log(`📊 Usuarios encontrados: ${users?.length || 0}`)
    
    // Verificar que las tablas existen
    const tables = [
      'users',
      'customers',
      'devices',
      'orders',
      'inventory',
      'suppliers',
      'expenses',
      'notes',
      'parts_used',
      'status_history'
    ]
    
    console.log('')
    console.log('📋 Verificando tablas:')
    
    for (const table of tables) {
      const { count, error: countError } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
      
      if (countError) {
        console.log(`  ❌ ${table}: Error`)
      } else {
        console.log(`  ✅ ${table}: ${count} registros`)
      }
    }
    
    return true
  } catch (err) {
    console.error('❌ Error inesperado:', err)
    return false
  }
}

testConnection()
