import { useState } from 'react';

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
  icon?: React.ReactNode;
  badge?: number;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  className?: string;
}

export function Tabs({ tabs, defaultTab, className = '' }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id || '');

  return (
    <div className={`w-full ${className}`}>
      {/* Tab Navigation */}
      <div className="flex items-center gap-1 p-1 bg-[#1e293b] rounded-lg border border-white/5">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                relative flex items-center gap-2 px-4 py-2 rounded-md font-medium
                transition-all duration-200 ease-out
                ${isActive
                  ? 'bg-indigo-600 text-white' 
                  : 'text-slate-400 hover:text-white hover:bg-white/5'
                }
              `}
            >
              {tab.icon}
              <span>{tab.label}</span>
              {tab.badge && (
                <span className={`
                  px-2 py-0.5 text-xs font-medium rounded-full
                  ${isActive 
                    ? 'bg-indigo-700 text-white' 
                    : 'bg-[#334155] text-slate-400'
                  }
                `}>
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="relative mt-6">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          
          return (
            <div
              key={tab.id}
              className={`
                transition-all duration-300 ease-out
                ${isActive 
                  ? 'opacity-100 translate-y-0' 
                  : 'opacity-0 absolute inset-0 translate-y-4 pointer-events-none'
                }
              `}
            >
              {tab.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface TabPanelProps {
  children: React.ReactNode;
  className?: string;
}

export function TabPanel({ children, className = '' }: TabPanelProps) {
  return (
    <div className={`p-6 bg-[#111827] rounded-xl border border-white/5 ${className}`}>
      {children}
    </div>
  );
}
