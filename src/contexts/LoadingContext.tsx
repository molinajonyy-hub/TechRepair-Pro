import { createContext, useContext, useState, ReactNode, useCallback } from 'react'

interface LoadingState {
  isLoading: boolean
  message?: string
  progress?: number
  showProgress?: boolean
}

interface LoadingContextType {
  showLoading: (message?: string) => void
  hideLoading: () => void
  setLoadingWithProgress: (message: string, progress: number) => void
  loadingState: LoadingState
}

const LoadingContext = createContext<LoadingContextType | undefined>(undefined)

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [loadingState, setLoadingState] = useState<LoadingState>({
    isLoading: false,
    message: 'Cargando...',
    showProgress: false
  })

  const showLoading = useCallback((message?: string) => {
    setLoadingState({
      isLoading: true,
      message: message || 'Cargando...',
      showProgress: false
    })
  }, [])

  const hideLoading = useCallback(() => {
    setLoadingState({
      isLoading: false,
      message: 'Cargando...',
      showProgress: false
    })
  }, [])

  const setLoadingWithProgress = useCallback((message: string, progress: number) => {
    setLoadingState({
      isLoading: true,
      message,
      progress,
      showProgress: true
    })
  }, [])

  return (
    <LoadingContext.Provider value={{ showLoading, hideLoading, setLoadingWithProgress, loadingState }}>
      {children}
    </LoadingContext.Provider>
  )
}

export function useLoading() {
  const context = useContext(LoadingContext)
  if (context === undefined) {
    throw new Error('useLoading must be used within a LoadingProvider')
  }
  return context
}
