import { supabase } from '../../lib/supabase'
import { accessSecretForRpc, intakePayload, type IntakeDraft } from './model'

export interface IntakeCreateResult { order_id: string; device_id?: string; replayed: boolean }

export async function createOrderIntake(requestId: string, draft: IntakeDraft): Promise<IntakeCreateResult> {
  const { data, error } = await supabase.rpc('create_order_intake' as never, {
    p_request_id: requestId,
    p_payload: intakePayload(draft),
    p_access_secret: accessSecretForRpc(draft),
  } as never)
  if (error) throw new Error(error.message)
  return data as unknown as IntakeCreateResult
}

async function currentBusinessId(): Promise<string> {
  const { data, error } = await supabase.rpc('get_my_profile')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.business_id) throw new Error('No se encontró un negocio activo.')
  return row.business_id
}

export async function uploadIntakePhotos(orderId: string, files: File[]): Promise<{ uploaded: number; failed: string[] }> {
  if (!files.length) return { uploaded: 0, failed: [] }
  const businessId = await currentBusinessId()
  let uploaded = 0
  const failed: string[] = []
  for (const file of files) {
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `business/${businessId}/orders/${orderId}/intake/${crypto.randomUUID()}.${extension}`
    const { error: uploadError } = await supabase.storage.from('documents').upload(path, file, {
      contentType: file.type, upsert: false, cacheControl: '3600',
    })
    if (uploadError) { failed.push(file.name); continue }
    const { error: registerError } = await supabase.rpc('register_order_intake_document' as never, {
      p_order_id: orderId, p_storage_path: path, p_file_name: file.name,
      p_file_type: file.type, p_file_size: file.size,
    } as never)
    if (registerError) {
      await supabase.storage.from('documents').remove([path])
      failed.push(file.name)
    } else uploaded += 1
  }
  return { uploaded, failed }
}

export async function loadAssignableProfiles() {
  const { data, error } = await supabase.from('business_users_view').select('id,full_name,email,role,is_active,permissions').eq('is_active', true).order('full_name')
  if (error) throw error
  return data || []
}

export async function revealDeviceAccess(orderId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('reveal_order_device_access' as never, { p_order_id: orderId } as never)
  if (error) throw error
  return data as unknown as string | null
}

export async function setDeviceAccess(orderId: string, mode: 'pin'|'pattern'|'password', secret: string) {
  const { error } = await supabase.rpc('set_order_device_access_secret' as never, { p_order_id: orderId, p_mode: mode, p_secret: secret } as never)
  if (error) throw error
}

export async function deleteDeviceAccess(orderId: string) {
  const { error } = await supabase.rpc('delete_order_device_access_secret' as never, { p_order_id: orderId } as never)
  if (error) throw error
}

