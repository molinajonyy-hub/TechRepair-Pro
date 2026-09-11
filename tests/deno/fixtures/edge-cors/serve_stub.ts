// Stands in for std/http `serve`: captures the handler, never opens a socket.
type Handler = (req: Request) => Response | Promise<Response>

export function serve(handler: Handler): Promise<void> {
  ;(globalThis as { __edgeHandler?: Handler }).__edgeHandler = handler
  return Promise.resolve()
}
