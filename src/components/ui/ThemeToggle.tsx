import { Monitor, Moon, Sun } from 'lucide-react';
import { Theme, useTheme } from '../../hooks/useTheme';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options: { value: Theme; label: string; icon: typeof Sun }[] = [
    { value: 'light', label: 'Claro', icon: Sun },
    { value: 'dark', label: 'Oscuro', icon: Moon },
    { value: 'system', label: 'Sistema', icon: Monitor },
  ];

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0',
        padding: '0',
        borderRadius: '9999px',
      }}
    >
      {options.map(({ value, label, icon: Icon }) => {
        const isActive = theme === value;

        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            title={label}
            aria-pressed={isActive}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '14px',
              height: '14px',
              borderRadius: '9999px',
              border: 'none',
              backgroundColor: isActive ? 'var(--accent-primary)' : 'transparent',
              color: isActive ? '#ffffff' : 'var(--text-muted)',
              cursor: 'pointer',
              padding: '0',
            }}
          >
            <Icon size={8} />
          </button>
        );
      })}
    </div>
  );
}
