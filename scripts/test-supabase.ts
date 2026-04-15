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
      console.log('📋 Para configurar Supabase:')
      console.log('1. Ve a https://supabase.com/dashboard')
      console.log('2. Abre tu proyecto')
      console.log('3. Ve a SQL Editor > New query')
      console.log('4. Copia y pega el contenido de supabase/schema.sql')
      console.log('5. Ejecuta el script')
      console.log('')
      console.log('📁 Archivos en: supabase/')
      console.log('- schema.sql: Estructura de tablas')
      console.log('- seed.sql: Datos de ejemplo')
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
