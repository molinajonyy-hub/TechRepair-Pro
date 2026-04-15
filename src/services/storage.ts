import { supabase } from '../lib/supabase'

const BUCKET_NAME = 'documents'

export const storageService = {
  // Upload file
  async uploadFile(file: File, orderId: string): Promise<{ path: string; url: string }> {
    // Create unique file name
    const fileExt = file.name.split('.').pop()
    const fileName = `${orderId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    
    // Upload to Supabase Storage
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(fileName, file, {
        cacheControl: '3600',
        upsert: false
      })
    
    if (error) throw error
    
    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(data.path)
    
    return { path: data.path, url: publicUrl }
  },

  // Delete file
  async deleteFile(path: string): Promise<void> {
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([path])
    
    if (error) throw error
  },

  // Get file URL
  getFileUrl(path: string): string {
    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(path)
    
    return publicUrl
  },

  // Upload multiple files
  async uploadMultiple(files: FileList, orderId: string): Promise<Array<{ path: string; url: string; file: File }>> {
    const uploads = []
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const result = await this.uploadFile(file, orderId)
      uploads.push({ ...result, file })
    }
    
    return uploads
  }
}
