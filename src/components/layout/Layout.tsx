import { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { ThemeToggle } from '../ui/ThemeToggle';
import { useSidebar } from '../../hooks/useSidebar';

interface LayoutProps {
  children: ReactNode;
  title?: string;
  description?: string;
}

export function Layout({ children, title, description }: LayoutProps) {
  const { isCollapsed } = useSidebar();

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
        ${isCollapsed ? 'lg:ml-16' : 'lg:ml-64'}
        ml-0
      `}>
        {/* Top Bar */}
        <header className="sticky top-0 z-30 h-16 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800/50">
          <div className="h-full px-4 sm:px-6 lg:px-8 flex items-center justify-between">
            {/* Mobile menu button */}
            <div className="lg:hidden">
              <button
                onClick={() => {/* TODO: Add mobile menu toggle */}}
                className="p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            </div>

            {/* Page Title */}
            <div className="flex-1 text-center lg:text-left">
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
              {/* User Menu */}
              <div className="flex items-center gap-3">
                <button className="relative p-2 rounded-lg text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538.214 1.095.595 1.405L9 17m6 0v3a3 3 0 11-6 0v-3m6 0h-6" />
                  </svg>
                  <span className="absolute top-1 right-1 w-2 h-2 bg-emerald-500 rounded-full border-2 border-white dark:border-slate-900"></span>
                </button>
              </div>

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
