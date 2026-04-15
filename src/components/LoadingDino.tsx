import { useEffect, useState } from 'react'

interface LoadingDinoProps {
  fullScreen?: boolean
  compact?: boolean
  showProgress?: boolean
  progress?: number
  message?: string
}

export function LoadingDino({ 
  fullScreen = false, 
  compact = false,
  showProgress = false,
  progress = 0,
  message = 'Cargando...'
}: LoadingDinoProps) {
  const [currentProgress, setCurrentProgress] = useState(progress)
  const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches

  useEffect(() => {
    if (showProgress) {
      setCurrentProgress(progress)
    }
  }, [progress, showProgress])

  const containerStyle: React.CSSProperties = fullScreen ? {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '2rem',
    backgroundColor: prefersDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)'
  } : {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: compact ? '1rem' : '2rem',
    padding: compact ? '1rem' : '2rem'
  }

  const spinnerSize = compact ? 40 : 60

  return (
    <div style={containerStyle}>
      <style>
        {`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
          
          @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }
          
          .spinner {
            animation: spin 1s linear infinite;
          }
          
          .spinner-ring {
            animation: pulse 2s ease-in-out infinite;
          }
          
          .progress-bar-shimmer {
            background: linear-gradient(90deg, 
              transparent 0%, 
              rgba(99, 102, 241, 0.5) 50%, 
              transparent 100%);
            background-size: 200% 100%;
            animation: shimmer 2s infinite;
          }
        `}
      </style>
      
      {/* Spinner moderno */}
      <div style={{ position: 'relative' }}>
        <svg
          width={spinnerSize}
          height={spinnerSize}
          viewBox="0 0 60 60"
          style={{ animation: 'spin 1s linear infinite' }}
        >
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            style={{
              color: '#6366f1',
              opacity: 0.2
            }}
          />
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="100"
            strokeDashoffset="25"
            style={{
              color: '#6366f1'
            }}
          />
        </svg>
        
        {/* Centro */}
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: spinnerSize * 0.4,
          height: spinnerSize * 0.4,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
          animation: 'pulse 2s ease-in-out infinite'
        }} />
      </div>
      
      {/* Mensaje */}
      <div style={{ textAlign: 'center' }}>
        <p style={{
          color: prefersDark ? '#e2e8f0' : '#1e293b',
          fontSize: '1rem',
          fontWeight: 500,
          margin: 0
        }}>
          {message}
        </p>
      </div>
      
      {/* Barra de progreso */}
      {showProgress && (
        <div style={{ width: compact ? '200px' : '300px' }}>
          <div style={{
            height: compact ? '6px' : '8px',
            backgroundColor: 'rgba(99, 102, 241, 0.1)',
            borderRadius: '9999px',
            overflow: 'hidden',
            position: 'relative',
            border: '1px solid rgba(99, 102, 241, 0.2)'
          }}>
            <div 
              style={{
                height: '100%',
                background: 'linear-gradient(90deg, #6366f1 0%, #818cf8 100%)',
                borderRadius: '9999px',
                width: `${currentProgress}%`,
                transition: 'width 0.3s ease'
              }}
            />
            <div 
              className="progress-bar-shimmer"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                borderRadius: '9999px'
              }}
            />
          </div>
          
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '0.5rem',
            fontSize: '0.875rem',
            color: '#64748b',
            fontWeight: 500
          }}>
            <span>Progreso</span>
            <span>{Math.round(currentProgress)}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

// Variante compacta para uso inline
export function LoadingDinoInline({ message = 'Cargando...' }: { message?: string }) {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.75rem 1rem',
      backgroundColor: prefersDark ? 'rgba(30, 41, 59, 0.9)' : 'rgba(255, 255, 255, 0.9)',
      borderRadius: '0.5rem',
      border: prefersDark ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(0, 0, 0, 0.1)'
    }}>
      <div style={{ position: 'relative', width: 20, height: 20 }}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 60 60"
          style={{ animation: 'spin 1s linear infinite' }}
        >
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            style={{
              color: '#6366f1',
              opacity: 0.2
            }}
          />
          <circle
            cx="30"
            cy="30"
            r="26"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray="100"
            strokeDashoffset="25"
            style={{
              color: '#6366f1'
            }}
          />
        </svg>
      </div>
      <span style={{ 
        color: prefersDark ? '#94a3b8' : '#64748b', 
        fontSize: '0.875rem', 
        fontWeight: 500
      }}>
        {message}
      </span>
    </div>
  )
}
