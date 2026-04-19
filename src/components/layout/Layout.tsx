import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useSidebar } from '../../hooks/useSidebar';
import { useNavigate } from 'react-router-dom';

interface LayoutProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

export function Layout({ children, title, description }: LayoutProps) {
  const { isCollapsed, toggleMobileSidebar } = useSidebar();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#0a0a0f] text-slate-900 dark:text-white overflow-hidden transition-colors duration-300">
      {/* Background Effects - Only visible in dark mode */}
      <div className="fixed inset-0 pointer-events-none dark:block hidden">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-violet-600/10 rounded-full blur-[120px] animate-pulse delay-1000" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-900/5 rounded-full blur-[150px]" />
      </div>

      {/* Grid Pattern Overlay - Dark mode only */}
      <div 
        className="fixed inset-0 pointer-events-none opacity-0 dark:opacity-[0.02] transition-opacity duration-300"
        style={{
          backgroundImage: `linear-gradient(rgba(99, 102, 241, 0.3) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(99, 102, 241, 0.3) 1px, transparent 1px)`,
          backgroundSize: '50px 50px'
        }}
      />

      <Sidebar />
      
      {/* Main Content Area */}
      <main className={`
        transition-all duration-300 ease-in-out
        ${isCollapsed ? 'lg:ml-[80px]' : 'lg:ml-[260px]'}
        ml-0 min-h-screen
      `}>
        {/* Top Bar */}
        <header className="sticky top-0 z-30 h-16 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800/50">
          <div className="h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between">
            {/* Mobile menu button */}
            <div className="lg:hidden">
              <button
                onClick={toggleMobileSidebar}
                className="p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                aria-label="Abrir menú"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>

            {/* Logo/Brand — visible on mobile only */}
            <div className="lg:hidden flex items-center gap-2 cursor-pointer" onClick={() => navigate('/dashboard')}>
              <div style={{
                width: '28px', height: '28px',
                borderRadius: '7px',
                background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg viewBox="0 0 100 100" width="18" height="18" fill="none">
                  <path d="M18 46 L25 14 L38 36 Q50 30 62 36 L75 14 L82 46 Q86 60 82 70 Q70 88 50 88 Q30 88 18 70 Q14 60 18 46 Z" fill="white" opacity="0.93"/>
                  <ellipse cx="37" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.85"/>
                  <ellipse cx="63" cy="58" rx="5.5" ry="5" fill="#6366f1" opacity="0.85"/>
                </svg>
              </div>
              <span style={{ fontSize: '0.9rem', fontWeight: 800, color: '#f8fafc', letterSpacing: '-0.02em' }}>
                TechRepair<span style={{ color: '#818cf8' }}>Pro</span>
              </span>
            </div>

            {/* Page Title — desktop */}
            <div className="hidden lg:block flex-1">
              {title && (
                <h1 className="text-lg font-semibold text-slate-900 dark:text-white">
                  {title}
                </h1>
              )}
              {description && (
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                  {description}
                </p>
              )}
            </div>

            {/* Right side actions */}
            <div className="flex items-center gap-3">
              {/* Theme Toggle */}
              <div className="hidden sm:block">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <div className="relative">
          {/* Content with backdrop blur effect for inactive tabs */}
          <div className="relative z-10">
            {children}
          </div>
          
          {/* Backdrop overlay for inactive state */}
          <div className="fixed inset-0 bg-black/20 backdrop-blur-sm pointer-events-none opacity-0 transition-opacity duration-300" />
        </div>
      </main>
    </div>
  );
}
