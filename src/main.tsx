import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { CajaProvider } from './contexts/CajaContext'
import { ThemeProvider } from './contexts/ThemeContext'
import './index.css'

const buildVersion = import.meta.env.VITE_APP_VERSION || __BUILD_TIME__
console.log('%cTechRepair Pro', 'color:#818cf8;font-weight:bold;font-size:14px')
console.log('Build:', buildVersion, '·', __BUILD_COMMIT__)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <CajaProvider>
            <App />
          </CajaProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
