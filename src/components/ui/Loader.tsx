interface LoaderProps {
  size?: 'sm' | 'md' | 'lg'
  text?: string
}

export function Loader({ size = 'md', text }: LoaderProps) {
  const sizeMap = {
    sm: '24px',
    md: '40px',
    lg: '64px'
  }

  const borderWidth = {
    sm: '2px',
    md: '3px',
    lg: '4px'
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <div
        style={{
          width: sizeMap[size],
          height: sizeMap[size],
          border: `${borderWidth[size]} solid #374151`,
          borderTop: `${borderWidth[size]} solid #6366f1`,
          borderRadius: '50%',
          animation: 'spin 1s linear infinite',
          margin: '0 auto'
        }}
      />
      {text && (
        <p style={{ marginTop: '1rem', color: '#a0aec0', fontSize: '0.875rem' }}>
          {text}
        </p>
      )}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
