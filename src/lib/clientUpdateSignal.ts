// Process-local latch: survives responses before the React shell mounts.
// No persistence, session changes, or automatic reloads.
let required = false
const listeners = new Set<() => void>()

export const clientUpdateSignal = {
  getSnapshot: () => required,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  requireUpdate() {
    if (required) return
    required = true
    listeners.forEach(listener => listener())
  },
}
