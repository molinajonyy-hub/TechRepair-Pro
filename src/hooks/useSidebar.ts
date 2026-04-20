import { useCallback, useEffect, useState } from 'react';

const SIDEBAR_COLLAPSED_KEY = 'techrepair_sidebar_collapsed';

type SidebarState = {
  isCollapsed: boolean;
  isMobileOpen: boolean;
};

const listeners = new Set<() => void>();

const readInitialCollapsed = () => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const saved = window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    return saved ? JSON.parse(saved) === true : false;
  } catch {
    return false;
  }
};

let sidebarState: SidebarState = {
  isCollapsed: readInitialCollapsed(),
  isMobileOpen: false,
};

const emitSidebarChange = () => {
  listeners.forEach((listener) => listener());
};

const setSidebarState = (nextState: Partial<SidebarState>) => {
  sidebarState = {
    ...sidebarState,
    ...nextState,
  };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(sidebarState.isCollapsed));
    } catch {
      // Persisting the sidebar preference is optional.
    }
  }

  emitSidebarChange();
};

export function useSidebar() {
  const [state, setState] = useState(sidebarState);

  useEffect(() => {
    const listener = () => setState(sidebarState);
    listeners.add(listener);
    listener();

    return () => {
      listeners.delete(listener);
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarState({ isCollapsed: !sidebarState.isCollapsed });
  }, []);

  const toggleMobileSidebar = useCallback(() => {
    setSidebarState({ isMobileOpen: !sidebarState.isMobileOpen });
  }, []);

  const closeMobileSidebar = useCallback(() => {
    setSidebarState({ isMobileOpen: false });
  }, []);

  return {
    ...state,
    toggleSidebar,
    toggleMobileSidebar,
    closeMobileSidebar,
  };
}
