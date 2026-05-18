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

let _xlsxCache: typeof import('xlsx') | null = null
async function getXLSX() {
  if (!_xlsxCache) _xlsxCache = await import('xlsx')
  return _xlsxCache
}

export class ExcelService {
  static async exportToExcel<T extends Record<string, any>>(
    data: T[],
    filename: string,
    sheetName: string = 'Datos'
  ): Promise<ExcelExportResult> {
    try {
      if (!data || data.length === 0) {
        throw new Error('No hay datos para exportar')
      }

      const XLSX = await getXLSX()
      const worksheet = XLSX.utils.json_to_sheet(data)
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName)
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

  static async importFromExcel<T extends ExcelRow>(
    file: File,
    requiredColumns: string[] = []
  ): Promise<ExcelImportResult<T>> {
    try {
      if (!file) {
        throw new Error('No se proporcionó ningún archivo')
      }

      const validExtensions = ['.xlsx', '.xls']
      const fileExtension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'))

      if (!validExtensions.includes(fileExtension)) {
        throw new Error('Formato de archivo no válido. Solo se acepta .xlsx o .xls')
      }

      const maxSize = 5 * 1024 * 1024
      if (file.size > maxSize) {
        throw new Error('El archivo supera el tamaño máximo de 5MB')
      }

      const XLSX = await getXLSX()
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })

      const firstSheetName = workbook.SheetNames[0]
      const worksheet = workbook.Sheets[firstSheetName]
      const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: '' }) as T[]

      if (!jsonData || jsonData.length === 0) {
        throw new Error('El archivo está vacío o no tiene datos válidos')
      }

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

  static async createTemplate(
    headers: string[],
    filename: string,
    exampleData?: Record<string, any>[]
  ): Promise<ExcelExportResult> {
    try {
      const data = exampleData && exampleData.length > 0
        ? exampleData
        : [headers.reduce((acc, header) => ({ ...acc, [header]: '' }), {})]

      return await this.exportToExcel(data, filename, 'Plantilla')
    } catch (error) {
      console.error('Error creando plantilla:', error)
      throw error
    }
  }

  static validateRow(
    row: ExcelRow,
    schema: Record<string, { required?: boolean; type?: 'string' | 'number' | 'date' }>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    for (const [field, rules] of Object.entries(schema)) {
      const value = row[field]

      if (rules.required && (!value || value === '')) {
        errors.push(`${field} es requerido`)
        continue
      }

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

  private static isValidDate(value: any): boolean {
    if (!value) return false

    if (typeof value === 'number') {
      const date = new Date((value - 25569) * 86400 * 1000)
      return !isNaN(date.getTime())
    }

    if (typeof value === 'string') {
      const date = new Date(value)
      return !isNaN(date.getTime())
    }

    return false
  }

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
