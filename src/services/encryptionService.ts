import { supabase } from '../lib/supabase'

/**
 * Servicio de cifrado para datos sensibles (certificados, claves, contraseñas)
 * Usa pgcrypto de Supabase para cifrado AES-256
 */
export class EncryptionService {
  /**
   * Cifra un texto usando pgcrypto de Supabase
   * @param text - Texto a cifrar
   * @returns Texto cifrado en base64
   */
  static async encrypt(text: string): Promise<string> {
    try {
      const { data, error } = await supabase.rpc('encrypt_data', {
        data_to_encrypt: text
      })

      if (error) throw error
      return data as string
    } catch (error) {
      console.error('Error encrypting data:', error)
      throw new Error('Error al cifrar datos')
    }
  }

  /**
   * Descifra un texto cifrado usando pgcrypto de Supabase
   * @param encryptedText - Texto cifrado en base64
   * @returns Texto descifrado
   */
  static async decrypt(encryptedText: string): Promise<string> {
    try {
      const { data, error } = await supabase.rpc('decrypt_data', {
        encrypted_data: encryptedText
      })

      if (error) throw error
      return data as string
    } catch (error) {
      console.error('Error decrypting data:', error)
      throw new Error('Error al descifrar datos')
    }
  }

  /**
   * Cifra un archivo (certificado, clave privada, etc.) y lo convierte a base64
   * @param file - Archivo a cifrar
   * @returns Archivo cifrado en base64
   */
  static async encryptFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      
      reader.onload = async (e) => {
        try {
          const base64 = e.target?.result as string
          const encrypted = await this.encrypt(base64)
          resolve(encrypted)
        } catch (error) {
          reject(error)
        }
      }
      
      reader.onerror = () => reject(new Error('Error al leer el archivo'))
      reader.readAsDataURL(file)
    })
  }

  /**
   * Descifra un archivo cifrado y lo convierte a base64 para descarga
   * @param encryptedFile - Archivo cifrado en base64
   * @returns Archivo descifrado en base64
   */
  static async decryptFile(encryptedFile: string): Promise<string> {
    try {
      const decrypted = await this.decrypt(encryptedFile)
      return decrypted
    } catch (error) {
      console.error('Error decrypting file:', error)
      throw new Error('Error al descifrar archivo')
    }
  }

  /**
   * Valida si un archivo es un certificado válido (.crt, .pem, .p12, .pfx)
   * @param file - Archivo a validar
   * @returns true si es un certificado válido
   */
  static isValidCertificate(file: File): boolean {
    const validExtensions = ['.crt', '.pem', '.p12', '.pfx']
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    return validExtensions.includes(extension)
  }

  /**
   * Valida si un archivo es una clave privada válida (.key, .pem, .p12, .pfx)
   * @param file - Archivo a validar
   * @returns true si es una clave privada válida
   */
  static isValidPrivateKey(file: File): boolean {
    const validExtensions = ['.key', '.pem', '.p12', '.pfx']
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    return validExtensions.includes(extension)
  }

  /**
   * Valifica si un archivo es un PFX/P12 válido
   * @param file - Archivo a validar
   * @returns true si es un PFX/P12 válido
   */
  static isPfxFile(file: File): boolean {
    const validExtensions = ['.p12', '.pfx']
    const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase()
    return validExtensions.includes(extension)
  }
}

export default EncryptionService
