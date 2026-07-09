import { Monitor, Moon, Sun } from 'lucide-react';
import { Theme, useTheme } from '../../hooks/useTheme';

interface ThemeToggleProps {
  /**
   * - `segmented`: selector Claro / Oscuro / Sistema con etiquetas (Configuración).
   * - `icon`: botón compacto que alterna light↔dark (headers / barras).
   */
  variant?: 'segmented' | 'icon';
}

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light',  label: 'Claro',   icon: Sun },
  { value: 'dark',   label: 'Oscuro',  icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
];

export function ThemeToggle({ variant = 'segmented' }: ThemeToggleProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();

  if (variant === 'icon') {
    const isDark = resolvedTheme === 'dark';
    const Icon = isDark ? Sun : Moon;
    return (
      <button
        type="button"
        data-testid="theme-toggle-icon"
        onClick={() => setTheme(isDark ? 'light' : 'dark')}
        aria-label={isDark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'}
        title={isDark ? 'Tema claro' : 'Tema oscuro'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: '0.5rem',
          background: 'var(--nav-hover-bg)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          transition: 'color 0.15s ease, border-color 0.15s ease, background 0.15s ease',
          flexShrink: 0,
        }}
      >
        <Icon size={15} />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Tema de la interfaz"
      data-testid="theme-toggle"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
        padding: '0.25rem',
        borderRadius: '0.625rem',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border-color)',
      }}
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const isActive = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setTheme(value)}
            data-testid={`theme-option-${value}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.875rem',
              minHeight: 36,
              borderRadius: '0.45rem',
              border: '1px solid',
              borderColor: isActive ? 'var(--nav-active-border)' : 'transparent',
              background: isActive ? 'var(--nav-active-bg)' : 'transparent',
              color: isActive ? 'var(--nav-active-text)' : 'var(--text-tertiary)',
              fontSize: '0.8125rem',
              fontWeight: isActive ? 700 : 500,
              cursor: 'pointer',
              transition: 'color 0.15s ease, background 0.15s ease, border-color 0.15s ease',
            }}
          >
            <Icon size={14} aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
