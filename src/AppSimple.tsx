// Test simple - versión mínima para diagnosticar
import { Routes, Route } from 'react-router-dom'

function TestPage() {
  return (
    <div style={{ padding: '2rem', color: '#f8fafc', backgroundColor: '#0a0e1a', minHeight: '100vh' }}>
      <h1>TechRepair Pro - TEST</h1>
      <p>Si ves esto, React está funcionando correctamente.</p>
      <a href="/dashboard" style={{ color: '#6366f1' }}>Ir a Dashboard</a>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<TestPage />} />
      <Route path="/dashboard" element={<TestPage />} />
      <Route path="/test" element={<TestPage />} />
    </Routes>
  )
}

export default App
