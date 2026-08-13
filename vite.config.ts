import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read the shared root .env (not just VITE_-prefixed keys) so the tunnel
  // host is configured in one place rather than duplicated here.
  const env = loadEnv(mode, process.cwd(), '')

  const publicUrl = env.APP_URL?.trim()
  let tunnelHost: string | null = null
  if (publicUrl) {
    try {
      const host = new URL(publicUrl).hostname
      // A localhost APP_URL is the normal local setup and needs none of the
      // tunnel handling below -- applying it would break local HMR.
      if (host !== 'localhost' && host !== '127.0.0.1') tunnelHost = host
    } catch {
      // Malformed APP_URL: fall through to the plain local config.
    }
  }

  return {
    plugins: [react()],
    server: {
      // Vite rejects requests whose Host header it doesn't recognise, as
      // DNS-rebinding protection. A tunnel always presents an unfamiliar
      // host, so without this every request returns "Blocked request. This
      // host is not allowed." Only the one configured host is added -- not
      // `true`, which would disable the protection entirely.
      ...(tunnelHost ? { allowedHosts: [tunnelHost] } : {}),

      // HMR's websocket otherwise tries to reach the tunnel host on the dev
      // port over ws://, which fails behind TLS termination. Tunnels serve
      // https on 443, so the client has to be told to use wss there.
      ...(tunnelHost
        ? { hmr: { protocol: 'wss', host: tunnelHost, clientPort: 443 } }
        : {}),

      proxy: {
        // Everything the browser calls is same-origin; this forwards the API
        // half to Express server-side. It is also why a single tunnel is
        // enough -- no second tunnel, and no CORS in play.
        '/api': {
          target: 'http://localhost:4000',
          changeOrigin: true,
        },
      },
    },
  }
})
