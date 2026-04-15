import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  isDark: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_KEY = 'techrepair_theme';
const LEGACY_THEME_KEY = 'theme';

const isTheme = (value: string | null): value is Theme => (
  value === 'light' || value === 'dark' || value === 'system'
);

const getSystemTheme = (): ResolvedTheme => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark';
  }

  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

const getInitialTheme = (): Theme => {
  // Siempre usar modo dark
  return 'dark';
};

const resolveTheme = (theme: Theme): ResolvedTheme => (
  theme === 'system' ? getSystemTheme() : theme
);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(getInitialTheme()));

  const setTheme = useCallback((nextTheme: Theme) => {
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => (resolveTheme(currentTheme) === 'dark' ? 'light' : 'dark'));
  }, []);

  useEffect(() => {
    const applyTheme = () => {
      const nextResolvedTheme = resolveTheme(theme);
      const root = document.documentElement;

      setResolvedTheme(nextResolvedTheme);
      root.setAttribute('data-theme', nextResolvedTheme);
      root.classList.remove('light', 'dark');
      root.classList.add(nextResolvedTheme);
      root.style.colorScheme = nextResolvedTheme;

      try {
        window.localStorage.setItem(THEME_KEY, theme);
        window.localStorage.setItem(LEGACY_THEME_KEY, theme);
      } catch {
        // Theme still works for the current session if persistence is blocked.
      }
    };

    applyTheme();

    if (theme !== 'system') {
      return;
    }

    if (typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    mediaQuery.addEventListener('change', applyTheme);

    return () => {
      mediaQuery.removeEventListener('change', applyTheme);
    };
  }, [theme]);

  const value = useMemo<ThemeContextType>(() => ({
    theme,
    resolvedTheme,
    isDark: resolvedTheme === 'dark',
    setTheme,
    toggleTheme,
  }), [theme, resolvedTheme, setTheme, toggleTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
}
