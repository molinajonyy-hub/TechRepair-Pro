/**
 * AppleEmoji — renderiza emojis reales del ecosistema Apple
 * Usa la CDN de emoji-datasource-apple (imágenes oficiales de Apple)
 */

const APPLE_EMOJI_CDN = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@14.0.0/img/apple/64'

// Mapeo manual para garantizar los code points correctos
const EMOJI_MAP: Record<string, string> = {
  '⚡': '26a1',
  '⚡️': '26a1',
  '🔗': '1f517',
  '🚀': '1f680',
  '✅': '2705',
  '✨': '2728',
  '💡': '1f4a1',
  '📊': '1f4ca',
  '📈': '1f4c8',
  '🏢': '1f3e2',
  '🤝': '1f91d',
  '🎯': '1f3af',
  '💰': '1f4b0',
  '💵': '1f4b5',
  '📱': '1f4f1',
  '🔧': '1f527',
  '👥': '1f465',
  '📋': '1f4cb',
  '🌐': '1f310',
  '📚': '1f4da',
  '🎉': '1f389',
  '😊': '1f60a',
  '🙌': '1f64c',
  '💎': '1f48e',
  '📦': '1f4e6',
  '💬': '1f4ac',
  '📸': '1f4f8',
  '📷': '1f4f7',
  '📧': '1f4e7',
  '👋': '1f44b',
  '⚙️': '2699-fe0f',
  '☁️': '2601-fe0f',
  '⚠️': '26a0-fe0f',
  '🟢': '1f7e2',
  '🔴': '1f534',
  '🟡': '1f7e1',
  '❌': '274c',
  '❓': '2753',
  '🗂️': '1f5c2-fe0f',
  '📍': '1f4cd',
  '🏷️': '1f3f7-fe0f',
  '📐': '1f4d0',
  '🔒': '1f512',
  '🏪': '1f3ea',
  '🛒': '1f6d2',
  '🧾': '1f9fe',
  '💳': '1f4b3',
  '🧑‍💻': '1f9d1-200d-1f4bb',
  '🙏': '1f64f',
  '🔑': '1f511',
  '📌': '1f4cc',
  '⭐': '2b50',
  '🌟': '1f31f',
  '💪': '1f4aa',
  '🏆': '1f3c6',
}

function getEmojiUrl(emoji: string): string {
  // Buscar en el mapa primero
  if (EMOJI_MAP[emoji]) {
    return `${APPLE_EMOJI_CDN}/${EMOJI_MAP[emoji]}.png`
  }
  // Fallback: generar code point automáticamente
  const codePoint = [...emoji]
    .map(c => {
      const cp = c.codePointAt(0)
      return cp !== undefined ? cp.toString(16).padStart(4, '0') : null
    })
    .filter(Boolean)
    .join('-')
  return `${APPLE_EMOJI_CDN}/${codePoint}.png`
}

interface AppleEmojiProps {
  emoji: string
  size?: number
  style?: React.CSSProperties
  className?: string
}

export function AppleEmoji({ emoji, size = 18, style, className }: AppleEmojiProps) {
  return (
    <img
      src={getEmojiUrl(emoji)}
      alt={emoji}
      width={size}
      height={size}
      draggable={false}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        pointerEvents: 'none',
        flexShrink: 0,
        ...style,
      }}
      className={className}
      onError={(e) => {
        // Fallback al emoji de texto si la imagen falla
        const parent = e.currentTarget.parentElement
        if (parent) {
          const span = document.createElement('span')
          span.textContent = emoji
          parent.replaceChild(span, e.currentTarget)
        }
      }}
    />
  )
}

export default AppleEmoji
