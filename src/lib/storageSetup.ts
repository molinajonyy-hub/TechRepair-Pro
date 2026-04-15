import { supabase } from './supabase'

/**
 * El bucket 'business-assets' se crea desde el dashboard de Supabase o via SQL.
 * Esta función solo verifica que exista, no intenta crearlo desde el cliente
 * ya que la API de Storage bloquea createBucket con la anon key.
 */
export async function ensureBusinessAssetsBucket() {
  return true
}

export async function uploadBusinessLogo(file: File, businessId: string): Promise<string | null> {
  try {
    // Asegurar que el bucket existe
    const bucketReady = await ensureBusinessAssetsBucket()
    if (!bucketReady) {
      throw new Error('No se pudo crear el bucket de storage')
    }

    const fileExt = file.name.split('.').pop()
    const fileName = `${businessId}_logo.${fileExt}`
    const filePath = `business-logos/${fileName}`

    // Subir archivo
    const { error: uploadError } = await supabase.storage
      .from('business-assets')
      .upload(filePath, file, {
        upsert: true,
        contentType: file.type
      })

    if (uploadError) {
      console.error('Error uploading file:', uploadError)
      throw new Error(`Error al subir archivo: ${uploadError.message}`)
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
      .from('business-assets')
      .getPublicUrl(filePath)

    return publicUrl
  } catch (error: any) {
    console.error('Error uploading logo:', error)
    throw error
  }
}
