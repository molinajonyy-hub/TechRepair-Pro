import * as XLSX from 'xlsx'

export type ExcelRow = Record<string, any>

export interface ExcelImportResult<T> {
  success: boolean
  data: T[]
  errors: string[]
  created: number
  updated: number
}

export interface ExcelExportResult {
  success: boolean
  filename: string
  rowCount: number
}

export class ExcelService {
  /**
   * Exporta datos a un archivo Excel
   */
  static exportToExcel<T extends Record<string, any>>(
    data: T[],
    filename: string,
    sheetName: string = 'Datos'
  ): ExcelExportResult {
    try {
      if (!data || data.length === 0) {
        throw new Error('No hay datos para exportar')
      }

      // Crear worksheet
      const worksheet = XLSX.utils.json_to_sheet(data)
      
      // Crear workbook
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)

      // Generar archivo
      XLSX.writeFile(workbook, `${filename}.xlsx`)

      return {
        success: true,
        filename: `${filename}.xlsx`,
        rowCount: data.length
      }
    } catch (error) {
      console.error('Error exportando a Excel:', error)
      throw error
    }
  }

  /**
   * Importa datos desde un archivo Excel
   */
  static async importFromExcel<T extends ExcelRow>(
    file: File,
    requiredColumns: string[] = []
  ): Promise<ExcelImportResult<T>> {
    try {
      // Validar archivo
      if (!file) {
        throw new Error('No se proporcionó ningún archivo')
      }

      const validExtensions = ['.xlsx', '.xls']
      const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))
      
      if (!validExtensions.includes(fileExtension)) {
        throw new Error('Formato de archivo no válido. Solo se acepta .xlsx o .xls')
      }

      // Validar tamaño máximo (5MB)
      const maxSize = 5 * 1024 * 1024
      if (file.size > maxSize) {
        throw new Error('El archivo supera el tamaño máximo de 5MB')
      }

      // Leer archivo
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      
      // Obtener primera hoja
      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      
      // Convertir a JSON
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as T[]

      if (!jsonData || jsonData.length === 0) {
        throw new Error('El archivo está vacío o no tiene datos válidos')
      }

      // Validar columnas requeridas
      if (requiredColumns.length > 0) {
        const firstRow = jsonData[0]
        const missingColumns = requiredColumns.filter(col => !(col in firstRow))
        
        if (missingColumns.length > 0) {
          throw new Error(`Faltan columnas requeridas: ${missingColumns.join(', ')}`)
        }
      }

      return {
        success: true,
        data: jsonData,
        errors: [],
        created: 0,
        updated: 0
      }
    } catch (error) {
      console.error('Error importando de Excel:', error)
      return {
        success: false,
        data: [],
        errors: [error instanceof Error ? error.message : 'Error desconocido'],
        created: 0,
        updated: 0
      }
    }
  }

  /**
   * Crea una plantilla de Excel con los encabezados especificados
   */
  static createTemplate(
    headers: string[],
    filename: string,
    exampleData?: Record<string, any>[]
  ): ExcelExportResult {
    try {
      const data = exampleData && exampleData.length > 0 
        ? exampleData 
        : [headers.reduce((acc, header) => ({ ...acc, [header]: '' }), {})]

      return this.exportToExcel(data, filename, 'Plantilla')
    } catch (error) {
      console.error('Error creando plantilla:', error)
      throw error
    }
  }

  /**
   * Valida una fila de datos según un esquema
   */
  static validateRow(
    row: ExcelRow,
    schema: Record<string, { required?: boolean; type?: 'string' | 'number' | 'date' }>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    for (const [field, rules] of Object.entries(schema)) {
      const value = row[field]

      // Validar campo requerido
      if (rules.required && (!value || value === '')) {
        errors.push(`${field} es requerido`)
        continue
      }

      // Validar tipo
      if (value && value !== '') {
        if (rules.type === 'number' && isNaN(Number(value))) {
          errors.push(`${field} debe ser un número`)
        }
        if (rules.type === 'date' && !this.isValidDate(value)) {
          errors.push(`${field} debe ser una fecha válida`)
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }

  /**
   * Valida si un valor es una fecha válida
   */
  private static isValidDate(value: any): boolean {
    if (!value) return false
    
    // Si es un número de Excel, convertirlo
    if (typeof value === 'number') {
      const date = new Date((value - 25569) * 86400 * 1000)
      return !isNaN(date.getTime())
    }
    
    // Si es string, intentar parsear
    if (typeof value === 'string') {
      const date = new Date(value)
      return !isNaN(date.getTime())
    }
    
    return false
  }

  /**
   * Normaliza los datos de Excel para eliminar espacios extras
   */
  static normalizeData<T extends ExcelRow>(data: T[]): T[] {
    return data.map(row => {
      const normalized: any = {}
      
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string') {
          normalized[key] = value.trim()
        } else {
          normalized[key] = value
        }
      }
      
      return normalized
    })
  }
}
